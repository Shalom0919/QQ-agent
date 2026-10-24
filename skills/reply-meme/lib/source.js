import fs from 'node:fs';
import path from 'node:path';
import { readBytes, trustedUrl } from './network.js';

export const INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const MAX_AGE = 24 * 3600000;
const ROLES = [
  ['DeepSeek娘', 'deepseek', 'deepseek娘', 'ds娘', '鲸鱼娘', '蓝色大肥鱼', '大肥鱼', '深度求索'],
  ['Claude娘', 'claude', 'claude娘'], ['GPT娘', 'gpt', 'gpt娘', 'chatgpt'],
  ['豆大妈', '豆包', '豆包娘', '豆大妈', 'doubao'], ['Kimi娘', 'kimi', 'kimi娘'],
  ['通义千问娘', '通义千问', '通义', '千问', 'qwen'], ['智谱清言娘', '智谱清言', '智谱', 'glm'],
  ['Gemini娘', 'gemini', 'gemini娘'], ['Grok娘', 'grok', 'grok娘'], ['AI娘化', 'ai娘化']
];
const MOODS = {
  难过: ['难过', '不开心', '伤心', '委屈', '哭哭', '哭泣', '落泪', '呜呜'],
  开心: ['开心', '快乐', '高兴', '好耶', '欢呼', '庆祝'],
  感谢: ['感谢', '谢谢', '多谢', '感激', '谢啦'],
  赞同: ['赞同', '收到', '明白', '好的', '好哒', '没问题', '同意', '了解'],
  鼓励: ['鼓励', '加油', '你可以', '你能行', '坚持', '打气'],
  安慰: ['安慰', '抱抱', '别难过', '摸摸头', '不哭'],
  疑惑: ['疑惑', '困惑', '疑问', '问号', '不懂', '歪头', '奇怪'],
  无语: ['无语', '沉默', '扶额', '无奈', '呆滞'],
  震惊: ['震惊', '惊讶', '吃惊', '震撼', '目瞪口呆'],
  生气: ['生气', '气愤', '气鼓鼓', '愤怒', '恼火'],
  道歉: ['道歉', '对不起', '抱歉', '认错', '我错了'],
  晚安: ['晚安', '睡觉', '睡了', '好梦', '困了'],
  早安: ['早安', '早上好', '起床'],
  摸鱼: ['摸鱼', '偷懒', '摆烂', '躺平', '划水'],
  喜欢: ['喜欢', '爱你', '比心', '贴贴', '心动'],
  尴尬: ['尴尬', '汗颜', '社死', '捂脸'],
  得意: ['得意', '骄傲', '自豪', '叉腰'],
  大笑: ['大笑', '哈哈', '笑死', '笑出声', '爆笑']
};
const clean = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const clip = (s, n) => typeof s === 'string' ? s.slice(0, n) : '';

export function parseIndex(raw) {
  if (!raw?.gallery || Array.isArray(raw.gallery) || typeof raw.gallery !== 'object') throw new Error('图库索引格式已变更');
  const result = [], seen = new Set();
  for (const [category, group] of Object.entries(raw.gallery)) {
    if (!Array.isArray(group?.images)) throw new Error('图库分类缺少 images');
    for (const value of group.images) {
      if (!value || typeof value.original !== 'string') continue;
      try {
        const original = trustedUrl(value.original);
        if (!/\/meme\/\d+\.(webp|png|jpg|jpeg|gif)$/i.test(new URL(original).pathname) || seen.has(original)) continue;
        seen.add(original);
        let preview = '';
        try { if (typeof value.preview === 'string') preview = trustedUrl(value.preview); } catch { /* optional */ }
        const title = clip(value.name || value.alt, 300);
        const alt = clip(value.alt, 300);
        const story = clip(typeof value.story === 'string' ? value.story : value.story?.zh, 1600);
        const id = /\/(\d+)\.[a-z]+$/i.exec(new URL(original).pathname)?.[1];
        result.push({ original, preview, title, alt, story, category: clip(category, 80), page: `https://aigengtu.com/meme/${id}` });
      } catch { /* invalid entries are not fetch targets */ }
      if (result.length >= 20000) return result;
    }
  }
  return result;
}

export function createSource(httpFetch, directory) {
  const file = path.join(directory, 'gallery-cache.json');
  let cache = null, pending = null;
  try {
    if (fs.statSync(file).size <= 6 * 1024 * 1024) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isFinite(saved.at) && saved.at <= Date.now() && Date.now() - saved.at < MAX_AGE) {
        cache = { at: saved.at, items: parseIndex(saved.raw) };
      }
    }
  } catch { /* fetch a fresh index */ }
  return {
    async load(cacheMinutes = 15) {
      if (cache && Date.now() - cache.at < cacheMinutes * 60000) return { ...cache, stale: false };
      if (pending) return pending;
      pending = (async () => {
        try {
          const bytes = await readBytes(httpFetch, INDEX_URL, { maxBytes: 5 * 1024 * 1024, accept: 'application/json' });
          const raw = JSON.parse(bytes.toString('utf8'));
          const items = parseIndex(raw);
          const at = Date.now();
          cache = { at, items };
          try {
            fs.mkdirSync(directory, { recursive: true });
            const temp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(temp, JSON.stringify({ at, raw }));
            fs.renameSync(temp, file);
          } catch { /* in-memory cache is enough */ }
          return { ...cache, stale: false };
        } catch (error) {
          if (cache && Date.now() - cache.at < MAX_AGE) return { ...cache, stale: true };
          throw error;
        }
      })();
      try { return await pending; } finally { pending = null; }
    }
  };
}

function roleFrom(value) {
  const q = clean(value);
  if (!q || ['auto', '不限', '全部'].includes(q)) return null;
  const role = ROLES.find((r) => r.some((alias) => clean(alias) === q));
  if (!role) throw new Error(`不支持的角色：${String(value).slice(0, 40)}。可用 DeepSeek、Claude、GPT、豆包、Kimi、通义千问、智谱清言、Gemini、Grok、AI娘化。`);
  return role[0];
}

function knownMoodWords(value) {
  const q = clean(value);
  const match = Object.entries(MOODS).find(([mood, words]) => clean(mood) === q || words.some((w) => clean(w) === q));
  return match ? match[1] : [];
}

function moodWords(value) {
  const known = knownMoodWords(value);
  const q = clean(value);
  return known.length ? known : q ? [q] : [];
}

// Only inspect the immediate prefix, without crossing punctuation or clauses.
// Lexical phrases such as 没问题/不懂/不哭 are matched as whole phrases.
const NEGATED_PREFIX = /(?:不|没(?:有)?|未|别|莫|勿|并非|不是|不能|无法)(?:再|太|很|怎么|那么|这么|够|算|想|要|会|敢|能|可能|真的|真|特别|完全|十分|一直|已经|任何|一点|一丝|一丁点|有点|值得|\s){0,4}$/u;

function occurrences(text, word) {
  const positions = [];
  if (!word) return positions;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) positions.push(at);
  return positions;
}

function isNegated(text, at) {
  return NEGATED_PREFIX.test(text.slice(Math.max(0, at - 20), at));
}

function matches(text, word) {
  const q = clean(word);
  if (!occurrences(text, q).some((at) => !isNegated(text, at))) return false;
  // "好的，现在我是你爹了" is not an acknowledgement. Require a complete "好的" caption.
  if (q === '好的') return /(?:^|[『「“"'\s])好的(?:[』」”"'。！!]|$)/.test(text);
  return true;
}

export function rankCandidates(items, { keyword = '', emotion = '', character = '', defaultCharacter = 'auto', random = false } = {}) {
  let query = clean(keyword).slice(0, 120);
  const explicitRole = roleFrom(character);
  const inferredRoles = [];
  for (const role of ROLES) {
    const aliases = [...new Set(role.map(clean))].sort((a, b) => b.length - a.length);
    if (aliases.some((a) => query.includes(a))) {
      inferredRoles.push(role[0]);
      for (const alias of aliases) query = query.split(alias).join(' ');
    }
  }
  const hasCharacter = typeof character === 'string' && character.trim().length > 0;
  // User's explicit role > role in keyword > configured default. Explicit auto suppresses the default.
  const defaultRole = !explicitRole && !inferredRoles.length && !hasCharacter ? roleFrom(defaultCharacter) : null;
  const roles = explicitRole ? [explicitRole] : inferredRoles.length ? inferredRoles : defaultRole ? [defaultRole] : [];
  // Keep meaningful phrases intact; the model supplies short keywords, not entire messages.
  const terms = query.replace(/表情包|表情|梗图|配图|来一张|来张|一张|图片/g, ' ').split(/[\s,，、;；。！!？?]+/).filter((x) => x && x !== '的');
  const mood = moodWords(emotion);
  const intendedMood = clean(emotion) ? knownMoodWords(emotion) : terms.flatMap(knownMoodWords);
  if (!terms.length && !mood.length && !roles.length && !random) return [];
  const scored = [];
  for (const item of items) {
    if (roles.length && !roles.includes(item.category)) continue;
    const title = clean(`${item.title} ${item.alt}`), story = clean(item.story);
    // Exclude contradictory moods before scoring so another synonym or dedupe cannot resurrect them.
    if (intendedMood.some((word) => occurrences(title, clean(word)).some((at) => isNegated(title, at)))) continue;
    const caption = clean(/[『「“]([^』」”]+)[』」”]/.exec(item.title)?.[1] || '').replace(/[\s\p{P}\p{S}]/gu, '');
    let score = 0, hits = 0, titleSupport = false;
    for (const term of terms) {
      if (matches(title, term)) {
        score += 12; hits++; titleSupport = true;
        if (caption === term) score += 12;
        else if (caption.includes(term) && caption.length <= 12) score += 6;
      }
      else if (matches(story, term)) { score += 3; hits++; }
      else {
        const synonyms = moodWords(term);
        if (synonyms.some((w) => matches(title, w))) { score += 5; hits++; titleSupport = true; }
        else if (synonyms.some((w) => matches(story, w))) { score += 1; hits++; }
      }
    }
    if (terms.length && !hits) continue;
    if (mood.length) {
      if (mood.some((w) => matches(title, w))) { score += 10; titleSupport = true; }
      else if (mood.some((w) => matches(story, w))) score += 2;
      else continue;
    }
    // Narrative mentions (e.g. "收到用户的迷惑输入") do not establish a reply's intent.
    if ((terms.length || mood.length) && !titleSupport) continue;
    if (terms.length > 1 && hits === terms.length) score += 8;
    if (score && (caption.length > 35 || /[四五六九]格|拼图|合集/.test(title))) score *= 0.65;
    scored.push({ ...item, score: score || 1 });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return [];
  // Prefer the highest relevance band; don't trade meaning for novelty or resolution.
  const floor = Math.max(1, scored[0].score * 0.7);
  return scored.filter((x) => x.score >= floor);
}
