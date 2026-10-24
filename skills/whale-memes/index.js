// 梗鲸表情包（whale-memes）—— 按语气从 aigengtu.com 挑一张梗图发到当前会话
//
// ── 为什么是技能（skills/，LLM 型），不是插件（plugins/）────────────────────
//   判据：规则能不能写死。规则写死、满足条件必然执行 → 插件；
//   要理解人话、该不该做由模型判断 → 技能。
//   这里"我这句什么语气""现在该不该配一张图""哪张最贴这个气氛"没有任何规则可依据，
//   只能由模型自己判断；所以定成技能，用 registerTool 把工具交给模型决定何时调用。
//   （插件只能提供 providers/hooks，那种路径模型看不见，也就无法"按语气挑图"。）
//
// ── 数据源 ────────────────────────────────────────────────────────────────
//   https://aigengtu.com/gallery-index.json —— 纯静态 JSON，免 Key、免鉴权。
//   形状：{ gallery: { "<角色>": { name, images: [ { name, preview, original, story.zh } ] } } }
//   图片直链在 img.aigengtu.com，实测有 webp / png / jpg / jpeg / gif 五种。
//   实测踩过的坑：**图不存在时它返回 HTTP 404 + text/html（27KB 的 HTML 错误页）**，
//   不是 404 图片也不是空 body。只把 URL 甩给协议端的话用户看到的是裂图，
//   而我们连"失败了"都不知道 —— 所以下面统一"下载 → 认魔数 → 量尺寸 → 落盘 → 发本地文件"。
//
// ── 照 src/plugin-loader.js 的规矩 ────────────────────────────────────────
//   · 工具必须在 setup(api) 执行期间注册；写到别的函数里等于静默失效；
//   · promptSections 必须模块顶层 export（api 上没有注册提示词的方法）；
//   · 缓存与状态一律落在 DATA_DIR/whale-memes/ 下，绝不能用 process.cwd() 当锚点。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { getSkillConfig } from '../../src/skills/config.js';

const SKILL_ID = 'whale-memes';
const SITE = 'https://aigengtu.com';
const INDEX_URL = `${SITE}/gallery-index.json`;
const SITE_NAME = '梗鲸';

/** 与 skill.json 的 settings 保持一致（这里留一份是为了加载顺序与容错）。 */
const DEFAULTS = {
  enabled: true,
  proactive: true,
  character: 'auto',
  maxCount: 1,
  maxPerHour: 6,
  maxPerDay: 30,
  dedupe: true,
  preferOriginal: true,
  minShortSide: 200,
  refreshHours: 12
};

const DIR = path.join(DATA_DIR, SKILL_ID);
const CATALOG_FILE = path.join(DIR, 'catalog.json');
const STATE_FILE = path.join(DIR, 'state.json');
const TMP_DIR = path.join(DIR, 'tmp');

/** 带真实 UA：这个图床对非浏览器 UA 会 403（实测）。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** 单次工具调用的下载预算：够试几张，又不至于把一轮对话拖死。 */
const MAX_DOWNLOADS = 6;
const DOWNLOAD_BUDGET_MS = 22000;
const MAX_BYTES = 12 * 1024 * 1024;
const TMP_MAX_AGE_MS = 48 * 3600 * 1000;

let log = () => {};
let warn = () => {};
let httpFetch = null;

// ─────────────────────────────────────────────── 配置
function cfg() {
  try {
    return { ...DEFAULTS, ...(getSkillConfig(SKILL_ID, DEFAULTS) || {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function isOn() {
  if (cfg().enabled === false) return false;
  return true;
}

// ─────────────────────────────────────────────── 小工具
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function clean(s, max = 200) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    warn(`写盘失败（${path.basename(file)}）：${e?.message ?? e}`);
    return false;
  }
}

function abortAfter(ms) {
  return (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
    ? AbortSignal.timeout(ms)
    : undefined;
}

/** 只放行公网 http(s) 直链（与项目里其它联网模块的 SSRF 口径一致）。 */
function isPublicHttpUrl(u) {
  if (!/^https?:\/\//i.test(String(u || ''))) return false;
  let host = '';
  try { host = new URL(u).hostname.toLowerCase(); } catch { return false; }
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127|10|0)\./.test(host)) return false;
  if (/^192\.168\./.test(host)) return false;
  if (/^169\.254\./.test(host)) return false;
  const m = host.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return false;
  if (host.includes(':')) return false;
  return true;
}

/**
 * 从字节流里嗅出真实格式与分辨率，认不出返回 null。
 * 只认魔数、不信任 Content-Type —— 这个图床出错时回的就是 200/404 + text/html。
 */
function sniffSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { format: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { format: 'gif', w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { format: 'bmp', w: Math.abs(buf.readInt32LE(18)), h: Math.abs(buf.readInt32LE(22)) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) return sniffJpeg(buf);
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return sniffWebp(buf);
  }
  return null;
}

function sniffJpeg(buf) {
  let p = 2;
  while (p + 9 < buf.length) {
    if (buf[p] !== 0xff) { p += 1; continue; }
    const marker = buf[p + 1];
    if (marker === 0xff) { p += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { format: 'jpeg', h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return null;
}

function sniffWebp(buf) {
  const fourcc = buf.toString('latin1', 12, 16);
  try {
    if (fourcc === 'VP8X') {
      return {
        format: 'webp',
        w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
        h: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16))
      };
    }
    if (fourcc === 'VP8 ') {
      for (let i = 20; i < Math.min(buf.length - 9, 40); i++) {
        if (buf[i] === 0x9d && buf[i + 1] === 0x01 && buf[i + 2] === 0x2a) {
          return {
            format: 'webp',
            w: buf.readUInt16LE(i + 3) & 0x3fff,
            h: buf.readUInt16LE(i + 5) & 0x3fff
          };
        }
      }
    }
    if (fourcc === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { format: 'webp', w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
  } catch { /* 结构异常就当认不出 */ }
  return null;
}

function extOfFormat(format) {
  return ({ jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', bmp: 'bmp' })[format] || 'img';
}

function stemOf(url) {
  try {
    const base = String(url).split('?')[0].split('/').pop() || '';
    return clean(base.replace(/\.[a-z0-9]+$/i, ''), 40);
  } catch {
    return '';
  }
}

/** 从「DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包」里取出『』里的梗。 */
function captionOf(name) {
  const m = String(name || '').match(/[『「【]([^』」】]{1,60})[』」】]/);
  return m ? clean(m[1], 60) : '';
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─────────────────────────────────────────────── 图库索引
/** 内存缓存：{ at, generatedAt, categories:[{name,count}], items:[...] } */
let catalog = null;
let catalogPromise = null;

function ttlMs() {
  const h = num(cfg().refreshHours, DEFAULTS.refreshHours);
  return h > 0 ? h * 3600 * 1000 : Infinity;
}

function normalizeCatalog(json) {
  const gallery = (json && typeof json === 'object' && json.gallery) || {};
  const items = [];
  const categories = [];
  for (const [key, node] of Object.entries(gallery)) {
    const images = Array.isArray(node?.images) ? node.images : [];
    if (!images.length) continue;
    const character = clean(node?.name || key, 24);
    categories.push({ name: character, count: images.length });
    for (const im of images) {
      const original = String(im?.original || '').trim();
      if (!isPublicHttpUrl(original)) continue;
      const id = stemOf(original);
      if (!id) continue;
      const name = clean(im?.name || '', 80);
      items.push({
        id,
        name,
        caption: captionOf(name),
        character,
        url: original,
        preview: isPublicHttpUrl(im?.preview) ? String(im.preview).trim() : '',
        story: clean(im?.story?.zh || '', 220)
      });
    }
  }
  return {
    at: Date.now(),
    site: SITE,
    generatedAt: clean(json?.generated_at || '', 40),
    categories,
    items
  };
}

async function fetchCatalog() {
  if (typeof httpFetch !== 'function') throw new Error('没有网络权限（web_fetch）');
  const resp = await httpFetch(INDEX_URL, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'application/json,*/*' },
    signal: abortAfter(15000)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  const next = normalizeCatalog(json);
  if (!next.items.length) throw new Error('索引里没有可用条目');
  return next;
}

/**
 * 取图库索引：内存 → 网络 → 磁盘缓存，逐级降级。
 * 网络失败时**不报错**，只要有磁盘缓存就照常工作（离线也能发图）。
 */
async function loadCatalog({ force = false } = {}) {
  if (!force && catalog && catalog.items.length && (Date.now() - catalog.at) < ttlMs()) return catalog;
  if (catalogPromise) return catalogPromise;
  catalogPromise = (async () => {
    try {
      const fresh = await fetchCatalog();
      catalog = fresh;
      writeJson(CATALOG_FILE, fresh);
      log(`图库索引已刷新：${fresh.items.length} 张 / ${fresh.categories.length} 个角色`);
      return catalog;
    } catch (e) {
      const disk = readJson(CATALOG_FILE, null);
      if (disk && Array.isArray(disk.items) && disk.items.length) {
        catalog = disk;
        warn(`图库索引刷新失败（${e?.message ?? e}），改用本地缓存（${disk.items.length} 张）`);
        return catalog;
      }
      throw new Error(`图库索引拿不到，本地也没有缓存：${e?.message ?? e}`);
    }
  })().finally(() => { catalogPromise = null; });
  return catalogPromise;
}

// ─────────────────────────────────────────────── 语气 → 检索词
// 中文没法靠分词命中：「生气」和图上写的「气鼓鼓」一个词都不一样。
// 所以按**情绪分组**做一次同义扩展，让"语气词"能真的找到贴切的图。
const MOOD_GROUPS = {
  开心: ['开心', '高兴', '笑', '嘿嘿', '哈哈', '乐', '眉开眼笑', '棒', '赞'],
  得意: ['得意', '太会', '会了', '简单', '小意思', '轻松', '拿捏', '厉害', '牛'],
  委屈: ['委屈', '哭', '泪', '呜呜', '呜哇', '可怜', '难受', '惨', '悲'],
  生气: ['气', '怒', '恼', '炸', '暴躁', '不爽', '生气', '翻脸'],
  无语: ['无语', '无奈', '摊手', '算了', '服了', '麻了', '裂开', '扶额', '离谱', '吐槽'],
  疑惑: ['疑惑', '奇怪', '问号', '不懂', '懵', '迷惑', '啥啊', '不解'],
  敷衍: ['敷衍', '不关我事', '随便', '行吧', '懒得'],
  求饶: ['求饶', '放过', '饶', '救命', '救救', '别打', '对不起', '错了'],
  催促: ['催', '快点', '搞快', '速度', '赶紧', '急'],
  害羞: ['害羞', '脸红', '不好意思'],
  夸奖: ['夸', '厉害', '好看', '可爱', '谢谢', '牛啊'],
  摸鱼: ['摸鱼', '躺平', '摆烂', '累', '困', '睡', '下班', '白饭'],
  比心: ['比心', '喜欢', '爱你', '抱', '亲', '贴贴'],
  财迷: ['钱', '工资', '便宜', '穷', '氪', '充钱', '氪金'],
  吃: ['吃', '饿', '饭', '干饭', '吃了']
};

/** 把用户/模型给的语气词扩成一组成员检索词。 */
function expandTerms(keyword) {
  const kw = clean(keyword, 40).toLowerCase();
  if (!kw) return [];
  const out = new Set([kw]);
  for (const group of Object.values(MOOD_GROUPS)) {
    const hit = group.some((t) => kw.includes(t.toLowerCase()) || t.toLowerCase().includes(kw));
    if (hit) for (const t of group) out.add(t.toLowerCase());
  }
  return [...out];
}

/** 给单个条目打分（越高越贴）。 */
function scoreItem(item, terms) {
  if (!terms.length) return 0;
  const caption = (item.caption || '').toLowerCase();
  const name = (item.name || '').toLowerCase();
  const story = (item.story || '').toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    if (caption === t) score += 120;
    else if (caption && caption.includes(t)) score += 60;
    if (name.includes(t)) score += 18;
    if (story.includes(t)) score += 6;
  }
  // 有手写梗的图比"只有编号"的图更可能贴切，给一点基础分
  if (item.caption) score += 3;
  // 模糊的主题图（人物插画/换装）不太适合当表情包，压一点
  if (/插画|壁纸|头像|立绘|换装|涂鸦|九宫格/.test(item.name)) score -= 8;
  return score;
}

// ─────────────────────────────────────────────── 状态（去重 / 额度）
function stateRead() {
  const s = readJson(STATE_FILE, null);
  if (!s || typeof s !== 'object') return { sent: [] };
  return { sent: Array.isArray(s.sent) ? s.sent : [] };
}

function stateWrite(s) {
  const trimmed = { sent: (s.sent || []).slice(-500) };
  return writeJson(STATE_FILE, trimmed);
}

function sentIn(s, chatKey) {
  return (s.sent || []).filter((x) => x && x.chatKey === chatKey);
}

function quotaOf(s, chatKey) {
  const conf = cfg();
  const mine = sentIn(s, chatKey);
  const today = dayKey();
  const since = Date.now() - 3600 * 1000;
  const perHour = Math.max(0, num(conf.maxPerHour, DEFAULTS.maxPerHour));
  const perDay = Math.max(0, num(conf.maxPerDay, DEFAULTS.maxPerDay));
  const usedHour = mine.filter((x) => num(x.ts, 0) >= since).length;
  const usedDay = mine.filter((x) => x.day === today).length;
  const leftHour = Math.max(0, perHour - usedHour);
  const leftDay = Math.max(0, perDay - usedDay);
  return { perHour, perDay, usedHour, usedDay, leftHour, leftDay, left: Math.min(leftHour, leftDay) };
}

function recordSent(chatKey, item) {
  const s = stateRead();
  s.sent.push({ ts: Date.now(), day: dayKey(), chatKey, id: item.id, name: clean(item.caption || item.name, 40) });
  stateWrite(s);
}

// ─────────────────────────────────────────────── 选图
/**
 * 从图库里挑候选（新→旧按贴合度排序）。
 * @returns {{items: Array, relaxed: boolean, note: string}}
 */
function pickCandidates(cat, { keyword, character, chatKey, want }) {
  const conf = cfg();
  const terms = expandTerms(keyword);

  // 角色筛选：只在图库里真的存在时才生效，否则退回全库（"配不出图"比"配置写错"严重）
  const wantChar = clean(character, 24);
  const known = new Set(cat.categories.map((c) => c.name));
  let pool = cat.items;
  let note = '';
  if (wantChar && wantChar !== 'auto' && wantChar !== '任意' && wantChar !== '全部') {
    const matched = cat.items.filter((it) => it.character === wantChar);
    if (matched.length) pool = matched;
    else note = `图库里没有「${wantChar}」这个角色，已从全部图里挑。`;
  } else if (character === undefined || character === null || character === '') {
    // 没有显式指定角色时，用设置里的默认角色
    const def = clean(conf.character, 24);
    if (def && def !== 'auto' && known.has(def)) {
      const matched = cat.items.filter((it) => it.character === def);
      if (matched.length) pool = matched;
    }
  }

  const scored = pool.map((it) => ({ it, score: scoreItem(it, terms) })).filter((x) => x.score > 0);
  let ordered;
  if (scored.length) {
    scored.sort((a, b) => b.score - a.score);
    // 只在"同样贴切"的图里随机 —— 既保住贴合度，又不会每次都同一张
    const top = scored.filter((x) => x.score >= scored[0].score * 0.75).slice(0, 60);
    ordered = shuffle(top).map((x) => x.it);
  } else {
    ordered = shuffle(pool);
    if (terms.length) note = note || `图库里没有直接贴「${clean(keyword, 20)}」的梗，从随机图里挑。`;
  }

  // 会话去重：本会话发过的先排到最后
  const relaxed = conf.dedupe !== false;
  const mine = new Set(relaxed ? sentIn(stateRead(), chatKey).map((x) => String(x.id)) : []);
  const fresh = ordered.filter((it) => !mine.has(String(it.id)));
  const items = (fresh.length ? fresh : ordered).slice(0, Math.max(1, want) * 6);
  return { items, relaxed, note, exhausted: relaxed && !fresh.length && ordered.length > 0 };
}

// ─────────────────────────────────────────────── 下载与发送
function sweepTmp() {
  try {
    if (!fs.existsSync(TMP_DIR)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(TMP_DIR)) {
      const p = path.join(TMP_DIR, name);
      try {
        if (now - fs.statSync(p).mtimeMs > TMP_MAX_AGE_MS) fs.unlinkSync(p);
      } catch { /* 单个文件失败忽略 */ }
    }
  } catch { /* 目录不可用忽略 */ }
}

/** 下载并校验一张图；失败抛错（调用方换下一张）。 */
async function downloadImage(url, timeoutMs) {
  if (typeof httpFetch !== 'function') throw new Error('没有网络权限（web_fetch）');
  const resp = await httpFetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: `${SITE}/`
    },
    signal: abortAfter(timeoutMs)
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const declared = Number(resp.headers?.get?.('content-length') || 0);
  if (declared && declared > MAX_BYTES) throw new Error(`文件过大（${Math.round(declared / 1048576)}MB）`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('空响应');
  if (buf.length > MAX_BYTES) throw new Error(`文件过大（${Math.round(buf.length / 1048576)}MB）`);

  const size = sniffSize(buf);
  if (!size) {
    // 认不出魔数：多半就是那个 HTML 错误页。宁可不发，也不要发裂图。
    const head = buf.toString('latin1', 0, 24).replace(/[\x00-\x1f]/g, ' ').trim();
    throw new Error(`不是可识别的图片（开头是 ${JSON.stringify(head)}）`);
  }
  if (!size.w || !size.h) throw new Error('尺寸异常');
  if (size.w > 20000 || size.h > 20000) throw new Error(`尺寸异常（${size.w}x${size.h}）`);
  return { buf, w: size.w, h: size.h, format: size.format, bytes: buf.length };
}

function saveTmp(buf, format) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${extOfFormat(format)}`);
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * 下载 → 校验 → 落盘 → 发出。返回实际发出的那些图。
 * 逐张试：图床直链的死活事先看不出来，只能试着来（这里回的是 HTML 错误页，
 * 更像是"图没了"而不是"链接错了"）。
 */
async function sendItems(ctx, items, { want, keyword, why }) {
  const conf = cfg();
  const preferOriginal = conf.preferOriginal !== false;
  const minShort = Math.max(0, num(conf.minShortSide, DEFAULTS.minShortSide));
  const deadline = Date.now() + DOWNLOAD_BUDGET_MS;

  const sent = [];
  const errors = [];
  let downloads = 0;

  for (const item of items) {
    if (sent.length >= want) break;
    if (downloads >= MAX_DOWNLOADS) break;
    if (Date.now() > deadline) { errors.push('超出本轮下载时限'); break; }

    const plan = [];
    if (preferOriginal && item.url) plan.push({ url: item.url, kind: '原图' });
    if (item.preview) plan.push({ url: item.preview, kind: '缩略图' });
    if (!preferOriginal && item.url) plan.push({ url: item.url, kind: '原图' });
    if (!plan.length) continue;

    let ok = null;
    for (const step of plan) {
      downloads += 1;
      const remain = deadline - Date.now();
      if (remain < 800) { errors.push('超出本轮下载时限'); break; }
      try {
        const d = await downloadImage(step.url, Math.min(8000, remain));
        const shortSide = Math.min(d.w, d.h);
        // 清晰度下限是"优先级"而不是"硬门槛"：原图不达标就再试缩略图，都不行也照发（绝不空手）
        if (step.kind === '原图' && minShort > 0 && shortSide < minShort && item.preview && downloads < MAX_DOWNLOADS) {
          errors.push(`${item.id} 原图仅 ${d.w}x${d.h}，改试缩略图`);
          continue;
        }
        ok = { ...d, via: step.kind, shortSide };
        break;
      } catch (e) {
        errors.push(`${item.id}/${step.kind}: ${String(e?.message ?? e).slice(0, 60)}`);
      }
    }
    if (!ok) continue;

    let file;
    try {
      file = saveTmp(ok.buf, ok.format);
    } catch (e) {
      errors.push(`落盘失败：${e?.message ?? e}`);
      continue;
    }

    try {
      await ctx.sender.sendImage(ctx.chatKey, { file }, { note: why || `${SITE_NAME}表情包` });
      sent.push({ item, ...ok });
      recordSent(ctx.chatKey, item);
      log(`已发送 ${item.id}（${ok.w}x${ok.h} ${ok.format} ${ok.via}，${Math.round(ok.bytes / 1024)}KB）`);
    } catch (e) {
      errors.push(`发送失败：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  return { sent, errors, downloads };
}

/** 与内置发送工具保持一致：记进会话，让控制台会话页能看到这条图。 */
function noteToSession(ctx, sent) {
  if (!sent.length) return;
  try {
    for (const s of sent) {
      ctx.session?.sent?.push({
        type: 'image',
        text: `[图片:${SITE_NAME} ${s.item.caption || s.item.id}]`,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
    }
    ctx.emit?.('session-update', ctx.session?.id);
  } catch { /* 留档失败不影响发送结果 */ }
}

// ─────────────────────────────────────────────── 工具实现
async function doSendMeme(ctx, args) {
  const conf = cfg();
  if (conf.enabled === false) {
    return { content: '错误：梗鲸表情包这个技能已经被关掉了，现在不能发图。', isError: true };
  }
  if (!ctx?.sender?.sendImage) {
    return { content: '错误：当前环境拿不到发送图片的能力，这张先不发了。', isError: true };
  }
  if (!ctx?.chatKey) {
    return { content: '错误：不知道要发到哪个会话。', isError: true };
  }

  const keyword = clean(args?.keyword ?? args?.mood ?? '', 40);
  const character = clean(args?.character ?? '', 24);
  const pick = clean(args?.pick ?? args?.id ?? '', 24).replace(/^#/, '');
  const why = clean(args?.why ?? '', 60);
  const want = clamp(args?.count ?? conf.maxCount ?? 1, 1, clamp(conf.maxCount ?? 1, 1, 3));

  // 主动配图开关：关掉后只允许"有明确诉求"的发送（群友点名 / 指定编号）
  if (conf.proactive === false && !pick && !keyword) {
    return { content: '提示：主动配图已关闭，这次没有明确要图的对象，就不发了。（群友明确要图时再调用。）', isError: true };
  }

  const quota = quotaOf(stateRead(), ctx.chatKey);
  if (quota.left <= 0) {
    const whyQ = quota.leftDay <= 0
      ? `这个会话今天已经发了 ${quota.perDay} 张`
      : `这个会话这个小时已经发了 ${quota.perHour} 张`;
    return { content: `错误：${whyQ}，先不发了（等一会儿再说）。这一轮不要重试。`, isError: true };
  }

  let cat;
  try {
    cat = await loadCatalog();
  } catch (e) {
    return { content: `错误：图库现在拿不到（${e?.message ?? e}）。请只回一句“表情包图库这会儿连不上”，不要编造图片。`, isError: true };
  }

  sweepTmp();

  let candidates;
  let note = '';
  if (pick) {
    const hit = cat.items.find((it) => it.id === pick);
    if (!hit) {
      return {
        content: `错误：图库里没有编号 ${pick} 这张图。可以先用 whale-memes__list_memes 列一下候选再挑。`,
        isError: true
      };
    }
    candidates = [hit];
  } else {
    const picked = pickCandidates(cat, { keyword, character, chatKey: ctx.chatKey, want });
    candidates = picked.items;
    note = picked.note || '';
    if (picked.exhausted) note = `${note}（本会话已经把图库里的可选项发完了，这一张是重复使用）`.trim();
  }

  if (!candidates.length) {
    return {
      content: `错误：图库里没找到可发的图${character ? `（角色：${character}）` : ''}。换个关键词或角色再试一次；不要编造图片。`,
      isError: true
    };
  }

  const { sent, errors } = await sendItems(ctx, candidates, { want: Math.min(want, quota.left), keyword, why });

  if (!sent.length) {
    const detail = errors.slice(0, 3).join('；') || '所有候选图都下载/发送失败';
    return {
      content: `错误：这次一张都没发出去（${detail}）。请只回一句“表情包这会儿发不出去，稍后再试”，不要编造。`,
      isError: true
    };
  }

  noteToSession(ctx, sent);

  const head = sent.map((s) => {
    const cap = s.item.caption ? `『${s.item.caption}』` : '';
    return `#${s.item.id} ${s.item.character}${cap}（${s.w}x${s.h} ${s.format}，${s.via}）`;
  });
  const after = quotaOf(stateRead(), ctx.chatKey);
  const lines = [
    `已发出 ${sent.length} 张「${SITE_NAME}」表情包：`,
    ...head.map((h) => `  - ${h}`)
  ];
  if (note) lines.push(`（${note}）`);
  lines.push(`本会话今天还剩 ${after.leftDay} 张额度。`);
  lines.push('接下来：不要在回复里描述或复述图里画的是什么；如果你的话配上这个梗更顺，可以顺着梗说一句，别硬解释。');
  return { content: lines.join('\n') };
}

async function doListMemes(ctx, args) {
  const conf = cfg();
  if (conf.enabled === false) {
    return { content: '错误：梗鲸表情包这个技能已经被关掉了。', isError: true };
  }
  const keyword = clean(args?.keyword ?? '', 40);
  const character = clean(args?.character ?? '', 24);
  const limit = clamp(args?.limit ?? 8, 1, 15);

  let cat;
  try {
    cat = await loadCatalog();
  } catch (e) {
    return { content: `错误：图库现在拿不到（${e?.message ?? e}）。请只回一句“表情包图库这会儿连不上”。`, isError: true };
  }

  const lines = [
    `「${SITE_NAME}」图库共 ${cat.items.length} 张（索引更新于 ${cat.generatedAt || '未知'}）。`,
    '可用角色：' + cat.categories.map((c) => `${c.name}(${c.count}张)`).join('、')
  ];

  const terms = expandTerms(keyword);
  if (!keyword && !character) {
    const sample = shuffle(cat.items.filter((i) => i.caption)).slice(0, limit);
    lines.push('', `随机几张贴合度高的样例（要看某个方向的，把 keyword 填上再调一次）：`);
    for (const it of sample) lines.push(`  - 编号=${it.id}｜${it.character}｜${it.caption || it.name}`);
    lines.push('', '想发哪张，就把它的编号填进 whale-memes__send_meme 的 pick 参数。');
    return { content: lines.join('\n') };
  }

  const picked = pickCandidates(cat, { keyword, character, chatKey: ctx?.chatKey || '', want: limit });
  const items = picked.items.slice(0, limit);
  if (!items.length) {
    lines.push('', `没有找到贴「${keyword || character}」的图。换个词再试，或用上面的角色列表换一个方向。`);
    return { content: lines.join('\n') };
  }

  lines.push('', `贴「${keyword || character}」的候选：`);
  for (const it of items) lines.push(`  - 编号=${it.id}｜${it.character}｜${it.caption || it.name}`);
  if (picked.note) lines.push(`（${picked.note}）`);
  lines.push('', '把选中的编号填进 whale-memes__send_meme 的 pick 参数即可发出（一次只发一张）。');
  return { content: lines.join('\n') };
}

// ─────────────────────────────────────────────── 提示词（动态部分）
export function promptSections() {
  try {
    if (!isOn()) return [];
    const conf = cfg();
    const known = catalog && catalog.items.length
      ? catalog.categories.map((c) => `${c.name}(${c.count}张)`).join('、')
      : 'DeepSeek娘、AI娘化、Claude娘、GPT娘';
    const lines = [`【${SITE_NAME}图库】可用角色：${known}。`];
    lines.push(conf.proactive === false
      ? '主动配图已关闭 —— 只有群友明确要图时才发。'
      : '你可以在自己的话有明显情绪时主动配一张；也可以等群友点名要。');
    lines.push(`默认每次最多 ${clamp(conf.maxCount ?? 1, 1, 3)} 张，同一会话不重发同一张。`);
    return [{
      id: `${SKILL_ID}-library`,
      title: `${SITE_NAME}表情包图库`,
      priority: 45,
      content: lines.join('\n')
    }];
  } catch (e) {
    warn(`生成图库提示失败：${e?.message ?? e}`);
    return [];
  }
}

// ─────────────────────────────────────────────── 入口
export function setup(api) {
  log = api?.log || (() => {});
  warn = api?.warn || (() => {});
  httpFetch = typeof api?.fetch === 'function' ? api.fetch : null;

  const conf = cfg();
  log(
    `梗鲸表情包已加载：默认角色 ${conf.character}，每会话 ${num(conf.maxPerHour, DEFAULTS.maxPerHour)} 张/小时、`
    + `${num(conf.maxPerDay, DEFAULTS.maxPerDay)} 张/天；缓存放在 data/${SKILL_ID}/`
  );
  if (!httpFetch) {
    warn('没有声明 web_fetch 权限，拿不到网络能力 —— 发图会失败。请检查 skill.json 的 permissions。');
  }

  // 工具必须在这里注册（loader 只认 setup 执行期间注册的工具）
  api.registerTool({
    id: 'send_meme',
    name: '发梗鲸表情包',
    description:
      '从「梗鲸」表情包图库挑一张最贴当下气氛的梗图，直接发到当前会话（一步到位，不用再调别的发送工具）。'
      + '什么时候用：① 你自己这句话有明显情绪、配一张正好替你把话说完（keyword 填语气词，如“委屈”“无语”“得意”“气鼓鼓”）；'
      + '② 群友直接要图（“来张表情包”“发个表情”“点一张”），keyword 从对方原话里提炼。'
      + '想让群友先挑，就先用 whale-memes__list_memes 列候选，对方点了哪张再把那张的编号填进 pick。'
      + 'character 可选 DeepSeek娘 / AI娘化 / Claude娘 / GPT娘。不是每条消息都要配图 —— 没合适的就别调。',
    category: 'sticker',
    icon: '🐋',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '语气词或对方点名的事物，例如“委屈”“无语”“得意”“催更”“摸鱼”。越贴当下语气越准。'
        },
        character: {
          type: 'string',
          description: '可选，限定角色：DeepSeek娘 / AI娘化 / Claude娘 / GPT娘。不填就按语气自己挑。'
        },
        pick: {
          type: 'string',
          description: '可选，指定要发的编号（用户点图用）。编号来自 whale-memes__list_memes 返回的「编号=xxx」。'
        },
        count: {
          type: 'number',
          description: '可选，发几张，1~3，默认按设置（通常 1）。'
        },
        why: {
          type: 'string',
          description: '可选，一句话说明为什么这张贴切（只用于记录，不发给群友）。'
        }
      },
      required: []
    },
    async execute(ctx, args) {
      return doSendMeme(ctx, args);
    }
  });

  api.registerTool({
    id: 'list_memes',
    name: '翻梗鲸图库',
    description:
      '只列出候选、不发送：返回贴「keyword」的若干张梗图（编号 + 角色 + 梗名），也可以不带参数先看整个图库有哪些角色、各多少张。'
      + '用途：群友想先看看再挑一张的时候，用这个列出候选，对方点了哪张，再把那张的编号交给 whale-memes__send_meme 的 pick 参数发出去。',
    category: 'sticker',
    icon: '🐋',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选，想找的语气词或事物；不填就返回图库概览 + 随机样例。' },
        character: { type: 'string', description: '可选，限定角色：DeepSeek娘 / AI娘化 / Claude娘 / GPT娘。' },
        limit: { type: 'integer', description: '可选，最多列几条，1~15，默认 8。' }
      },
      required: []
    },
    async execute(ctx, args) {
      return doListMemes(ctx, args);
    }
  });

  // 预热图库索引（不 await —— 不能因为它拖慢启动；失败静默，工具调用时会再试）
  try {
    Promise.resolve(loadCatalog()).catch(() => {});
  } catch { /* 忽略 */ }
}

/** 自检：只要拿得到网络能力就能工作，不依赖任何 Key 或第三方额度。 */
export function available() {
  return typeof globalThis.fetch === 'function';
}

/** 卸载/关闭时清掉内存缓存（加载器支持 dispose）。 */
export function dispose() {
  catalog = null;
  catalogPromise = null;
}
