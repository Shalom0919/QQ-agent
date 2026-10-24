/**
 * hot-trend-tracker —— 热梗事件收集（确定性型插件 / API v1）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────────
 * 机器人平时是"被动"的：群里没人提，它就不知道外面发生了什么。想让它跟上
 * 最近的梗和热点，原生只有一条路 —— 每次聊到都现场 web_search + web_fetch，
 * 又慢又费 token，而且当前配置下 webSearch.provider 指向 keyless 的渠道时
 * 直接报错（见 README 的"本机实测"一节）。
 *
 * 本插件把那件事挪到**后台预先做好**：每天固定时间抓一次榜单，压成小卡片存
 * 本地，机器人要用的时候查一下就行。
 *
 * ── 为什么是插件，不是技能 ────────────────────────────────────────────────
 * 判据（src/skills/manifest.js 的 DIR_KIND + plugin-loader 的 lintKindPlacement）：
 *   plugins/ 确定性型 —— 提供能力/钩子，条件满足**必然执行**，不经过 LLM。
 *   skills/  LLM 型   —— 注册工具，用不用由模型自己判断。
 *
 * "每天到点抓一次、抓完落盘、过期删掉" 这件事**不需要任何判断**，也不该让
 * 模型来决定要不要更新知识库（它要是忘了，知识库就馊了）。所以定时抓取这一半
 * 必须是插件，在这里由定时器无条件执行 —— 而且**完全不消耗 token**。
 * 另一半"要不要用、怎么用"由同名技能 hot-trends 负责，那是模型该判断的事。
 *
 * ── 分工边界（和 hot-trends 技能）────────────────────────────────────────
 *   本插件：抓取 / 去重 / 保鲜期 / 落盘 / 统计 / 需要时递一小把热点
 *   hot-trends：注册工具 + 提示词片段，让模型自己决定查不查、怎么用
 *   两者通过能力名 knowledge.hot-trends 连接（软依赖，谁都不硬绑谁）
 *
 * ── 数据来源（本机逐个实测过，都是 keyless 公开接口）────────────────────
 *   贴吧热议   含人工简介，理解"这梗是什么"最好用 → 权重最高
 *   B 站热门   网梗发源地，带 UP 主与视频简介
 *   百度热搜   覆盖面最广，但只有标题
 *   （微博/知乎/tophub/抖音/游戏榜 实测不通或需鉴权，已排除；
 *     B 站 ranking/v2 接口实测返回空，改用实测可用的 popular 接口。）
 *
 * ── 踩坑备忘 ─────────────────────────────────────────────────────────────
 *   · 百度榜单的**真实列表在 data.cards[0].content[0].content**，不是
 *     data.cards[0].content —— 差一层就会解析出 0 条且不报错（典型静默失效）。
 *   · 百度 tab 名写错时接口返回 {"success":false,...} 但仍带 HTTP 200：
 *     必须检查 success 字段，不能只看状态码。
 *   · 简介里带换行/多余空白，落盘前必须压平，否则会破坏小抄的排版与字数估算。
 *   · 配置每次执行现读（cfg()），不在 setup 时快照 —— 用户在界面上改了设置
 *     要立刻生效，而不是等下次重启。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const BUILD_TAG = 'v1.0.0';
const STORE_FILE = path.join(DATA_DIR, 'hot-trends.json');
const STORE_VERSION = 1;
const SOURCE_ORDER = ['tieba', 'bilibili', 'baidu'];

// 每个来源的权重：贴吧带简介 → 最有用；B 站次之；百度只有标题。
const SOURCE_WEIGHT = { tieba: 1.25, bilibili: 1.0, baidu: 0.95 };
const SOURCE_LABEL = { baidu: '百度热搜', tieba: '贴吧热议', bilibili: 'B站热门' };
const SOURCE_PAGE = {
  baidu: 'https://top.baidu.com/board?tab=realtime',
  tieba: 'https://tieba.baidu.com/hottopic/browse/topicList',
  bilibili: 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1'
};

/**
 * 每个来源必须带自己的 Referer。
 * ⚠️ 这里踩过一个坑：为了治百度的风控，曾经给所有请求统一加百度的 Referer，
 * 结果 B 站接口直接返回 403（实测：带百度 referer = 403，带 bilibili.com = 200）。
 * Referer 必须按来源给，不能全局设一个。
 */
const SOURCE_REFERER = {
  baidu: 'https://top.baidu.com/board?tab=realtime',
  tieba: 'https://tieba.baidu.com/',
  bilibili: 'https://www.bilibili.com/'
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DEFAULTS = {
  enabled: true,
  collectHour: 6,
  catchUpOnStart: true,
  checkIntervalMin: 15,
  sourceBaidu: false,
  sourceTieba: true,
  sourceBilibili: true,
  perSourceLimit: 20,
  keepDays: 7,
  maxTopics: 300,
  minDescriptionChars: 8,
  injectBrief: true,
  triggerWords: '热搜,热梗,什么梗,最近火,最近流行,最近的梗,网上都在说,新鲜事,新梗,吃瓜,出什么事了,发生什么了,out了',
  maxInjectChars: 480,
  hookCount: 5,
  briefDescChars: 40,
  notifyChatKey: '',
  maxSourceFailures: 5
};

// ───────────────────────────── 运行态（内存，重启即清） ─────────────────────────────

const state = {
  timer: null,
  running: false,        // 抓取进行中，防重入
  startedAt: Date.now(),
  lastRunAt: 0,
  lastRunOk: null,       // null=还没跑过
  lastError: '',
  lastReport: '',        // 最近一次抓取的逐源结果，供 hot_status 显示
  runCount: 0
};

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// ───────────────────────────── 小工具 ─────────────────────────────

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function bool(v, dflt) {
  if (v === undefined || v === null || v === '') return dflt;
  return v !== false;
}

function str(v, dflt = '') {
  const s = String(v ?? '').trim();
  return s || dflt;
}

/** 配置读取：每次现读，缺项用出厂默认补齐。 */
function settings() {
  const s = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (k) => (s[k] === undefined || s[k] === null || s[k] === '' ? DEFAULTS[k] : s[k]);
  return {
    enabled: bool(s.enabled, DEFAULTS.enabled),
    collectHour: Math.max(0, Math.min(23, Math.round(num(pick('collectHour'), DEFAULTS.collectHour)))),
    catchUpOnStart: bool(s.catchUpOnStart, DEFAULTS.catchUpOnStart),
    checkIntervalMin: Math.max(1, Math.min(240, Math.round(num(pick('checkIntervalMin'), DEFAULTS.checkIntervalMin)))),
    sourceBaidu: bool(s.sourceBaidu, DEFAULTS.sourceBaidu),
    sourceTieba: bool(s.sourceTieba, DEFAULTS.sourceTieba),
    sourceBilibili: bool(s.sourceBilibili, DEFAULTS.sourceBilibili),
    perSourceLimit: Math.max(5, Math.min(50, Math.round(num(pick('perSourceLimit'), DEFAULTS.perSourceLimit)))),
    keepDays: Math.max(1, Math.min(60, Math.round(num(pick('keepDays'), DEFAULTS.keepDays)))),
    maxTopics: Math.max(20, Math.min(2000, Math.round(num(pick('maxTopics'), DEFAULTS.maxTopics)))),
    minDescriptionChars: Math.max(0, Math.min(100, Math.round(num(pick('minDescriptionChars'), DEFAULTS.minDescriptionChars)))),
    injectBrief: bool(s.injectBrief, DEFAULTS.injectBrief),
    triggerWords: Array.isArray(s.triggerWords) ? s.triggerWords.join(',') : str(s.triggerWords, DEFAULTS.triggerWords),
    maxInjectChars: Math.max(100, Math.min(3000, Math.round(num(pick('maxInjectChars'), DEFAULTS.maxInjectChars)))),
    hookCount: Math.max(1, Math.min(12, Math.round(num(pick('hookCount'), DEFAULTS.hookCount)))),
    briefDescChars: Math.max(0, Math.min(200, Math.round(num(pick('briefDescChars'), DEFAULTS.briefDescChars)))),
    notifyChatKey: str(s.notifyChatKey),
    maxSourceFailures: Math.max(1, Math.min(50, Math.round(num(pick('maxSourceFailures'), DEFAULTS.maxSourceFailures))))
  };
}

/** 压平空白：标题/简介里混换行会破坏小抄排版与字数估算。 */
function flatten(s, max = 400) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/** 去重键：标题归一化（去掉标点/空白/大小写差异）。 */
function dedupeKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、；：""''《》（）()【】\[\]…—\-~·!?,.;:"']/g, '')
    .slice(0, 40);
}

// ───────────────────────────── 北京时间 ─────────────────────────────
// 后端统一按 UTC+8 判定"今天"，与用户所在时区无关：这是给中国用户的 QQ 机器人，
// 用服务器本地时区算会导致"到点了却不抓"（机器时区不是 +8 时）。

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

function bjParts(ts = Date.now()) {
  const d = new Date(ts + BJ_OFFSET_MS);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    dayKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
  };
}

function bjClock(ts) {
  const p = bjParts(ts);
  return `${p.dayKey} ${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

// ───────────────────────────── 存储 ─────────────────────────────

const emptyStore = () => ({
  version: STORE_VERSION,
  updatedAt: 0,
  lastCollectedAt: 0,
  lastCollectedDay: '',
  collectedDays: [],          // 已成功抓取过的北京日期（用于"今天抓过没"判断）
  sources: { baidu: { ok: 0, fail: 0, streak: 0, lastError: '', lastOkAt: 0, lastCount: 0 } },
  topics: [],
  stats: { served: 0, injected: 0, collectRuns: 0, lastRunMs: 0 }
});

function loadStore() {
  let raw = '';
  try {
    raw = fs.readFileSync(STORE_FILE, 'utf8');
  } catch {
    return emptyStore();          // 首次运行：文件还不存在，正常
  }
  try {
    const s = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const parsed = JSON.parse(s);
    if (!parsed || typeof parsed !== 'object') throw new Error('不是对象');
    const base = emptyStore();
    return {
      ...base,
      ...parsed,
      sources: { ...base.sources, ...(parsed.sources || {}) },
      stats: { ...base.stats, ...(parsed.stats || {}) },
      topics: Array.isArray(parsed.topics) ? parsed.topics.filter((t) => t && t.title) : [],
      collectedDays: Array.isArray(parsed.collectedDays) ? parsed.collectedDays.slice(-40) : []
    };
  } catch (error) {
    // 损坏时不能让整个插件挂掉：备份坏文件，从空库继续（下次抓取自然重建）
    const bad = `${STORE_FILE}.bad-${Date.now()}`;
    try { fs.renameSync(STORE_FILE, bad); } catch { /* 备份失败也要继续 */ }
    warn(`知识库文件损坏，已备份为 ${path.basename(bad)} 并重建：${error?.message ?? error}`);
    return emptyStore();
  }
}

function saveStore(store) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 1), 'utf8');
    fs.renameSync(tmp, STORE_FILE);      // 原子替换：半截文件不会被读到
    return true;
  } catch (error) {
    warn(`写入知识库失败：${error?.message ?? error}`);
    return false;
  }
}

// ───────────────────────────── 三个来源 ─────────────────────────────

/**
 * 带超时的 GET + JSON 解析。
 *
 * ⚠️ 超时定时器**故意不 unref**。这里踩过一个真实的坑：
 *   为了"别让定时器拖住进程退出"，曾经把超时和重试都用 unref —— 结果更糟：
 *   抓取进行中时事件循环里除了这个定时器没有任何"被引用"的任务，
 *   进程会**在请求还没回来的时候直接退出**（实测：脚本 0.59 秒就结束，
 *   顶层 await 永远不 settle；在真实项目里就是"用户正好在这几秒关掉 QQ Agent，
 *   这次抓取被静默截断"）。
 *   正确的界线是：表示"正在干活"的定时器保持引用（它最多个 12 秒，不会长期挂住
 *   进程）；只有表示"空闲等待下一轮"的定时器才 unref（调度器的 setInterval）。
 */
async function getJson(url, timeoutMs = 12000, referer = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        ...(referer ? { referer } : {})
      },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      // 走到这儿最常见的原因是拿到了风控验证页（HTML）。
      // 直接说清楚是"被风控"而不是"接口坏了"，否则排查时只会以为改版了。
      const isHtml = /^\s*<(!doctype|html)/i.test(text);
      throw new Error(isHtml
        ? `被风控返回了验证页（不是 JSON，${text.length} 字节）——稍后重试通常就好`
        : `返回的不是 JSON（前 60 字：${flatten(text, 60)}）`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 百度实时热搜。
 * ⚠️ 列表在 data.cards[0].content[0].content —— 少一层就静默拿到 0 条。
 * ⚠️ 榜单名写错时返回 success:false 但状态码仍是 200，必须显式检查。
 */
export function parseBaidu(json, limit = 20) {
  if (json?.success === false) {
    throw new Error(`接口返回失败：${json?.error?.message || '未知原因'}`);
  }
  const card = json?.data?.cards?.[0];
  const level1 = card?.content;
  const list = Array.isArray(level1?.[0]?.content) ? level1[0].content
    : (Array.isArray(level1) ? level1 : []);
  const out = [];
  for (const item of list) {
    const title = flatten(decodeEntities(item?.word), 120);
    if (!title) continue;
    out.push({ title, desc: '', url: String(item?.url || ''), rawRank: num(item?.index, out.length + 1) });
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error('榜单结构里没有解析到条目（接口可能已改版）');
  return out;
}

/** 贴吧热议：唯一带人工简介的来源，价值最高。 */
export function parseTieba(json, limit = 20) {
  const list = json?.data?.bang_topic?.topic_list;
  if (!Array.isArray(list)) throw new Error('榜单结构里没有解析到条目（接口可能已改版）');
  const out = [];
  for (const item of list) {
    const title = flatten(decodeEntities(item?.topic_name), 120);
    if (!title) continue;
    const desc = flatten(decodeEntities(item?.topic_desc || item?.abstract), 260);
    out.push({ title, desc, url: String(item?.topic_url || ''), rawRank: num(item?.idx_num, out.length + 1) });
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error('榜单结构里没有解析到条目（接口可能已改版）');
  return out;
}

/** B 站综合热门（ranking/v2 实测返回空，故用 popular）。 */
export function parseBilibili(json, limit = 20) {
  if (num(json?.code, 0) !== 0) throw new Error(`接口返回 code=${json?.code}：${flatten(json?.message, 60) || '未知'}`);
  const list = json?.data?.list;
  if (!Array.isArray(list)) throw new Error('榜单结构里没有解析到条目（接口可能已改版）');
  const out = [];
  for (const item of list) {
    const title = flatten(decodeEntities(item?.title), 120);
    if (!title) continue;
    const up = flatten(item?.owner?.name, 40);
    const desc = flatten(decodeEntities(item?.desc), 220);
    out.push({
      title,
      desc: desc ? `${up ? `UP主 ${up}：` : ''}${desc}` : (up ? `UP主 ${up}` : ''),
      url: String(item?.short_link_v2 || (item?.bvid ? `https://www.bilibili.com/video/${item.bvid}` : '')),
      rawRank: out.length + 1
    });
    if (out.length >= limit) break;
  }
  if (!out.length) throw new Error('榜单结构里没有解析到条目（接口可能已改版）');
  return out;
}

const FETCHERS = {
  baidu: { label: SOURCE_LABEL.baidu, url: SOURCE_PAGE.baidu, parse: parseBaidu },
  tieba: { label: SOURCE_LABEL.tieba, url: SOURCE_PAGE.tieba, parse: parseTieba },
  bilibili: { label: SOURCE_LABEL.bilibili, url: SOURCE_PAGE.bilibili, parse: parseBilibili }
};

/** 当前配置下启用的来源。 */
function activeSources(s) {
  const on = [];
  if (s.sourceTieba) on.push('tieba');
  if (s.sourceBilibili) on.push('bilibili');
  if (s.sourceBaidu) on.push('baidu');
  return on;
}

// ───────────────────────────── 抓取主体 ─────────────────────────────

/**
 * 各来源的"重试一次"策略。
 * 百度是唯一有风控抖动的来源（实测偶发返回验证页），重试一次能救回大部分情况；
 * 其余来源要么稳定、要么失败就是真失败，重试只会白等一遍超时。
 */
const RETRY_ONCE = { baidu: 1500 };

/** 抓一个来源；对易抖动的来源失败后等一会再试一次。 */
async function fetchSourceWithRetry(key, s) {
  const delay = RETRY_ONCE[key];
  const referer = SOURCE_REFERER[key] || '';
  try {
    const json = await getJson(FETCHERS[key].url, 12000, referer);
    return FETCHERS[key].parse(json, s.perSourceLimit);
  } catch (firstError) {
    if (!delay) throw firstError;
    log(`${SOURCE_LABEL[key]} 第一次失败（${flatten(firstError?.message ?? firstError, 60)}），${delay}ms 后重试一次…`);
    // ⚠️ 必须把 setTimeout 包成 Promise 再 await。直接 await setTimeout(...)
    // 拿到的是 timer 对象（不是 thenable），等于完全没等待，重试会立刻打出去 ——
    // 而那正是最容易再次触发风控的做法。
    // 这里同样不 unref：等待重试属于"正在干活"，unref 会让进程在等待中途退出。
    await new Promise((resolve) => { setTimeout(resolve, delay); });
    const json = await getJson(FETCHERS[key].url, 12000, referer);
    return FETCHERS[key].parse(json, s.perSourceLimit);
  }
}

/**
 * 抓一轮，合并进知识库并落盘。
 * @param {{reason?:string, force?:boolean}} opts
 * @returns {Promise<{ok:boolean, added:number, total:number, pruned:number, sources:object, ms:number, error?:string}>}
 */
export async function collect({ reason = 'manual', force = false } = {}) {
  if (state.running) return { ok: false, added: 0, total: 0, pruned: 0, sources: {}, ms: 0, error: '已有一次抓取正在进行' };
  const s = settings();
  if (!s.enabled && !force) return { ok: false, added: 0, total: 0, pruned: 0, sources: {}, ms: 0, error: '自动收集已被关闭' };

  state.running = true;
  try {
    return await runCollect({ reason, s });
  } finally {
    // 必须放 finally：中途抛错若不走这行，state.running 会永远停在 true，
    // 之后**每一次**抓取都被自己的重入锁挡住（表现为"到点了但再也没更新过"）。
    state.running = false;
  }
}

/** 抓取的实际逻辑（重入锁由 collect 负责）。 */
async function runCollect({ reason, s }) {
  const started = Date.now();
  const store = loadStore();
  const now = Date.now();
  const sourcesReport = {};
  const incoming = [];
  let anyOk = false;

  for (const key of SOURCE_ORDER) {
    const health = store.sources[key] || (store.sources[key] = { ok: 0, fail: 0, streak: 0, lastError: '', lastOkAt: 0, lastCount: 0 });
    if (!activeSources(s).includes(key)) continue;
    if (health.streak >= s.maxSourceFailures) {
      // 连续失败太多次：本来源已自动停用，避免每轮都白等一次超时。
      sourcesReport[key] = { label: SOURCE_LABEL[key], status: 'disabled', note: `连续失败 ${health.streak} 次，已自动停用（可在设置里关掉本来源，或等它恢复）` };
      continue;
    }
    try {
      const items = await fetchSourceWithRetry(key, s);
      for (const it of items) {
        incoming.push({
          source: key,
          title: it.title,
          desc: it.desc,
          url: it.url,
          rank: it.rawRank
        });
      }
      health.ok += 1;
      health.streak = 0;
      health.lastError = '';
      health.lastOkAt = now;
      health.lastCount = items.length;
      anyOk = true;
      sourcesReport[key] = { label: SOURCE_LABEL[key], status: 'ok', count: items.length, note: '' };
    } catch (error) {
      const msg = flatten(error?.message ?? error, 120);
      health.fail += 1;
      health.streak += 1;
      health.lastError = msg;
      sourcesReport[key] = {
        label: SOURCE_LABEL[key],
        status: 'fail',
        count: 0,
        note: health.streak >= s.maxSourceFailures ? `${msg}（已达失败上限，之后自动跳过）` : msg
      };
      warn(`${SOURCE_LABEL[key]} 抓取失败：${msg}`);
    }
  }

  // ── 合并去重 ──
  const report = mergeTopics(store, incoming, s, now);

  // ── 保鲜期与上限 ──
  const before = store.topics.length;
  store.topics = pruneTopics(store.topics, s, now);
  const pruned = before - store.topics.length;

  store.updatedAt = now;
  store.stats.collectRuns += 1;
  store.stats.lastRunMs = Date.now() - started;
  if (anyOk) {
    const day = bjParts(now).dayKey;
    store.lastCollectedAt = now;
    store.lastCollectedDay = day;
    if (!store.collectedDays.includes(day)) store.collectedDays.push(day);
    store.collectedDays = store.collectedDays.slice(-40);
  }
  saveStore(store);

  state.lastRunAt = now;
  state.lastRunOk = anyOk;
  state.runCount += 1;
  state.lastError = anyOk ? '' : Object.values(sourcesReport).map((r) => r.note).filter(Boolean).join('；');
  state.lastReport = Object.entries(sourcesReport)
    .map(([, r]) => `${r.label}：${r.status === 'ok' ? `成功 ${r.count} 条` : `失败（${r.note}）`}`)
    .join('；') || '没有启用任何来源';

  const ms = Date.now() - started;
  if (anyOk) {
    log(`✅ 抓取完成（${reason}）：新增 ${report.added} 条、更新 ${report.updated} 条、清理过期 ${pruned} 条，`
      + `知识库共 ${store.topics.length} 条，耗时 ${ms}ms｜${state.lastReport}`);
  } else {
    warn(`❌ 本轮全部来源都失败（${reason}）：${state.lastError || '未知原因'}`);
  }

  if (anyOk && s.notifyChatKey) {
    notify(s.notifyChatKey, report, store, state.lastReport);
  }

  return {
    ok: anyOk,
    added: report.added,
    updated: report.updated,
    total: store.topics.length,
    pruned,
    skipped: report.skipped,
    sources: sourcesReport,
    ms,
    error: anyOk ? undefined : (state.lastError || '所有来源都失败了')
  };
}

/**
 * 合并一批新抓到的条目。
 * 去重规则：标题归一化后相同即视为同一话题；保留"描述更长"的那条
 * （贴吧有人工简介、B站有视频简介，比只有标题的强），并合并来源标记。
 */
function mergeTopics(store, incoming, s, now) {
  const byKey = new Map();
  for (const t of store.topics) byKey.set(t.key || dedupeKey(t.title), t);

  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of incoming) {
    if (!item.title || item.title.length < 2) { skipped += 1; continue; }
    const key = dedupeKey(item.title);
    if (!key) { skipped += 1; continue; }
    const score = sourceScore(item);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, {
        key,
        title: item.title,
        desc: item.desc || '',
        url: item.url || '',
        sources: [item.source],
        ranks: { [item.source]: item.rank },
        firstSeenAt: now,
        lastSeenAt: now,
        score,
        seen: 1
      });
      added += 1;
      continue;
    }

    // 已存在：更新"最近出现时间"，按描述长度决定是否替换文案
    const keepExistingText = (existing.desc || '').length >= (item.desc || '').length
      || (item.desc || '').length < s.minDescriptionChars;
    existing.lastSeenAt = now;
    existing.seen = num(existing.seen, 1) + 1;
    existing.score = Math.max(num(existing.score, 0), score);
    existing.ranks = { ...(existing.ranks || {}), [item.source]: item.rank };
    if (!existing.sources.includes(item.source)) existing.sources.push(item.source);
    if (!keepExistingText) {
      existing.desc = item.desc;
      existing.title = item.title;
      if (item.url) existing.url = item.url;
    } else if (!existing.url && item.url) {
      existing.url = item.url;
    }
    updated += 1;
  }

  store.topics = [...byKey.values()];
  return { added, updated, skipped };
}

/** 热度打分：来源权重 × 排名衰减 + 描述加成。只用于淘汰排序。 */
function sourceScore(item) {
  const w = SOURCE_WEIGHT[item.source] ?? 1;
  const rank = Math.max(1, num(item.rank, 99));
  const rankScore = 1 / Math.log2(rank + 1);
  const descBonus = Math.min(0.35, (item.desc || '').length / 600);
  return Math.round((w * rankScore + descBonus) * 1000) / 1000;
}

/** 保鲜期 + 总量上限。 */
function pruneTopics(topics, s, now) {
  const maxAge = s.keepDays * 24 * 60 * 60 * 1000;
  const alive = topics.filter((t) => now - num(t.lastSeenAt, num(t.firstSeenAt, now)) <= maxAge);
  if (alive.length <= s.maxTopics) return alive;
  // 超上限：按"新鲜度 + 热度"排序，留最好的
  const scored = alive
    .map((t) => ({
      t,
      v: num(t.score, 0) + 1 / (1 + (now - num(t.lastSeenAt, now)) / (24 * 60 * 60 * 1000))
    }))
    .sort((a, b) => b.v - a.v)
    .slice(0, s.maxTopics)
    .map((x) => x.t);
  return scored;
}

/**
 * 发送通道缓存。
 *
 * 为什么不是 import 一个发送函数：本项目**所有**出站消息都必须走 SendQueue
 * （src/sender.js 的注释写得很硬：「插件不得绕过本方法直接调 onebot.sendSegments
 * —— 那样会跳过限频与留档」）。而 SendQueue 实例只在 orchestrator 的工具上下文里
 * 存在（ctx.sender），模块层面拿不到、也没有导出的单例。
 *
 * 所以正确做法是**顺手捡**：每次跑完一轮会话，核心会在 after-response 钩子里把
 * 同一个 ctx 交过来，里面有 sender 和 chatKey。把它按会话存下来，抓完想通知时
 * 直接用 —— 这样通知同样经过限频、去重与留档，不会变成绕过管道的野消息。
 */
const senderCache = new Map();     // chatKey -> sender

function notify(chatKey, report, store, sourceReport) {
  try {
    const key = String(chatKey);
    const entry = senderCache.get(key);
    if (!entry?.sender?.sendTextBatch) {
      warn(`想发抓取通知，但还没见过会话 ${key} 的发送通道（机器人得先在那个会话里说过话）。`
        + '已跳过通知，知识库本身不受影响。');
      return;
    }
    const text = `热梗库更新完了：新增 ${report.added} 条、共 ${store.topics.length} 条（保鲜 ${settings().keepDays} 天）。${sourceReport}`;
    Promise.resolve(entry.sender.sendTextBatch(key, [text]))
      .then((r) => log(`已通知 ${key}：发出 ${r?.sent?.length ?? 0} 条`))
      .catch((e) => warn(`发送通知失败：${e?.message ?? e}`));
  } catch (error) {
    warn(`发送通知失败：${error?.message ?? error}`);
  }
}

// ───────────────────────────── 调度 ─────────────────────────────

/** 今天这个点该抓了吗？（按北京时间判定"今天是否已抓过"） */
function shouldRunNow(s, store, now = Date.now()) {
  if (!s.enabled) return { due: false, why: '自动收集已关闭' };
  const p = bjParts(now);
  if (p.h < s.collectHour) return { due: false, why: `还没到 ${s.collectHour} 点` };
  if (store.lastCollectedDay === p.dayKey) return { due: false, why: '今天已经抓过了' };
  return { due: true, why: store.lastCollectedAt
    ? `上次成功抓取是 ${bjClock(store.lastCollectedAt)}，今天（${p.dayKey}）还没抓`
    : '知识库还是空的，先抓一次' };
}

function tick(reason = 'timer') {
  try {
    const s = settings();
    if (!s.enabled) return;
    const store = loadStore();
    const { due, why } = shouldRunNow(s, store);
    if (!due) return;
    log(`到点了（${why}），开始抓取…`);
    collect({ reason }).catch((e) => warn(`抓取出错：${e?.message ?? e}`));
  } catch (error) {
    warn(`定时检查出错：${error?.message ?? error}`);
  }
}

function startTimer() {
  stopTimer();
  const s = settings();
  const intervalMs = s.checkIntervalMin * 60 * 1000;
  state.timer = setInterval(() => tick('timer'), intervalMs);
  state.timer.unref?.();        // 不因为这个定时器拖住进程退出
  log(`定时器已启动：每 ${s.checkIntervalMin} 分钟检查一次，每天 ${s.collectHour}:00（北京时间）抓取`);
}

function stopTimer() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// ───────────────────────────── 查询 / 维护接口（导出给技能用） ─────────────────────────────

/**
 * 查知识库。全部是**免费**的本地操作，不联网。
 * @param {{query?:string, limit?:number, sinceDays?:number, includeStale?:boolean}} args
 */
export function query(args = {}) {
  const s = settings();
  const store = loadStore();
  const now = Date.now();
  const limit = Math.max(1, Math.min(50, Math.round(num(args.limit, 12))));
  const q = str(args.query).toLowerCase();
  const sinceDays = num(args.sinceDays, 0);
  const cutoff = sinceDays > 0 ? now - sinceDays * 24 * 60 * 60 * 1000 : 0;

  // 默认只给"还在保鲜期内"的：过期的等于旧闻，喂给模型只会让它说过时的话
  const fresh = store.topics.filter((t) => now - num(t.lastSeenAt, 0) <= s.keepDays * 24 * 60 * 60 * 1000);
  let list = cutoff ? fresh.filter((t) => num(t.lastSeenAt, 0) >= cutoff) : fresh;

  if (q) {
    const terms = q.split(/[\s,，、]+/).filter(Boolean);
    list = list
      .map((t) => {
        const hay = `${t.title} ${t.desc}`.toLowerCase();
        let hit = 0;
        for (const term of terms) if (hay.includes(term)) hit += 1;
        return { t, hit };
      })
      .filter((x) => x.hit > 0)
      .sort((a, b) => b.hit - a.hit || num(b.t.lastSeenAt, 0) - num(a.t.lastSeenAt, 0))
      .map((x) => x.t);
  } else {
    // 不指定关键词：给"最新 + 最热"的
    list = [...list].sort((a, b) => num(b.lastSeenAt, 0) - num(a.lastSeenAt, 0) || num(b.score, 0) - num(a.score, 0));
  }

  const picked = list.slice(0, limit);
  if (picked.length) store.stats.served += 1;

  // 简介按调用方要求截断：模型上下文里每一段都要付 token。
  // 小抄（brief）给得短，工具查询给得长 —— 因为工具查询是模型**主动**要的，
  // 说明它确实需要细节；小抄是"顺手递一眼"，长了就是白花钱。
  const descChars = Math.max(0, Math.min(400, Math.round(num(args.descChars, 200))));

  return {
    ok: true,
    query: args.query || '',
    total: store.topics.length,
    fresh: fresh.length,
    matched: list.length,
    returned: picked.length,
    lastCollectedAt: store.lastCollectedAt,
    lastCollectedText: store.lastCollectedAt ? bjClock(store.lastCollectedAt) : '从未',
    keepDays: s.keepDays,
    topics: picked.map((t) => ({
      title: t.title,
      desc: descChars > 0 ? flatten(t.desc, descChars) : '',
      descFull: num(t.desc?.length, 0),
      sources: (t.sources || []).map((x) => SOURCE_LABEL[x] || x),
      lastSeenText: bjClock(num(t.lastSeenAt, now)),
      url: t.url || ''
    }))
  };
}

/** 新鲜度优先的热点清单，用于"递小抄"。 */
export function brief({ limit = 5, maxChars = 480, descChars = null } = {}) {
  const s = settings();
  const descLimit = descChars === null || descChars === undefined ? s.briefDescChars : num(descChars, s.briefDescChars);
  const res = query({ limit: Math.max(1, Math.min(20, Math.round(num(limit, s.hookCount)))), descChars: descLimit });
  if (!res.returned) return { ok: true, text: '', count: 0, reason: res.total ? '知识库里没有还在保鲜期内的话题' : '知识库还是空的' };
  const lines = [];
  let used = 0;
  let count = 0;
  for (const t of res.topics) {
    const desc = t.desc ? `｜${t.desc}` : '';
    const line = `· ${t.title}${desc}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    count += 1;
  }
  const text = count
    ? `【最近网上的热点（本地知识库，${res.lastCollectedText} 更新，共 ${res.fresh} 条在保鲜期）】\n${lines.join('\n')}`
    : '';
  if (count) {
    const store = loadStore();
    store.stats.injected += 1;
    saveStore(store);
    return { ok: true, text, count, limited: count < res.returned };
  }
  return { ok: true, text: '', count: 0, reason: '字数上限太小，一条都放不下' };
}

/**
 * 健康与省 token 统计。这是"不静默失效"的兜底：任何来源挂了都在这儿看得见。
 */
export function status() {
  const s = settings();
  const store = loadStore();
  const now = Date.now();
  const fresh = store.topics.filter((t) => now - num(t.lastSeenAt, 0) <= s.keepDays * 24 * 60 * 60 * 1000);
  let bytes = 0;
  try { bytes = fs.statSync(STORE_FILE).size; } catch { /* 文件不存在 */ }
  const srcRows = {};
  for (const key of SOURCE_ORDER) {
    const health = store.sources[key] || {};
    srcRows[key] = {
      label: SOURCE_LABEL[key],
      enabled: activeSources(s).includes(key),
      ok: num(health.ok, 0),
      fail: num(health.fail, 0),
      streak: num(health.streak, 0),
      lastOkText: health.lastOkAt ? bjClock(health.lastOkAt) : '从未成功',
      lastCount: num(health.lastCount, 0),
      lastError: health.lastError || ''
    };
  }
  const nextCheck = s.enabled
    ? (store.lastCollectedDay === bjParts(now).dayKey
      ? `明天 ${s.collectHour}:00 之后`
      : (bjParts(now).h < s.collectHour ? `今天 ${s.collectHour}:00 之后` : '下一次检查时（已到点，还没抓）'))
    : '已关闭自动收集';
  return {
    ok: true,
    buildTag: BUILD_TAG,
    enabled: s.enabled,
    storeFile: STORE_FILE,
    bytes,
    total: store.topics.length,
    fresh: fresh.length,
    keepDays: s.keepDays,
    maxTopics: s.maxTopics,
    lastCollectedText: store.lastCollectedAt ? bjClock(store.lastCollectedAt) : '从未',
    lastCollectedDay: store.lastCollectedDay || '',
    nextRunText: nextCheck,
    lastRunOk: state.lastRunOk,
    lastError: state.lastError,
    lastReport: state.lastReport,
    timerRunning: Boolean(state.timer),
    sources: srcRows,
    stats: {
      collectRuns: num(store.stats.collectRuns, 0),
      lastRunMs: num(store.stats.lastRunMs, 0),
      served: num(store.stats.served, 0),
      injected: num(store.stats.injected, 0)
    },
    sourcePage: SOURCE_PAGE
  };
}

/** 手动清空（完全免费，不联网）。用于"用完即走"。 */
export function clear({ keepToday = false } = {}) {
  const store = loadStore();
  const before = store.topics.length;
  if (keepToday) {
    const day = bjParts().dayKey;
    // 保留今天抓到的（firstSeenAt 落在今天）
    store.topics = store.topics.filter((t) => bjParts(num(t.firstSeenAt, 0)).dayKey === day);
  } else {
    store.topics = [];
  }
  store.updatedAt = Date.now();
  saveStore(store);
  const removed = before - store.topics.length;
  log(`知识库已手动清理：删除 ${removed} 条，剩余 ${store.topics.length} 条`);
  return { ok: true, removed, left: store.topics.length };
}

// ───────────────────────────── 生命周期 / 扩展点 ─────────────────────────────

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.log === 'function') log = api.log;
  if (typeof api?.warn === 'function') warn = api.warn;
  log(`热梗事件收集已就绪（${BUILD_TAG}）｜来源：${activeSources(settings()).map((k) => SOURCE_LABEL[k]).join('、') || '无'}`);
}

export function activate() {
  const s = settings();
  stopTimer();
  startTimer();
  if (!s.enabled) {
    log('自动收集当前是关闭状态：知识库只读，可以用 hot_brief 查已有内容');
    return;
  }
  if (s.catchUpOnStart) {
    const store = loadStore();
    const { due, why } = shouldRunNow(s, store);
    if (due) {
      // 延迟 8 秒再抓：别和启动抢 IO（与 conversation-memory 的巩固任务同一约定）
      setTimeout(() => {
        log(`启动时补抓（${why}）`);
        collect({ reason: 'startup' }).catch((e) => warn(`启动补抓失败：${e?.message ?? e}`));
      }, 8000).unref?.();
    } else {
      log(`启动检查：${why}`);
    }
  }
}

export function deactivate() {
  stopTimer();
  senderCache.clear();
  log('定时器已停止（禁用/重载时会调用，不会留下幽灵定时器）');
}

/** 同步返回；能力是否真的可用不依赖网络（抓不到就只是没有新内容）。 */
export function available() {
  return true;
}

/** 软依赖接口：同名技能 hot-trends 通过 api.capability('knowledge.hot-trends') 取用。 */
export const providers = {
  'knowledge.hot-trends': (args = {}) => {
    const action = str(args.action, 'query').toLowerCase();
    if (action === 'brief') return brief(args);
    if (action === 'status') return status();
    if (action === 'collect') return collect({ reason: 'manual', force: true });
    if (action === 'clear') return clear({ keepToday: args.keepToday === true });
    return query(args);
  }
};

/**
 * 钩子：群里问起"最近什么梗/热搜"时，先把知识库里最新的一小把热点递过去。
 *
 * 这是本插件省 token 的主要机制 —— 命中一次就从"现场联网搜"变成"读本地一行"。
 * 只在**消息里出现触发词**时注入，不是每轮都塞：每轮都塞等于每轮多付一次 token，
 * 而且会把聊天变成播报。
 */
export const hooks = {
  /**
   * 顺手捡发送通道（见 senderCache 的注释）。
   * 只是缓存一个引用，不发任何消息、不改消息内容，失败也不影响会话。
   */
  async 'after-response'(ctx = {}) {
    try {
      const key = String(ctx.chatKey || '');
      if (!key || !ctx.sender?.sendTextBatch) return;
      senderCache.set(key, { sender: ctx.sender, at: Date.now() });
      // 只缓存最近的若干个会话，避免长期运行下无限增长
      if (senderCache.size > 30) {
        const oldest = [...senderCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) senderCache.delete(oldest[0]);
      }
    } catch { /* 捡不到就算了，通知功能降级 */ }
  },

  async 'before-llm-messages'(ctx = {}) {
    try {
      const s = settings();
      if (!s.injectBrief || !s.enabled) return;
      const messages = ctx.messages;
      if (!Array.isArray(messages) || !messages.length) return;

      // 取最后一条 user 消息的文本，判断有没有触发词
      let text = '';
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        text = typeof m.content === 'string'
          ? m.content
          : (Array.isArray(m.content) ? m.content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join(' ') : '');
        break;
      }
      if (!text) return;
      const words = s.triggerWords.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      if (!words.length) return;
      const hit = words.filter((w) => text.includes(w));
      if (!hit.length) return;

      const res = brief({ limit: s.hookCount, maxChars: s.maxInjectChars, descChars: s.briefDescChars });
      if (!res.text) return;

      appendToTail(messages, res.text);
      log(`命中触发词「${hit.slice(0, 2).join('、')}」，已递小抄 ${res.count} 条（本地读，未联网）`);
    } catch (error) {
      warn(`递小抄失败（不影响正常回话）：${error?.message ?? error}`);
    }
  }
};

/**
 * 把片段追加到**最后一条 user 消息末尾**。
 *
 * 为什么不插进 system 提示词中间：prompt.js 的注释写得很明确 —— 系统提示的
 * 缓存前缀通常占 token 大头，中间插入动态内容会让后面所有核心规则的字节位置
 * 偏移，缓存前缀直接归零。动态内容一律殿后。
 * （core 在 0.4 之后提供了 prompt.appendDynamicTail，但本机这份 src/prompt.js
 *   里没有它 —— 静态 import 一个不存在的具名导出不会报错，调用时才抛
 *   "is not a function"，所以这里直接自己实现，不依赖那个函数是否存在。）
 */
function appendToTail(messages, text) {
  const block = `\n\n${String(text).trim()}`;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') { m.content += block; return true; }
    if (Array.isArray(m.content)) { m.content.push({ type: 'text', text: block }); return true; }
  }
  messages.push({ role: 'user', content: block.trim() });
  return true;
}

/** 测试/排障用导出。 */
export const __internals = {
  state, settings, loadStore, saveStore, STORE_FILE,
  parseBaidu, parseTieba, parseBilibili, dedupeKey, flatten, bjParts, pruneTopics, mergeTopics
};
