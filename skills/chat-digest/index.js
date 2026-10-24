// 群聊总结卡片（LLM 型技能 / skills/chat-digest）
//
// ── 为什么是技能而不是插件 ────────────────────────────────────────────────
// 「什么时候该总结」要靠读懂人话（"总结一下"、"今天群里聊了啥"、"出个总结图"
// 是同一个意思的很多种说法），写不成 if。漏一次也不丢数据，只是这次没图。
// 所以只能注册工具交给模型判断；放进 plugins/ 会因为模型看不到工具而静默失效。
//
// ── 两个工具，两步 ────────────────────────────────────────────────────────
//   digest_read     读回最近 N 条聊天记录（给模型看的纯文本）
//   digest_compose  把模型写好的内容渲染成图片并发言
// 拆两个工具（而不是一个工具带 mode 参数）是刻意的：两个 tools 定义各自带完整
// 的「什么时候用 / 什么时候不要用 / 必须填什么」，模型填错参数的概率明显更低。
//
// ── 图片怎么来的 ──────────────────────────────────────────────────────────
// 本技能跑在 Electron 主进程里，所以能动态 import('electron') 开一个**隐藏窗口**，
// 用 Chromium 渲染 HTML（系统雅黑字体、圆角、半透明玻璃卡片全都原生支持），
// 再 capturePage() 抓成图片。不需要 canvas / sharp / ImageMagick / 外部进程。
//   · 不复用主窗口：会污染用户正在看的控制台
//   · 窗口 show:false：屏幕上不会闪任何东西
//   · 全程不动核心一行代码，卸载本技能即完全还原
//
// ── 几个必须记住的坑（都踩过）────────────────────────────────────────────
//   · ctx.store.recent(chatKey, { limit, offset }) 是**同步**的，没有 before 选项
//   · 工具返回的 image_url 部件**不会**发到群里，只给模型看 → 发图只能用 ctx.sender
//   · 工具结果文本会进会话存档，所以读记录时按字符数截断，别把 10 万字塞进去
//   · 会话存档只从机器人上线开始记，条数不够时要如实说明，不能假装总结了

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

/** 用 CJS 的 require 去拿 Electron 内置模块（见下方 getElectron 的说明）。 */
const require = createRequire(import.meta.url);

// ⚠️ electron 是 Electron 运行时的内置模块，不是资源包里的 node_modules 依赖
//    （那里面只有 js-yaml / undici / ws）。从本文件所在目录 createRequire 会被
//    解析到 Electron 主进程的注册表命中，所以拿得到。
//    故意**不在模块顶层加载**：万一解析不到（比如用纯 Node 跑加载器做测试），
//    顶层 await / 顶层抛错会让整个技能 import 失败 —— 那样连"读记录"都没了。
//    改成首次用到时再加载（available() 与渲染各调一次），拿不到就只在渲染那一步
//    报错，并在控制台说清原因。available() 本身仍是同步的（缓存结果）。
let electron = null;
let electronTried = false;
let electronError = '';

function getElectron() {
  if (electronTried) return electron;
  electronTried = true;
  try {
    const mod = require('electron');
    if (mod && typeof mod.BrowserWindow === 'function') electron = mod;
    else electronError = 'electron 模块拿到的不是主进程 API（可能在纯 Node 下运行）';
  } catch (error) {
    electronError = `拿不到 electron 模块：${error?.message ?? error}`;
  }
  return electron;
}

let cfg = () => ({});
let log = () => {};
let warn = () => {};

/** 出厂默认值（与 skill.json 的 settings 保持一致）。 */
const DEFAULTS = {
  backgroundPath: 'C:\\Users\\liuhm\\Pictures\\shouanren.jpg',
  defaultCount: 200,
  autoSend: true,
  cardTitle: '群聊总结',
  debugShowWindow: false
};

/** 读记录的实际条数上限：再多也没意义，只会把模型上下文烧掉。 */
const HARD_MAX_COUNT = 600;
const MIN_COUNT = 20;
/** 每条消息进提示词前的截断长度（超长的复制粘贴会毁掉总结质量）。 */
const PER_MESSAGE_CHARS = 140;
/** 返回给模型的记录文本总长上限，超过就在末尾提示可以调 offset 翻页。 */
const TRANSCRIPT_CHARS = 7000;
/** 渲染窗口的最大高度（CSS 像素）。太高会撞 Chromium 的画布上限，宁可截断。 */
const MAX_CSS_HEIGHT = 5200;
/** 产出图片的最大字节数（QQ 对超大文件不友好）。 */
const MAX_OUTPUT_BYTES = 3.2 * 1024 * 1024;

/* ========================================================================
 * 生命周期
 * ===================================================================== */

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  api.registerTool({
    id: 'digest_read',
    name: '读群聊记录',
    description:
      '把当前会话最近的聊天记录读回来（带时间、发言人、消息 #编号），用于写群聊总结。'
      + '当群友说「总结一下聊天记录」「来个群聊总结」「今天群里聊了啥」「出个总结图」时，'
      + '第一步就调这个工具 —— 不要凭印象编，也不要改用其它查历史消息的工具。'
      + 'count 传要总结的条数（群友说「最近100条」就传 100；没说的话不传，用设置里的默认值）。'
      + '读完必须接着调 digest_compose 把总结渲染成图片，否则群友什么都看不到。',
    category: 'query',
    icon: '📜',
    parameters: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: '要读回多少条聊天记录，20~600。群友明确说了条数就按他说的传，没说就不要传。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const settings = readSettings();
        const asked = Number(args?.count);
        const wanted = Number.isFinite(asked) && asked > 0
          ? clamp(Math.round(asked), MIN_COUNT, HARD_MAX_COUNT)
          : settings.defaultCount;

        const rows = ctx?.store?.recent
          ? ctx.store.recent(ctx.chatKey, { limit: wanted, offset: 0 })
          : [];
        if (!Array.isArray(rows) || !rows.length) {
          return fail(
            '当前会话还没有聊天记录可总结（存档只从机器人上线之后开始记）。'
            + '让群友先聊几句，或者明确说一下要总结哪一段。'
          );
        }

        const transcript = buildTranscript(rows);
        const speakers = topSpeakers(rows, 8);
        const range = formatRange(rows[0]?.ts, rows[rows.length - 1]?.ts);
        const chatName = chatLabel(ctx);

        const head = [
          `会话：${chatName}`,
          `记录范围：${range}`,
          `读回条数：${transcript.used} 条${transcript.trimmed ? `（更早的还有，需要就调本工具翻页）` : ''}`,
          `发言最多的人：${speakers.map((s) => `${s.name}(${s.count})`).join('、') || '暂无'}`,
          '',
          '===== 聊天记录开始 ====='
        ].join('\n');

        const tail = [
          '===== 聊天记录结束 =====',
          '',
          '下一步（必须做）：按上面的记录写好内容，再调 digest_compose 生成图片。',
          '写的时候注意：',
          '· summary：3~6 段，每段 2~3 句，调动词、带情绪、允许吐槽，禁止写成会议纪要；可以分段，段与段用空行隔开。',
          '· highlights：3~5 条**原话**金句（照抄记录里的原文，不要润色、不要自己编），每条带作者名和一句吐槽。',
          `· mbti：给发言最多的前 ${Math.min(3, speakers.length || 1)} 个人各判一个类型（如 ENFP），配 0~100 的置信度、一句判词和一句记录里的证据。`,
          '· commentary：你（机器人）自己的评语，2~3 句，第一人称，可以对整场聊天指指点点。',
          '· intro 可以留空，渲染时自动生成。'
        ].join('\n');

        return {
          content: `${head}\n${transcript.text}\n${tail}`
        };
      } catch (error) {
        return fail(`读聊天记录失败：${describeError(error)}`);
      }
    }
  });

  api.registerTool({
    id: 'digest_compose',
    name: '渲染群聊总结卡片',
    description:
      '把写好的群聊总结渲染成一张长图并（默认）发到当前会话。'
      + '当群友要求「总结聊天记录 / 群聊总结 / 出张总结图」时，在用 digest_read 读回记录之后调用它。'
      + '必须在同一次回复里调用：只读记录不调这个工具，群友永远看不到图。'
      + 'payload 是一个 JSON 字符串，键：summary（正文，必填）、highlights（金句数组，必填，'
      + '每项 {text, who, quip}）、mbti（MBTI 分析数组，每项 {who, type, confidence, verdict, evidence}）、'
      + 'commentary（AI 自己的评语）、intro（可选开场白）、participants（可选，每项 {name, count}，'
      + '不填会自动用读数时的真实发言统计）。'
      + '不要在 payload 里写 HTML 或 Markdown 标记，正文用纯文本，换行用 \\n。',
    category: 'media',
    icon: '🪄',
    parameters: {
      type: 'object',
      properties: {
        payload: {
          type: 'string',
          description:
            'JSON 字符串，必填键 summary（正文）与 highlights（金句数组）；'
            + '建议同时给 mbti、commentary、intro。写了什么就渲染什么，不会替你补内容。'
        },
        humor: {
          type: 'string',
          description: '调皮程度，渲染在卡片角标上。可填「微辣」「中辣」「爆辣」之类，不填默认「调皮」。'
        },
        post: {
          type: 'boolean',
          description: '是否渲染完直接发到群里。默认按设置（一般是发）。只有在群友明确说"先给我看看别发"时才传 false。'
        }
      },
      required: ['payload']
    },
    async execute(ctx, args) {
      try {
        const settings = readSettings();
        const parsed = parsePayload(args?.payload);
        if (parsed.error) return fail(parsed.error);

        const chat = ctx?.store?.recent
          ? ctx.store.recent(ctx.chatKey, { limit: settings.defaultCount, offset: 0 })
          : [];
        const speakers = topSpeakers(Array.isArray(chat) ? chat : [], 6);

        const card = normalizeCard(parsed.card, speakers, settings);
        if (card.error) return fail(card.error);

        const bg = readBackground(settings.backgroundPath);
        const px = bg.ok && bg.width
          ? { width: bg.width, height: bg.height }
          : { width: 900, height: 1600 };

        const built = buildCardHtml({
          card,
          chatName: chatLabel(ctx),
          botName: String(ctx?.botName || ctx?.selfNickname || '机器人'),
          title: settings.cardTitle,
          humor: String(args?.humor || card.humor || '调皮').slice(0, 8),
          bgUrl: bg.dataUrl,
          imageSize: px,
          rangeText: formatRange(chat[0]?.ts, chat[chat.length - 1]?.ts),
          generatedAt: new Date()
        });

        const shot = await renderQueue(() => renderHtml(built.html, {
          cssWidth: built.cssWidth,
          cssHeight: built.cssHeight,
          show: settings.debugShowWindow
        }));

        const encoded = encodeWithin(shot.image, MAX_OUTPUT_BYTES);
        const dataUrl = encoded.dataUrl;
        const outSize = encoded.size;
        const tmpFile = writeTempJpg(dataUrl);

        const notes = [];
        if (!bg.ok) notes.push(`背景图没用上（${bg.reason}），已退回深色渐变背景`);
        if (card.warnings.length) notes.push(...card.warnings);
        if (!shot.measured) notes.push('没能量出卡片高度，图可能只截到了上半部分');
        else if (shot.clipped) notes.push('内容太长，卡片底部被截断了（少写几条金句或把总结压缩一下）');

        // 发不发：群友当轮明确说了"别发"（post=false）优先，其次看设置
        const shouldPost = args?.post === false ? false : settings.autoSend !== false;

        if (shouldPost) {
          await ctx.sender.sendImage(ctx.chatKey, { dataUrl }, { note: '群聊总结' });
          noteSent(ctx, '群聊总结卡片');
          log(`已发送群聊总结卡片：${outSize.width}x${outSize.height}，${Math.round(encoded.bytes / 1024)}KB`);
          return {
            content:
              `群聊总结卡片已经渲染好并发到群里了（${outSize.width}x${outSize.height}）。`
              + `${notes.length ? `注意：${notes.join('；')}。` : ''}`
              + `卡片文件也在 ${tmpFile}，需要重发或存档可以用。`
              + '不要再把卡片上的文字复述一遍发到群里，也不要再调发送类工具；一句话告诉群友图发了即可。'
          };
        }

        log(`群聊总结卡片已渲染（未发送）：${outSize.width}x${outSize.height}`);
        return {
          content:
            '群聊总结卡片渲染好了，**按你的要求没有发到群里**（post=false）。'
            + `${notes.length ? `注意：${notes.join('；')}。` : ''}`
            + `文件：${tmpFile}（${outSize.width}x${outSize.height}）。`
            + '如果需要发出去，再调一次本工具、post 传 true 即可。'
        };
      } catch (error) {
        const detail = describeError(error);
        log(`渲染群聊总结失败：${detail}`);
        return fail(`渲染群聊总结卡片失败：${detail}`);
      }
    }
  });

  log('群聊总结卡片已加载（chat-digest v1.0.0）');
  if (!getElectron()) {
    warn(`图片渲染不可用：${electronError}。读记录仍可用，渲染那一步会报错。`);
  }
}

/**
 * 可用性自检：**必须同步**（文档 §3.1）。
 * 渲染引擎拿不到时返回 ok:false —— 技能会显示成"不可用"，用户在「技能」页一眼能看到原因，
 * 而不是等到用的时候才发现渲染不出来。
 */
export function available() {
  const mod = getElectron();
  if (!mod) return { ok: false, reason: `图片渲染引擎不可用：${electronError}` };
  return { ok: true };
}

/* ========================================================================
 * 配置与参数
 * ===================================================================== */

function readSettings() {
  const c = (typeof cfg === 'function' ? cfg() : null) || {};
  const raw = { ...DEFAULTS };
  for (const [k, v] of Object.entries(c)) {
    if (v !== undefined && v !== null && v !== '') raw[k] = v;
  }
  const count = clamp(Math.round(Number(raw.defaultCount) || DEFAULTS.defaultCount), MIN_COUNT, HARD_MAX_COUNT);
  return {
    backgroundPath: String(raw.backgroundPath || '').trim(),
    defaultCount: count,
    autoSend: raw.autoSend !== false,
    cardTitle: String(raw.cardTitle || DEFAULTS.cardTitle).slice(0, 24),
    debugShowWindow: raw.debugShowWindow === true
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function fail(message) {
  return { content: message, isError: true };
}

function describeError(error) {
  if (!error) return '未知错误';
  return String(error?.message || error);
}

/** 记一笔"这个会话已经发过卡"，避免模型下一轮又发一张一模一样的（发送队列还有一层去重）。 */
function noteSent(ctx, text) {
  try {
    ctx?.session?.sent?.push({ type: 'image', text, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
  } catch { /* 只是留档，失败无所谓 */ }
}

/* ========================================================================
 * 聊天记录 → 纯文本
 * ===================================================================== */

function chatLabel(ctx) {
  const kind = String(ctx?.kind || '');
  const id = String(ctx?.chatId || '');
  const name = String(ctx?.session?.chatName || '').trim();
  if (name) return name;
  if (kind === 'group') return `群 ${id}`;
  if (kind === 'private') return `私聊 ${id}`;
  return id || '当前会话';
}

function hhmm(ts) {
  const d = new Date(Number(ts) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRange(first, last) {
  if (!first || !last) return '未知';
  const a = new Date(Number(first));
  const b = new Date(Number(last));
  const day = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
  const sameDay = a.toDateString() === b.toDateString();
  return sameDay ? `${day(a)} ${hhmm(first)}~${hhmm(last)}` : `${day(a)} ${hhmm(first)} ~ ${day(b)} ${hhmm(last)}`;
}

/**
 * 把存档条目拼成给模型看的文本。
 * 按字符数截断（工具返回的文本会进会话存档，塞太多会拖慢每一次后续请求）。
 */
function buildTranscript(rows) {
  const lines = [];
  let used = 0;
  let chars = 0;
  let trimmed = false;

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = rows[i];
    const text = String(m?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const who = m?.self ? '（我）' : String(m?.senderName || m?.senderId || '某人');
    const body = text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}…` : text;
    const line = `[${hhmm(m?.ts)}] ${who}#${m?.id ?? '?'}: ${body}`;
    if (chars + line.length > TRANSCRIPT_CHARS) { trimmed = true; break; }
    lines.push(line);
    chars += line.length + 1;
    used += 1;
  }

  lines.reverse();
  if (trimmed) lines.unshift(`（更早的记录还有，本次只带了最近 ${used} 条）`);
  return { text: lines.join('\n'), used, trimmed };
}

/** 发言条数排行（真实统计，不让模型自己数）。self 单独标出来。 */
function topSpeakers(rows, limit) {
  const map = new Map();
  for (const m of rows || []) {
    if (!m || m.self) continue;
    const id = String(m.senderId || '');
    if (!id) continue;
    const prev = map.get(id);
    if (prev) prev.count += 1;
    else map.set(id, { userId: id, name: String(m.senderName || id), count: 1 });
  }
  return [...map.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, Number(limit) || 5));
}

/* ========================================================================
 * 模型给的 payload → 规范化卡片数据
 * ===================================================================== */

function parsePayload(raw) {
  const text = String(raw ?? '').trim();
  if (!text) {
    return { error: 'payload 是空的：请把你写好的总结放进 payload（JSON 字符串），至少要有 summary 和 highlights。' };
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 容忍模型习惯性套 ```json ``` 代码块
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { data = JSON.parse(m[0]); } catch { data = null; }
    }
  }
  if (!data || typeof data !== 'object') {
    return { error: 'payload 不是合法 JSON：请传一个 JSON 字符串，例如 {"summary":"...","highlights":[{"text":"...","who":"...","quip":"..."}]}。' };
  }
  return { card: data };
}

function normalizeCard(data, speakers, settings) {
  const warnings = [];
  const summary = String(data.summary ?? data.正文 ?? '').trim();
  if (!summary) {
    return { error: 'payload 缺少 summary（总结正文）。请把写好的总结放进 summary，再调一次本工具。' };
  }

  const highlights = toArray(data.highlights).map((h) => {
    if (typeof h === 'string') return { text: h.trim(), who: '', quip: '' };
    return {
      text: String(h?.text ?? h?.quote ?? h?.原文 ?? '').trim(),
      who: String(h?.who ?? h?.author ?? h?.作者 ?? '').trim(),
      quip: String(h?.quip ?? h?.comment ?? h?.吐槽 ?? '').trim()
    };
  }).filter((h) => h.text).slice(0, 8);
  if (!highlights.length) warnings.push('没有给金句（highlights），卡片上会少一节');

  const mbti = toArray(data.mbti).map((m) => {
    // 模型偶尔会把 mbti 写成 ["ENFP", "ISTJ"] 这种纯字符串数组，也要认
    if (typeof m === 'string') return { who: '', type: m.trim().toUpperCase().slice(0, 8), confidence: 0, verdict: '', evidence: '' };
    return {
      who: String(m?.who ?? m?.name ?? '').trim(),
      type: String(m?.type ?? m?.mbti ?? '').trim().toUpperCase().slice(0, 8),
      confidence: clamp(Number(m?.confidence ?? m?.置信度 ?? 0) || 0, 0, 100),
      verdict: String(m?.verdict ?? m?.一句话 ?? '').trim(),
      evidence: String(m?.evidence ?? m?.证据 ?? '').trim()
    };
  }).filter((m) => m.type).slice(0, 6);
  if (!mbti.length) warnings.push('没有给 MBTI 分析（mbti），卡片上会少一节');

  // 发言数一律以真实存档为准；模型只负责填名字（同名不同人靠 who 对齐）
  const given = toArray(data.participants);
  const participants = speakers.slice(0, 6).map((s) => {
    const hit = given.find((g) => String(g?.name ?? g?.who ?? '').trim() === s.name);
    return {
      name: String(hit?.name ?? hit?.who ?? s.name).trim() || s.name,
      count: Number(s.count) || 0
    };
  });
  if (!participants.length) warnings.push('这个会话还没有可统计的发言人');

  return {
    summary,
    highlights,
    mbti,
    participants,
    commentary: String(data.commentary ?? data.评语 ?? '').trim(),
    intro: String(data.intro ?? '').trim(),
    humor: String(data.humor ?? '').trim(),
    warnings: warnings.filter(Boolean)
  };
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === '') return [];
  return [value];
}

/* ========================================================================
 * 背景图
 * ===================================================================== */

function readBackground(filePath) {
  const p = String(filePath || '').trim();
  if (!p) return { ok: false, reason: '没有配置背景图路径' };
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return { ok: false, reason: '配置的路径不是文件' };
    if (stat.size > 24 * 1024 * 1024) return { ok: false, reason: '背景图超过 24MB，太大' };
    const buf = fs.readFileSync(p);
    const size = detectImageSize(buf);
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
          : 'image/jpeg';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, width: size?.width || 0, height: size?.height || 0 };
  } catch (error) {
    return { ok: false, reason: `读不到背景图（${describeError(error)}）` };
  }
}

/** 从图片字节里读宽高：支持 PNG / GIF / JPEG，读不出来返回 null（不影响渲染，只是排版用默认值）。 */
function detectImageSize(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    // PNG
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // JPEG：顺序扫段，碰到 SOF 段就有宽高
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch { /* 读不出来就用默认尺寸 */ }
  return null;
}

/* ========================================================================
 * HTML（Chromium 渲染用）
 * ===================================================================== */

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 纯文本 → 安全 HTML（转义 + 空行分段 + 换行 <br>）。 */
function textBlock(value) {
  const s = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!s) return '';
  return s.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

const ACCENTS = ['a1', 'a2', 'a3', 'a4'];
const MBTI_TONE = { E: 'E', I: 'I', N: 'N', S: 'S', F: 'F', T: 'T', J: 'J', P: 'P' };

function buildCardHtml(input) {
  const { card, chatName, botName, title, humor, bgUrl, imageSize, rangeText } = input;

  // 输出宽度：竖图按原宽放大到 ~1080（清晰但不至于巨大），横图固定 1080。
  const scale = imageSize.width >= imageSize.height ? 1080 / Math.max(1, imageSize.width) : Math.min(1.7, 1080 / Math.max(1, imageSize.width));
  const cssWidth = Math.round(clamp(imageSize.width * scale, 560, 1180));

  const dateText = `${input.generatedAt.getFullYear()}-${String(input.generatedAt.getMonth() + 1).padStart(2, '0')}-${String(input.generatedAt.getDate()).padStart(2, '0')}`;

  const highlightHtml = card.highlights.length ? `
      <section class="glass block">
        <h2 class="block__t">💬 精选金句</h2>
        ${card.highlights.map((h, i) => `
        <div class="quote">
          <div class="quote__mark">“</div>
          <div class="quote__body">
            <div class="quote__text">${esc(h.text)}</div>
            ${(h.who || h.quip) ? `<div class="quote__meta">${h.who ? `— ${esc(h.who)}` : ''}${h.quip ? `${h.who ? ' · ' : ''}${esc(h.quip)}` : ''}</div>` : ''}
          </div>
          <div class="quote__idx">${i + 1}</div>
        </div>`).join('')}
      </section>` : '';

  const summaryHtml = textBlock(card.summary);

  const mbtiHtml = card.mbti.length ? `
      <section class="glass block">
        <h2 class="block__t">🧠 发言最多的几位，MBTI 速判</h2>
        ${card.mbti.map((m, i) => {
    const tone = MBTI_TONE[String(m.type)[0]] || '';
    const pct = m.confidence > 0 ? Math.round(m.confidence) : 60;
    return `
        <div class="mbti ${ACCENTS[i % ACCENTS.length]}">
          <div class="mbti__top">
            <span class="mbti__who">${esc(m.who || '某位群友')}</span>
            <span class="mbti__type tone-${tone}">${esc(m.type)}</span>
          </div>
          ${m.verdict ? `<div class="mbti__verdict">${esc(m.verdict)}</div>` : ''}
          <div class="mbti__bar"><i style="width:${pct}%"></i><span>把握 ${pct}%</span></div>
          ${m.evidence ? `<div class="mbti__ev">证据：${esc(m.evidence)}</div>` : ''}
        </div>`;
  }).join('')}
      </section>` : '';

  const commentaryHtml = card.commentary ? `
      <section class="glass block block--comment">
        <h2 class="block__t">✍️ 我的评语</h2>
        <div class="comment">${textBlock(card.commentary)}</div>
        <div class="comment__sign">—— ${esc(botName)}</div>
      </section>` : '';

  const statHtml = card.participants.length ? `
      <section class="glass block">
        <h2 class="block__t">📊 谁在扛大梁</h2>
        <div class="stats">
          ${card.participants.map((p, i) => `
          <div class="stat">
            <span class="stat__n">${i + 1}</span>
            <span class="stat__name">${esc(p.name || '某位群友')}</span>
            <span class="stat__c">${Number(p.count) || 0} 条</span>
          </div>`).join('')}
        </div>
      </section>` : '';

  const intro = card.intro
    ? `<div class="hero__intro">${esc(card.intro)}</div>`
    : `<div class="hero__intro">${esc(chatName)}这阵子的聊天，我替你们捋了捋。</div>`;

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:#0d1526;overflow:hidden;}
body{
  width:${cssWidth}px;
  font-family:"Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif;
  color:#eef4ff;
  -webkit-font-smoothing:antialiased;
}
.bg{
  position:absolute;inset:0;z-index:0;
  background-image:${bgUrl ? `url("${bgUrl.replace(/"/g, '%22')}")` : 'linear-gradient(160deg,#12233f 0%,#1d3a63 45%,#2b2340 100%)'};
  background-size:cover;background-position:center top;background-repeat:no-repeat;
}
.veil{
  position:absolute;inset:0;z-index:1;
  background:
    linear-gradient(180deg,rgba(6,12,26,.62) 0%,rgba(8,16,32,.26) 24%,rgba(8,16,32,.20) 60%,rgba(6,10,22,.80) 100%),
    radial-gradient(120% 60% at 50% 8%,rgba(120,190,255,.16),transparent 70%);
}
.page{position:relative;z-index:2;padding:26px 22px 40px;}
.card{width:100%;}
.glass{
  background:linear-gradient(180deg,rgba(16,28,50,.62),rgba(10,18,34,.70));
  border:1px solid rgba(150,195,255,.20);
  border-radius:22px;
  backdrop-filter:blur(9px) saturate(1.15);
  box-shadow:0 18px 44px rgba(2,6,16,.45),inset 0 1px 0 rgba(210,232,255,.10);
}
.card-hero{padding:26px 24px 22px;margin-bottom:18px;text-align:left;}
.hero__kicker{
  display:inline-block;font-size:14px;letter-spacing:.24em;color:#9fd8ff;
  text-transform:uppercase;margin-bottom:12px;font-weight:700;
}
.hero__title{
  margin:0 0 10px;font-size:44px;line-height:1.14;font-weight:800;letter-spacing:.01em;
  background:linear-gradient(105deg,#ffffff 6%,#cfe6ff 44%,#8fd9ff 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  text-shadow:0 2px 22px rgba(120,200,255,.20);
}
.hero__chat{font-size:17px;color:#c9dcf5;margin-bottom:12px;word-break:break-all;}
.hero__intro{font-size:17px;line-height:1.72;color:#e6f0ff;opacity:.95;}
.hero__chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;}
.chip{
  display:inline-block;padding:6px 13px;border-radius:999px;font-size:14px;
  background:rgba(140,200,255,.14);border:1px solid rgba(160,210,255,.28);color:#d6e9ff;
}
.chip--hot{background:rgba(255,178,120,.16);border-color:rgba(255,190,140,.34);color:#ffdfc2;}
.block{padding:24px 24px 26px;margin-bottom:18px;}
.block__t{
  margin:0 0 18px;font-size:22px;font-weight:800;color:#ffffff;
  display:flex;align-items:center;gap:10px;line-height:1.3;
}
.block__t::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(160,205,255,.42),transparent);}
.block p{margin:0 0 13px;font-size:17.5px;line-height:1.86;color:#e9f2ff;}
.block p:last-child{margin-bottom:0;}
.quote{position:relative;padding:16px 18px 16px 20px;margin-bottom:14px;border-radius:16px;
  background:linear-gradient(100deg,rgba(255,214,140,.13),rgba(255,214,140,.03));
  border-left:4px solid rgba(255,205,120,.75);}
.quote:last-child{margin-bottom:0;}
.quote__mark{position:absolute;top:2px;right:14px;font-size:52px;line-height:1;color:rgba(255,214,140,.28);font-family:Georgia,serif;}
.quote__text{font-size:18.5px;line-height:1.74;color:#fff6e2;font-weight:600;padding-right:34px;}
.quote__meta{margin-top:9px;font-size:14.5px;color:#d8c49a;}
.quote__idx{position:absolute;left:-11px;top:-9px;width:26px;height:26px;border-radius:50%;
  background:#ffce7a;color:#3b2a06;font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center;
  box-shadow:0 4px 12px rgba(0,0,0,.35);}
.mbti{margin-bottom:16px;padding:18px;border-radius:18px;background:rgba(255,255,255,.045);
  border:1px solid rgba(150,195,255,.15);}
.mbti:last-child{margin-bottom:0;}
.mbti__top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;}
.mbti__who{font-size:19px;font-weight:800;color:#ffffff;word-break:break-all;}
.mbti__type{font-size:21px;font-weight:900;letter-spacing:.06em;padding:4px 14px;border-radius:12px;
  background:rgba(130,200,255,.16);border:1px solid rgba(150,210,255,.34);color:#cfeaff;}
.mbti__type.tone-E{background:rgba(255,170,130,.18);border-color:rgba(255,190,150,.38);color:#ffd8c0;}
.mbti__type.tone-I{background:rgba(150,180,255,.18);border-color:rgba(170,195,255,.38);color:#d7e0ff;}
.mbti__type.tone-N{background:rgba(190,150,255,.18);border-color:rgba(205,175,255,.38);color:#e6d8ff;}
.mbti__type.tone-S{background:rgba(140,225,205,.18);border-color:rgba(165,235,215,.38);color:#cdfaea;}
.mbti__verdict{font-size:17px;line-height:1.7;color:#e8f1ff;margin-bottom:12px;}
.mbti__bar{position:relative;height:24px;border-radius:999px;background:rgba(10,20,36,.62);overflow:hidden;}
.mbti__bar i{position:absolute;inset:0 auto 0 0;border-radius:999px;
  background:linear-gradient(90deg,rgba(120,200,255,.85),rgba(170,150,255,.85));}
.mbti__bar span{position:relative;z-index:2;display:block;text-align:right;padding-right:12px;
  font-size:13.5px;line-height:24px;color:#eaf4ff;font-weight:700;}
.mbti__ev{margin-top:11px;font-size:15px;line-height:1.7;color:#b9cdea;}
.comment{font-size:17.5px;}
.comment__sign{margin-top:14px;text-align:right;font-size:15px;color:#a9c2e0;}
.block--comment{background:linear-gradient(160deg,rgba(30,52,88,.72),rgba(16,26,48,.76));}
.stats{display:flex;flex-direction:column;gap:9px;}
.stat{display:flex;align-items:center;gap:12px;padding:11px 14px;border-radius:14px;
  background:rgba(255,255,255,.045);border:1px solid rgba(150,195,255,.13);}
.stat__n{width:24px;height:24px;border-radius:8px;background:rgba(130,200,255,.18);
  color:#cfeaff;font-size:13.5px;font-weight:800;display:flex;align-items:center;justify-content:center;}
.stat__name{flex:1;font-size:17px;color:#eef5ff;word-break:break-all;}
.stat__c{font-size:15px;color:#9fd8ff;font-weight:700;}
.footer{text-align:center;font-size:13.5px;color:#9db4d2;padding:8px 0 4px;line-height:1.9;}
</style></head>
<body>
  <div class="bg"></div><div class="veil"></div>
  <div class="page"><div class="card">
    <header class="glass card-hero">
      <div class="hero__kicker">GROUP CHAT DIGEST</div>
      <h1 class="hero__title">${esc(title)}</h1>
      <div class="hero__chat">📍 ${esc(chatName)}</div>
      ${intro}
      <div class="hero__chips">
        <span class="chip">🗓 ${esc(dateText)}</span>
        <span class="chip">🕒 ${esc(rangeText || '最近的聊天')}</span>
        <span class="chip chip--hot">🌶 ${esc(humor)}</span>
      </div>
    </header>
${highlightHtml}
    <section class="glass block">
      <h2 class="block__t">📝 这群人到底聊了啥</h2>
      ${summaryHtml}
    </section>
${mbtiHtml}
${commentaryHtml}
${statHtml}
    <div class="footer">由 ${esc(botName)} 现场总结 · ${esc(dateText)} · 仅供娱乐，MBTI 别当真</div>
  </div></div>
</body></html>`;

  return { html, cssWidth, cssHeight: MAX_CSS_HEIGHT };
}

/* ========================================================================
 * Electron 渲染
 * ===================================================================== */

/** 渲染串行化：两个会话同时要图时排队，避免主进程里同时开多个窗口。 */
let renderChain = Promise.resolve();
function renderQueue(job) {
  const next = renderChain.then(job, job);
  renderChain = next.catch(() => {});
  return next;
}

async function renderHtml(html, { cssWidth, cssHeight, show }) {
  const mod = getElectron();
  if (!mod) throw new Error(electronError || '图片渲染引擎不可用');
  const { BrowserWindow } = mod;

  // ⚠️ 关键：capturePage() 抓的是**窗口视口**，不是整页。
  //    窗口开 800 高、内容 3000 高时，抓到的只有头 800 —— 卡片会被腰斩，还会带上滚动条。
  //    所以流程必须是「先量高度 → 把窗口撑到那么高 → 再抓」。
  //    量高度需要 JS，而这段 HTML 完全由本技能生成（CSP 锁死外部资源、无用户脚本），
  //    所以开 javascript 只为跑一句 scrollHeight，风险可控（nodeIntegration 仍是关的）。
  // ⚠️ 高 DPI 机器上抓到的像素尺寸 > 窗口 CSS 尺寸（本机 1.25 倍）。
  //    创建时先用「还没被撑高」的窗口量一次这个比值，后面换算才准 —— 拿撑高后的
  //    高度去算会把比值当成 1，结果裁出多出一截的空白。
  const initialCssHeight = Math.min(1200, cssHeight);
  let deviceScale = 0;
  const win = new BrowserWindow({
    show: show === true,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0d1526',
    useContentSize: true,
    width: cssWidth,
    height: initialCssHeight,
    webPreferences: {
      javascript: true,
      images: true,
      webgl: false,
      offscreen: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  try {
    let done = false;
    let failed = null;
    const loaded = new Promise((resolve) => {
      win.webContents.once('did-finish-load', () => { done = true; resolve(); });
      win.webContents.once('did-fail-load', (_e, code, desc) => { failed = `页面加载失败（${code} ${desc}）`; resolve(); });
    });

    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await Promise.race([loaded, sleep(8000)]);
    if (failed) throw new Error(failed);
    if (!done) throw new Error('渲染页面超时（8 秒）');

    // 等字体与背景解码完（雅黑是本地字体，通常首帧就绪，这里只是保险）
    await sleep(220);

    // 先用创建时的小窗口量一次设备缩放比（抓一帧只为拿尺寸，内容无所谓）
    try {
      const probe = await win.webContents.capturePage();
      const probeSize = probe && !probe.isEmpty() ? probe.getSize() : null;
      // ⚠️ 必须用**宽度**算：实测隐藏窗口的高度会被系统钳制（请求 1200 实际只有 1067，
      //    1334÷1200=1.112 是假值），而宽度是准的（1350÷1080=1.25）。
      //    用高度算出来的比值偏小，裁剪量跟着偏小，卡片底部就被切掉一整节。
      if (probeSize && probeSize.width > 0) deviceScale = probeSize.width / cssWidth;
      log(`量缩放比：初次抓帧=${probeSize ? `${probeSize.width}x${probeSize.height}` : '空图'}，卡片宽=${cssWidth} → deviceScale=${deviceScale.toFixed(3)}`);
    } catch (error) {
      log(`量缩放比失败：${describeError(error)}`);
    }
    if (!(deviceScale > 0.2 && deviceScale < 8)) deviceScale = 1;

    // ⚠️ 量高度只能用 document.body，不能用 documentElement.scrollHeight：
    //    后者是「内容与视口的较大者」—— 内容超出窗口时它返回的是**窗口高度**（会量矮），
    //    窗口一撑高它又跟着变大（会裁多）。实测：body 恒为 2514，documentElement 在
    //    1200 窗口下报 2514、撑到 3200 就报 3200。用错了就把卡片底部整节切掉。
    //    而且量不到时必须**重试**：单次失败会退化成"只截窗口视口"，卡片照样被切。
    const measureBody = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const value = Number(await win.webContents.executeJavaScript(
            'Math.round(Math.max(document.body ? document.body.scrollHeight : 0,'
            + ' document.body ? document.body.getBoundingClientRect().height : 0))'
          ));
          if (Number.isFinite(value) && value > 0) return value;
        } catch (error) {
          if (attempt === 2) log(`量卡片高度失败：${describeError(error)}`);
        }
        await sleep(180);
      }
      return 0;
    };

    let docHeight = await measureBody();
    log(`首次量高度：${docHeight} CSS px`);
    // 撑高会让内容重新布局（滚动条消失等），可能再长一点 —— 迭代几次直到稳定
    for (let i = 0; i < 3 && docHeight > 0; i += 1) {
      const target = Math.round(clamp(docHeight + 240, 400, cssHeight));
      win.setContentSize(cssWidth, target);
      await sleep(380);
      const again = await measureBody();
      log(`第 ${i + 1} 轮：窗口撑到 ${target}，再测 = ${again}`);
      if (again <= docHeight) break;
      docHeight = again;
    }

    let image = await win.webContents.capturePage();
    for (let i = 0; i < 4 && (!image || image.isEmpty()); i += 1) {
      await sleep(420);
      image = await win.webContents.capturePage();
    }
    if (!image || image.isEmpty()) {
      throw new Error('抓取页面画面失败（拿到空图）——可以在技能设置里打开「调试：渲染时显示窗口」再试一次');
    }

    // docHeight=0 说明量高度没成功，这时只能信窗口视口，并在返回里标出来
    const measured = docHeight > 0;
    const size = image.getSize();
    const wantedCss = measured ? Math.round(clamp(docHeight, 400, cssHeight)) : 0;
    const wantedPx = measured ? Math.round(wantedCss * deviceScale) : size.height;
    // 只裁「多余的余量」：万一内容比量到的还高，也不能把真实内容裁掉
    const finalHeight = Math.max(1, Math.min(size.height, wantedPx));
    const region = { x: 0, y: 0, width: size.width, height: finalHeight };
    if (region.height < size.height) image = image.crop(region);
    log(`抓帧=${size.width}x${size.height}，量到高度=${docHeight}，裁到=${finalHeight}（deviceScale=${deviceScale.toFixed(3)}，measured=${measured}）`);

    return {
      image,
      widthPx: region.width,
      // 一律换算回 CSS 语义上报（deviceScale 是设备像素比，不该泄漏给用户看）
      heightPx: Math.round(finalHeight / deviceScale),
      measured,
      clipped: measured ? docHeight > cssHeight - 200 : true
    };
  } finally {
    try { if (!win.isDestroyed()) win.destroy(); } catch { /* 关不掉也不能影响结果 */ }
  }
}

/**
 * 压到字节上限以内：先降质量，再缩尺寸。
 * 返回 { dataUrl, bytes, size:{width,height} } —— size 是**压缩后**的真实尺寸，
 * 压缩会改尺寸，所以不能让调用方拿原始尺寸去汇报。
 */
function encodeWithin(image, maxBytes) {
  const base = image.getSize();
  const qualities = [92, 88, 82, 74, 66];
  const scales = [1, 0.88, 0.78, 0.68, 0.58];

  let fallback = null;
  for (const scale of scales) {
    const target = scale === 1
      ? image
      : image.resize({ width: Math.max(360, Math.round(base.width * scale)), quality: 'best' });
    const size = target.getSize();
    for (const quality of qualities) {
      const buf = target.toJPEG(quality);
      const encoded = { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, bytes: buf.length, size };
      if (buf.length <= maxBytes) return encoded;
      fallback = encoded;
    }
  }
  return fallback || { dataUrl: `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`, bytes: 0, size: base };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 顺手存一份文件：控制台里能看到路径，需要重发或存档时不用再渲染一次。 */
function writeTempJpg(dataUrl) {
  try {
    const b64 = String(dataUrl).split(',')[1] || '';
    const buf = Buffer.from(b64, 'base64');
    const dir = path.join(dataDir(), 'chat-digest');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `digest-${stamp}.jpg`);
    fs.writeFileSync(file, buf);
    pruneDir(dir, 40);
    return file;
  } catch (error) {
    warn(`卡片临时文件没写成（不影响发图）：${describeError(error)}`);
    return '（临时文件未保存）';
  }
}

function dataDir() {
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'QQ Agent', 'data');
}

/** 只保留最近 N 个卡片文件，别把磁盘塞满。 */
function pruneDir(dir, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => /^digest-.*\.jpg$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const item of files.slice(keep)) fs.unlinkSync(path.join(dir, item.f));
  } catch { /* 清理失败无所谓 */ }
}
