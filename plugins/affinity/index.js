/**
 * 群友好感度（affinity）—— 确定性型插件 v1.1.0
 *
 * 机制说明：
 *  - 记分：钩子 `before-context`（核心确定性触发，每条消息都会被记账，模型无法忽略）
 *  - 查询：registerTool（模型判断"有人在问好感度"时调用）
 *  - 设定：主人 QQ 号可在群里用自然语言调整（tune 工具），改动写进 data/affinity.json
 *    的 meta.overrides，优先级高于控制台设置
 *  - 数据：持久化到项目 data/affinity.json（不放在插件目录里，方便打包上架）
 *
 * 遵守的硬约束（skill-reference.md §14）：
 *  - 钩子里不发消息、不发网络请求、不重试（只做本地读档 + 计分 + 落盘）
 *  - 发消息只走 ctx.sender 的发送队列，从不绕过它直连协议端
 *  - 调 QQ 接口只用 ctx.onebot 的封装方法，并全部 try/catch
 *  - available() 同步返回，绝不返回 Promise
 *  - 配置在执行时用 cfg() 读，不在 setup 时快照
 *  - deactivate / dispose 里清掉 activate 建的定时器
 *  - 工具 id 只用 [a-zA-Z0-9_-]，required 为空时省略
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DAY = 86400000;
const SEEN_KEEP = 800; // 每个会话最多记住多少条"已处理"消息，防重复计分
const PENDING_KEEP = 5; // 每个人最多积压多少条升级播报
const PENDING_TTL = 6 * 3600 * 1000; // 超过 6 小时的升级播报就不再打扰群里
const LEVEL_TITLES = ['陌生', '眼熟', '熟人', '老友', '挚友'];
const DEFAULT_THRESHOLDS = [50, 200, 500, 1000];

const DEFAULTS = {
  perMessage: 1,
  atBotBonus: 3,
  replyBonus: 2,
  dailyCap: 20,
  decayAfterDays: 7,
  decayPerDay: 1,
  scanLimit: 200,
  topN: 10,
  announceLevelUp: true,
  allowReset: false,
  botQq: '',
  ownerQq: '',
  ownerScore: 9999,
  levelThresholds: '50,200,500,1000'
};

/** 主人可以在群里改的设定项（白名单 + 类型 + 取值范围） */
const TUNABLE = {
  perMessage: { type: 'number', min: 0, max: 20, label: '每条发言加分' },
  atBotBonus: { type: 'number', min: 0, max: 50, label: '@机器人额外加分' },
  replyBonus: { type: 'number', min: 0, max: 50, label: '接话额外加分' },
  dailyCap: { type: 'number', min: 1, max: 500, label: '每人每天加分上限' },
  decayAfterDays: { type: 'number', min: 0, max: 365, label: '多少天不发言开始衰减' },
  decayPerDay: { type: 'number', min: 0, max: 50, label: '每天衰减多少分' },
  scanLimit: { type: 'number', min: 20, max: 1000, label: '每次补扫的消息条数' },
  topN: { type: 'number', min: 1, max: 50, label: '排行榜默认人数' },
  ownerScore: { type: 'number', min: 0, max: 999999, label: '主人的好感度分数' },
  announceLevelUp: { type: 'boolean', label: '升级时播报' },
  allowReset: { type: 'boolean', label: '允许任何人重置好感度' },
  ownerQq: { type: 'qqList', label: '主人 QQ 号' },
  botQq: { type: 'qqList', label: '机器人自己的 QQ 号' },
  levelThresholds: { type: 'thresholds', label: '等级门槛' }
};

let cfg = () => ({});
let log = () => {};
let warn = () => {};

let db = null; // { version, meta:{selfId, overrides}, chats:{ [chatKey]: {members, seen, lastScanAt} } }
let dbFile = '';
let loaded = false;
let dirty = false;
let activeCtx = null; // activate() 拿到的上下文（可能带 sender）
let flushTimer = null;

// ───────────────────────────── 生命周期 ─────────────────────────────

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
  warn = typeof api?.warn === 'function' ? api.warn : () => {};

  api.registerTool({
    id: 'check',
    name: '好感度查询',
    description:
      '查询某个群友对机器人的好感度分数、等级称号（陌生/眼熟/熟人/老友/挚友）、累计发言数和群内排名。' +
      '当有人问「我好感度多少」「我和你多熟」「查一下 XXX 的好感度」「我们的关系怎么样了」时使用。' +
      'target 不填表示查发问者自己；填 QQ 号或群昵称表示查别人。' +
      '数据由系统自动累积，你无法凭空知道，必须调用本工具。',
    category: 'query',
    icon: '💗',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要查的人，可以是 QQ 号（如 10001）或群昵称（如 小明）。留空表示查发问者自己。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法查询好感度。', isError: true };

        await ensureLoaded();
        // 查询前先补扫一次，保证分数是最新的
        await accumulate({ chatKey, store: ctx?.store, triggerEntries: ctx?.session?.triggerEntries });
        syncOwners();

        const chat = db.chats[chatKey];
        const members = chat?.members || {};
        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const target = String(args?.target ?? '').trim();
        let userId = '';
        let ambiguous = 0;

        if (target) {
          // 主人可能从没在这个群发过言，但查 TA 必须能查到（恒为满级）
          const pure = target.replace(/[^\d]/g, '');
          if (pure && isOwner(pure, s) && !members[pure]) {
            return { content: ownerReport(pure, '', s, true) };
          }
          if (!Object.keys(members).length) {
            return { content: '这个会话还没有任何好感度记录（还没人发过言，或插件刚装上）。等大家聊几句再来查就有了。' };
          }
          const hit = findMember(members, target);
          if (!hit) {
            return {
              content:
                `没有找到「${target}」的好感度记录。可能 TA 最近没在这个群发过言，` +
                '或者名字/号码写错了。可以让对方先说句话，或用 rank 工具看排行榜确认有哪些人。'
            };
          }
          userId = hit.userId;
          ambiguous = hit.ambiguous || 0;
        } else {
          if (!Object.keys(members).length) {
            return { content: '这个会话还没有任何好感度记录（还没人发过言，或插件刚装上）。等大家聊几句再来查就有了。' };
          }
          const req = await resolveRequester(ctx, chatKey, selfId, s);
          if (!req.userId) {
            return {
              content: '没能确认是谁在问好感度。请让对方在提问时带上自己的 QQ 号或昵称，或者改用 rank 工具看排行榜。',
              isError: true
            };
          }
          userId = req.userId;
        }

        const rec = members[userId] || (members[userId] = newRecord(Date.now()));
        await fillName(ctx, rec, userId);
        if (isOwner(userId, s)) {
          pinOwner(rec, s);
        } else {
          applyDecay(rec, Date.now(), s);
        }
        markDirty();
        await flush();

        const rankInfo = rankOf(members, userId, s);
        const lines = [
          `对象：${rec.name || userId}（QQ ${userId}）${target ? '' : '，也就是正在提问的这个人'}`,
          isOwner(userId, s)
            ? `好感度：${rec.score} 分（满级，主人固定值，不参与加分和衰减）`
            : `好感度：${rec.score} 分`,
          `等级：Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」${isOwner(userId, s) ? ' · 身份：主人' : ''}`,
          `升级进度：${isOwner(userId, s) ? '已经是最高等级，无需再攒' : progressText(rec.score, s)}`,
          `累计发言：${rec.msgs} 条${rec.dayGain ? `（今天已 +${rec.dayGain}）` : ''}`,
          `认识时间：${fmtDate(rec.firstSeen)} 起，最近互动 ${fmtDate(rec.lastSeen)}`,
          `群内排名：第 ${rankInfo.rank} 名 / 共 ${rankInfo.total} 人`
        ];

        if (ambiguous > 1) {
          lines.push(`注意：群里有 ${ambiguous} 个人的名字都能匹配「${target}」，这里显示的是分数最高的那位。想精确指定就用 QQ 号查。`);
        }

        const notices = takePending(chatKey, userId);
        if (notices.length) {
          lines.push('', `另外请在回答里顺口提一句（只提一次，别重复播）：${notices.join('；')}`);
        }

        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查询好感度失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'rank',
    name: '好感度排行榜',
    description:
      '列出当前会话里好感度最高的若干人，含分数和等级称号。' +
      '当有人说「好感度排行」「排行榜」「谁跟机器人最熟」「群里谁好感度最高」时使用。' +
      'topN 不填就用设置里的默认值。',
    category: 'query',
    icon: '🏆',
    parameters: {
      type: 'object',
      properties: {
        topN: {
          type: 'number',
          description: '列出前几名，1~50。不填则用插件设置里的默认值。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法查询排行榜。', isError: true };

        await ensureLoaded();
        await accumulate({ chatKey, store: ctx?.store, triggerEntries: ctx?.session?.triggerEntries });
        syncOwners();

        const members = db.chats[chatKey]?.members || {};
        const list = sortedMembers(members);
        if (!list.length) return { content: '这个会话还没有好感度记录，等大家聊几句再来查排行榜。' };

        const n = clamp(Number(args?.topN) || Number(s.topN) || 10, 1, 50);
        const now = Date.now();
        const shown = Math.min(n, list.length);
        const lines = [`好感度排行榜（前 ${shown} 名 / 共 ${list.length} 人）`];
        list.slice(0, n).forEach(([userId, rec], i) => {
          if (!isOwner(userId, s)) applyDecay(rec, now, s);
          const tag = isOwner(userId, s) ? ' · 主人' : '';
          lines.push(`${i + 1}. ${rec.name || userId} — ${rec.score} 分 · Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」${tag}`);
        });

        // 如果发问者自己没进榜，补一行告诉 TA 自己的位置
        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const req = await resolveRequester(ctx, chatKey, selfId, s);
        if (req.userId && members[req.userId]) {
          const info = rankOf(members, req.userId, s);
          if (info.rank > shown) {
            const rec = members[req.userId];
            lines.push(`（提问的 ${rec.name || req.userId} 排在第 ${info.rank} 名，${rec.score} 分 · Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」）`);
          }
        }
        markDirty();
        await flush();
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查询排行榜失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'tune',
    name: '调整好感度设定',
    description:
      '查看或修改本插件的设定（加分值、每日上限、衰减规则、等级门槛、排行榜人数、主人 QQ 号等）。' +
      '仅当主人 QQ 号本人提出「看看好感度设定」「把每条加分改成 2」「关掉衰减」「等级门槛改成 …」' +
      '「把某人设成主人」这类要求时使用。非主人提出时不要调用本工具。' +
      'action=list 查看当前全部设定；action=set 配合 item 和 value 修改一项；' +
      'action=clear 清除在聊天里做过的修改、恢复成控制台的值。',
    category: 'system',
    icon: '🎛️',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'set', 'clear'],
          description: 'list=列出当前设定；set=修改某一项；clear=清除聊天里做过的覆盖（不填 item 表示全部清除）'
        },
        item: {
          type: 'string',
          description:
            '设置项英文名。可选：perMessage / atBotBonus / replyBonus / dailyCap / decayAfterDays / decayPerDay / ' +
            'scanLimit / topN / ownerScore / announceLevelUp / allowReset / ownerQq / botQq / levelThresholds'
        },
        value: {
          type: 'string',
          description: '新值，一律用字符串传。数字写 "2"；开关写 "true" 或 "false"；QQ 号多个用英文逗号分隔；等级门槛写 "50,200,500,1000"'
        }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法调整设定。', isError: true };

        await ensureLoaded();
        const owners = ownerList(s);
        if (!owners.length) {
          return {
            content: '当前没有配置主人 QQ 号，所以谁都不能在聊天里改设定。请先到控制台「插件」页 → 群友好感度 → 设置里填「主人 QQ 号」。',
            isError: true
          };
        }

        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const req = await resolveRequester(ctx, chatKey, selfId, s);
        if (!req.userId) {
          return { content: '没能确认是谁在要求改设定。请让主人在提问时带上自己的 QQ 号，或到控制台设置页改。', isError: true };
        }
        if (!owners.includes(String(req.userId))) {
          return {
            content: `权限不足：QQ ${req.userId}（${req.name || '未知昵称'}）不是主人，不能调整好感度设定。只有主人 QQ 号可以改。请礼貌拒绝，不要透露具体数值以外的内部信息。`,
            isError: true
          };
        }

        const action = String(args?.action ?? '').trim().toLowerCase();

        if (action === 'list') {
          const overrides = db.meta?.overrides || {};
          const lines = [`当前好感度设定（主人：${owners.join('、')}）`];
          for (const [key, meta] of Object.entries(TUNABLE)) {
            const val = s[key];
            const src = Object.prototype.hasOwnProperty.call(overrides, key) ? '聊天改过' : '控制台/默认';
            lines.push(`${meta.label}（${key}）= ${formatVal(val)} ［${src}］`);
          }
          lines.push('', '要改哪一项，直接说「把 XX 改成 Y」就行；说「恢复默认设定」可清除所有聊天里的修改。');
          return { content: lines.join('\n') };
        }

        if (action === 'set') {
          const item = String(args?.item ?? '').trim();
          const meta = TUNABLE[item];
          if (!meta) {
            return {
              content: `没有叫「${item || '(空)'}」的设置项。可选项：${Object.keys(TUNABLE).join('、')}。`,
              isError: true
            };
          }
          const parsed = coerceValue(meta, args?.value);
          if (!parsed.ok) return { content: parsed.error, isError: true };

          if (!db.meta) db.meta = {};
          if (!db.meta.overrides || typeof db.meta.overrides !== 'object') db.meta.overrides = {};
          db.meta.overrides[item] = parsed.value;
          markDirty();
          await flush();
          syncOwners();
          markDirty();
          await flush();

          const extra = item === 'ownerQq' ? '（新的主人已生效，好感度立刻变满级）' : '';
          return { content: `已把「${meta.label}」改成 ${formatVal(parsed.value)}${extra}。此改动优先级高于控制台设置，随时可以说「恢复默认设定」撤销。` };
        }

        if (action === 'clear') {
          const item = String(args?.item ?? '').trim();
          const overrides = db.meta?.overrides || {};
          if (item) {
            if (!TUNABLE[item]) return { content: `没有叫「${item}」的设置项。`, isError: true };
            if (!Object.prototype.hasOwnProperty.call(overrides, item)) {
              return { content: `「${TUNABLE[item].label}」本来就没在聊天里改过，不需要清除。` };
            }
            delete overrides[item];
            markDirty();
            await flush();
            syncOwners();
            markDirty();
            await flush();
            return { content: `已清除「${TUNABLE[item].label}」的聊天修改，恢复为控制台/默认值 ${formatVal(currentSettings()[item])}。` };
          }
          const n = Object.keys(overrides).length;
          db.meta.overrides = {};
          markDirty();
          await flush();
          syncOwners();
          markDirty();
          await flush();
          return { content: n ? `已清除全部 ${n} 项聊天修改，恢复为控制台/默认设定。` : '当前没有任何聊天里做过的修改，不用清除。' };
        }

        return { content: `看不懂 action「${action}」。只能用 list / set / clear。`, isError: true };
      } catch (error) {
        return { content: `调整设定失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'reset',
    name: '重置好感度',
    description:
      '把某个群友（或整个会话）的好感度清零重来。这是不可撤销的操作，' +
      '仅当用户明确要求「清空/重置好感度」时才用。主人 QQ 号永远可以重置；' +
      '其他人只有在插件设置开启了「允许任何人重置好感度」时才可以。',
    category: 'system',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要重置的人，QQ 号或群昵称。留空表示重置整个会话（所有人）。'
        },
        confirm: {
          type: 'boolean',
          description: '必须为 true 才执行。用于防止误清空整个会话。'
        }
      },
      required: ['confirm']
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法重置。', isError: true };

        await ensureLoaded();

        if (args?.confirm !== true) {
          return { content: '重置不可撤销。请先向用户确认，再带 confirm=true 调用一次。', isError: true };
        }

        // 权限：主人永远可以；其他人要看 allowReset 开关
        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const req = await resolveRequester(ctx, chatKey, selfId, s);
        const byOwner = Boolean(req.userId) && ownerList(s).includes(String(req.userId));
        if (!byOwner && !s.allowReset) {
          return {
            content: '重置功能对普通群友是关闭的（设置里 allowReset=false），只有主人 QQ 号能重置。请礼貌拒绝，并说明可以让主人来操作。',
            isError: true
          };
        }

        const chat = db.chats[chatKey];
        if (!chat) return { content: '这个会话还没有好感度数据，不需要重置。' };

        const target = String(args?.target ?? '').trim();
        if (!target) {
          const n = Object.keys(chat.members || {}).length;
          chat.members = {};
          chat.seen = [];
          markDirty();
          await flush();
          syncOwners();
          markDirty();
          await flush();
          return { content: `已清空本会话全部好感度记录（共 ${n} 人）。此操作不可撤销。主人的满级记录会在 TA 下次发言时重新建立。` };
        }

        const hit = findMember(chat.members || {}, target);
        if (!hit) return { content: `没有找到「${target}」的好感度记录，无需重置。` };
        const name = hit.rec.name || hit.userId;
        delete chat.members[hit.userId];
        markDirty();
        await flush();
        return { content: `已清空 ${name}（QQ ${hit.userId}）的好感度记录。此操作不可撤销。` };
      } catch (error) {
        return { content: `重置好感度失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  log('群友好感度已加载');
}

/** 可用性自检：必须同步返回，绝不返回 Promise */
export function available() {
  return true;
}

export async function activate(ctx) {
  activeCtx = ctx || null;
  await ensureLoaded();
  syncOwners();
  markDirty();
  await flush();
  if (flushTimer) clearInterval(flushTimer);
  // 定时把"升级播报"发到群里。钩子里禁止发消息，所以只能在这里补。
  // 如果运行时没给 sender，这个定时器就是空转，不影响其他功能。
  flushTimer = setInterval(() => {
    flushPendingAnnouncements().catch(() => {});
  }, 120000);
  if (typeof flushTimer?.unref === 'function') flushTimer.unref();
  log(`群友好感度已启用（主人：${ownerList(currentSettings()).join('、') || '未设置'}）`);
}

export async function deactivate() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  activeCtx = null;
  await flush();
}

export function dispose() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  activeCtx = null;
  db = null;
  loaded = false;
  dirty = false;
}

// ───────────────────────────── 钩子 ─────────────────────────────

export const hooks = {
  /**
   * 组装提示词之前触发。这里做确定性的"记账"：
   * 补扫最近的聊天记录，给发过言的人加分。
   * 注意：不发消息、不发网络请求、不重试（plugin-development.md §3.2 硬约束）。
   */
  'before-context': async (payload) => {
    try {
      const r = await accumulate(payload || {});
      if (r.counted > 0) log(`好感度记账：${r.chatKey} 新增 ${r.counted} 条发言`);
    } catch (error) {
      warn(`好感度记账失败：${error?.message ?? error}`);
    }
    // 不返回任何值（返回 undefined 才不会被收集）
  }
};

// ───────────────────────────── 核心逻辑 ─────────────────────────────

/**
 * 补扫 + 记分。钩子和工具都走这一个入口。
 * @returns {Promise<{chatKey:string, counted:number}>}
 */
async function accumulate(payload = {}) {
  await ensureLoaded();
  const s = currentSettings();
  const chatKey = String(
    payload.chatKey || (payload.kind && payload.chatId ? `${payload.kind}:${payload.chatId}` : '') || ''
  );
  if (!chatKey) return { chatKey: '', counted: 0 };

  const chat = getChat(chatKey);
  let selfId = String(s.botQq || '').trim() || String(db.meta?.selfId || '');

  const raws = [];

  // 1) 聊天记录（store 里存着全部入群消息，包括没触发机器人的那些）
  const store = payload.store;
  if (store && typeof store.recent === 'function') {
    const limit = clamp(Number(s.scanLimit) || 200, 20, 1000);
    try {
      const got = await store.recent(chatKey, { limit });
      raws.push(...unwrapList(got));
    } catch (error) {
      warn(`读取聊天记录失败（不影响本次对话）：${error?.message ?? error}`);
    }
  }

  // 2) 本轮触发消息（可能 store 还没落盘）
  raws.push(...unwrapList(payload.triggerEntries));

  const seen = new Set(Array.isArray(chat.seen) ? chat.seen : []);
  const ents = [];
  for (const raw of raws) {
    const ent = normalizeEntry(raw, selfId);
    if (!ent) continue;
    // 顺手学习"机器人自己的 QQ 号"，用于识别谁 @ 了机器人
    if (ent.isSelf && ent.userId && !selfId) {
      selfId = ent.userId;
      db.meta.selfId = ent.userId;
    }
    ents.push(ent);
  }

  ents.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const now = Date.now();
  let counted = 0;
  let prevWasSelf = false;

  for (const ent of ents) {
    const key = ent.mid ? `m:${ent.mid}` : `k:${ent.userId}:${ent.ts}:${(ent.text || '').slice(0, 16)}`;
    const already = seen.has(key);
    if (!already) seen.add(key);

    if (ent.isSelf) {
      prevWasSelf = true;
      continue;
    }
    if (!ent.userId || already) {
      prevWasSelf = false;
      continue;
    }
    // 首次安装时不要把整个群历史灌进来：只记最近 24 小时内的消息
    if (ent.ts && now - ent.ts > DAY) {
      prevWasSelf = false;
      continue;
    }

    const atBot = selfId ? ent.ats.includes(String(selfId)) : false;
    const replyToBot = Boolean(ent.hasReply) && prevWasSelf;
    touchMember(chat, ent, ent.ts || now, s, { atBot, replyToBot });
    counted += 1;
    prevWasSelf = false;
  }

  chat.seen = [...seen].slice(-SEEN_KEEP);
  chat.lastScanAt = now;
  syncOwners();

  if (counted > 0 || db.meta?.selfId) {
    markDirty();
    await flush();
  }
  return { chatKey, counted };
}

/** 给一条消息记账 */
function touchMember(chat, ent, now, s, { atBot = false, replyToBot = false } = {}) {
  const rec = chat.members[ent.userId] || (chat.members[ent.userId] = newRecord(now));
  if (!rec.firstSeen) rec.firstSeen = now;
  if (ent.name) rec.name = ent.name;
  rec.msgs = (Number(rec.msgs) || 0) + 1;
  rec.lastSeen = now;

  // 主人：分数恒定满级，不加分、不衰减、不播报
  if (isOwner(ent.userId, s)) {
    pinOwner(rec, s);
    return 0;
  }

  applyDecay(rec, now, s);

  const dayKey = dayString(now);
  if (rec.dayKey !== dayKey) {
    rec.dayKey = dayKey;
    rec.dayGain = 0;
  }

  let gain = Number(s.perMessage) || 0;
  if (atBot) gain += Number(s.atBotBonus) || 0;
  if (replyToBot) gain += Number(s.replyBonus) || 0;
  gain = Math.max(0, Math.round(gain));

  const room = Math.max(0, (Number(s.dailyCap) || 0) - (Number(rec.dayGain) || 0));
  const applied = Math.min(gain, room);

  rec.score = Math.max(0, (Number(rec.score) || 0) + applied);
  rec.dayGain = (Number(rec.dayGain) || 0) + applied;

  const lv = levelOf(rec.score, s);
  if (lv.level > (Number(rec.level) || 1)) {
    rec.level = lv.level;
    if (s.announceLevelUp !== false) {
      if (!Array.isArray(rec.pending)) rec.pending = [];
      rec.pending.push({ name: rec.name || ent.userId, title: lv.title, level: lv.level, at: now });
      if (rec.pending.length > PENDING_KEEP) rec.pending = rec.pending.slice(-PENDING_KEEP);
    }
  } else {
    // 降级（衰减导致）或门槛被改过：静默校正，不播报
    rec.level = lv.level;
  }
  return applied;
}

/** 按"多少天没发言"惰性扣分。用 decayAnchor 保证同一段时间不会被重复扣。主人不扣分。 */
export function applyDecay(rec, now, s) {
  if (!rec || typeof rec !== 'object') return 0;
  if (rec.pinned === true) return 0; // 主人恒定满级

  let loss = 0;
  const perDay = Number(s?.decayPerDay) || 0;
  if (perDay > 0) {
    const afterDays = Math.max(0, Number(s?.decayAfterDays) || 0);
    const anchor = Math.max(Number(rec.lastSeen) || 0, Number(rec.decayAnchor) || 0);
    if (anchor) {
      const days = Math.floor((now - anchor) / DAY);
      const over = days - afterDays;
      rec.decayAnchor = now;
      if (over > 0) {
        loss = Math.min(Number(rec.score) || 0, over * perDay);
        if (loss > 0) {
          rec.score = Math.max(0, (Number(rec.score) || 0) - loss);
          rec.decayed = (Number(rec.decayed) || 0) + loss;
        } else {
          loss = 0;
        }
      }
    }
  }

  // 无论有没有扣分，都把 level 校正到"当前分数 + 当前门槛"
  // （门槛可能被主人在聊天里改过，存的旧 level 会失效）
  rec.level = levelOf(rec.score, s).level;
  return loss;
}

// ───────────────────────────── 主人 ─────────────────────────────

/** 主人 QQ 号列表（支持逗号分隔多个） */
export function ownerList(s) {
  const raw = String(s?.ownerQq ?? '');
  return raw
    .split(/[,，\s]+/)
    .map((x) => x.replace(/[^\d]/g, ''))
    .filter(Boolean);
}

function isOwner(userId, s) {
  const uid = String(userId ?? '').trim();
  if (!uid) return false;
  return ownerList(s).includes(uid);
}

/** 把一条记录钉成满级 */
function pinOwner(rec, s) {
  const max = Math.max(0, Math.round(Number(s?.ownerScore) || 0));
  rec.pinned = true;
  rec.score = max;
  rec.level = levelOf(max, s).level;
  rec.dayGain = 0;
  if (Array.isArray(rec.pending)) rec.pending = [];
}

/** 遍历所有会话，把主人的记录钉成满级、把不再是主人的记录解除钉住 */
function syncOwners() {
  if (!db) return;
  const s = currentSettings();
  const owners = ownerList(s);
  const max = Math.max(0, Math.round(Number(s.ownerScore) || 0));
  const maxLevel = levelOf(max, s).level;
  for (const chat of Object.values(db.chats || {})) {
    for (const [uid, rec] of Object.entries(chat?.members || {})) {
      if (owners.includes(String(uid))) {
        rec.pinned = true;
        rec.score = max;
        rec.level = maxLevel;
        rec.dayGain = 0;
        if (Array.isArray(rec.pending)) rec.pending = [];
      } else if (rec.pinned === true) {
        rec.pinned = false; // 被移出主人名单，分数保持当前值，恢复普通规则
      }
    }
  }
}

/** 主人从没发过言时的查询结果 */
function ownerReport(userId, name, s, isSelfQuery) {
  const max = Math.max(0, Math.round(Number(s.ownerScore) || 0));
  const lv = levelOf(max, s);
  return [
    `对象：${name || userId}（QQ ${userId}）${isSelfQuery ? '，也就是正在提问的这个人' : ''}`,
    `好感度：${max} 分（满级，主人固定值，不参与加分和衰减）`,
    `等级：Lv.${lv.level}「${lv.title}」 · 身份：主人`,
    '升级进度：已经是最高等级，无需再攒',
    '备注：TA 在这个会话里还没有发言记录，所以没有发言数和认识时间可显示。'
  ].join('\n');
}

// ───────────────────────────── 设定改写 ─────────────────────────────

function coerceValue(meta, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: `「${meta.label}」需要一个新值，你没给。` };

  if (meta.type === 'number') {
    const n = Number(text);
    if (!Number.isFinite(n)) return { ok: false, error: `「${meta.label}」要填数字，收到的是「${text}」。` };
    const v = clamp(n, meta.min, meta.max);
    const note = v !== Math.round(n) ? `（超出范围，已收敛到 ${v}）` : '';
    return { ok: true, value: v, note };
  }

  if (meta.type === 'boolean') {
    const t = text.toLowerCase();
    if (['true', '1', 'on', 'yes', '开', '开启', '打开', '是'].includes(t)) return { ok: true, value: true };
    if (['false', '0', 'off', 'no', '关', '关闭', '关掉', '否'].includes(t)) return { ok: true, value: false };
    return { ok: false, error: `「${meta.label}」是开关，只能填 true/false（或"开"/"关"），收到的是「${text}」。` };
  }

  if (meta.type === 'qqList') {
    const parts = text.split(/[,，\s]+/).map((x) => x.replace(/[^\d]/g, '')).filter(Boolean);
    if (text.replace(/[,，\s]/g, '') === '') return { ok: true, value: '' }; // 允许清空
    if (!parts.length) return { ok: false, error: `「${meta.label}」要填 QQ 号（纯数字，多个用英文逗号分隔），收到的是「${text}」。` };
    for (const p of parts) {
      if (p.length < 5 || p.length > 12) return { ok: false, error: `QQ 号「${p}」长度不像正常号码（应为 5~12 位数字）。` };
    }
    return { ok: true, value: parts.join(',') };
  }

  if (meta.type === 'thresholds') {
    const parts = text.split(/[,，\s]+/).map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n));
    if (parts.length !== 4) {
      return { ok: false, error: `「${meta.label}」要填 4 个递增的数字（对应 Lv.2~Lv.5），收到 ${parts.length} 个：「${text}」。` };
    }
    if (!parts.every((n) => n > 0 && Number.isFinite(n))) return { ok: false, error: '等级门槛必须都是正数。' };
    for (let i = 1; i < parts.length; i += 1) {
      if (parts[i] <= parts[i - 1]) return { ok: false, error: `等级门槛必须严格递增，第 ${i + 1} 个（${parts[i]}）没有大于第 ${i} 个（${parts[i - 1]}）。` };
    }
    return { ok: true, value: parts.map((n) => Math.round(n)).join(',') };
  }

  return { ok: true, value: text };
}

function formatVal(v) {
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (v === '' || v === null || v === undefined) return '（空）';
  return String(v);
}

// ───────────────────────────── 播报 ─────────────────────────────

/** 把待播报的升级消息发到群里（只在 activate 拿到 sender 时生效） */
async function flushPendingAnnouncements() {
  const sender = activeCtx?.sender;
  if (!sender || typeof sender.sendTextBatch !== 'function') return;
  const s = currentSettings();
  if (s.announceLevelUp === false) return;
  await ensureLoaded();

  const now = Date.now();
  let changed = false;

  for (const [chatKey, chat] of Object.entries(db.chats || {})) {
    const lines = [];
    for (const [uid, rec] of Object.entries(chat?.members || {})) {
      if (isOwner(uid, s)) continue; // 主人不播报
      if (!Array.isArray(rec.pending) || !rec.pending.length) continue;
      const fresh = rec.pending.filter((p) => now - (Number(p.at) || 0) < PENDING_TTL);
      rec.pending = [];
      changed = true;
      for (const p of fresh.slice(-2)) {
        lines.push(`${p.name || '有群友'} 的好感度升到了 Lv.${p.level}「${p.title}」`);
      }
    }
    if (!lines.length) continue;
    try {
      await sender.sendTextBatch(chatKey, [`好感度更新：${lines.join('；')}`]);
    } catch (error) {
      warn(`升级播报发送失败（${chatKey}）：${error?.message ?? error}`);
    }
  }

  if (changed) {
    markDirty();
    await flush();
  }
}

/** 查询时取走某人积压的升级播报（避免和定时器重复播报） */
function takePending(chatKey, userId) {
  const rec = db.chats?.[chatKey]?.members?.[userId];
  if (!rec || !Array.isArray(rec.pending) || !rec.pending.length) return [];
  const now = Date.now();
  const out = rec.pending
    .filter((p) => now - (Number(p.at) || 0) < PENDING_TTL)
    .map((p) => `${p.name || userId} 的好感度升到了 Lv.${p.level}「${p.title}」`);
  rec.pending = [];
  markDirty();
  return out;
}

// ───────────────────────────── 消息条目解析 ─────────────────────────────

/**
 * 把 store / triggerEntries 里的消息条目统一成一种结构。
 * 不同来源字段名不一致，这里做宽松兼容（拿不到就留空，不猜）。
 */
export function normalizeEntry(raw, selfId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw.entry && typeof raw.entry === 'object' ? Object.assign({}, raw, raw.entry) : raw;
  const sender = e.sender && typeof e.sender === 'object' ? e.sender : null;

  const userId = String(
    firstVal([
      e.userId, e.user_id, e.senderId, e.senderUserId, e.fromUserId, e.qq,
      sender?.user_id, sender?.userId, sender?.id
    ]) ?? ''
  ).trim();

  const name = String(
    firstVal([e.groupCard, e.card, sender?.card, sender?.nickname, e.nickname, e.senderName, e.name, e.remark]) ?? ''
  ).trim();

  const ts = toMs(firstVal([e.timestamp, e.ts, e.time, e.at, e.createdAt, e.date, e.sendTime]));
  const mid = String(firstVal([e.messageId, e.message_id, e.mid, e.localId, e.id]) ?? '').trim();

  const { text, ats, hasReply, hasMedia } = extractContent(e);

  const selfRole = String(sender?.role ?? '');
  const isSelf =
    e.self === true || e.fromSelf === true || e.isSelf === true || e.outgoing === true || e.fromMe === true ||
    selfRole === 'self' || selfRole === 'owner_self' ||
    Boolean(selfId && userId && userId === String(selfId));

  if (!userId && !text && !hasMedia) return null;
  return { userId, name, ts, mid, text, ats, hasReply, hasMedia, isSelf };
}

function extractContent(e) {
  let text = '';
  let hasReply = false;
  let hasMedia = false;
  const ats = [];

  const pushSeg = (seg) => {
    if (!seg || typeof seg !== 'object') return;
    const t = String(seg.type ?? '').toLowerCase();
    const d = seg.data && typeof seg.data === 'object' ? seg.data : {};
    if (t === 'text') {
      text += String(d.text ?? '');
    } else if (t === 'at') {
      const q = String(d.qq ?? d.id ?? d.userId ?? d.user_id ?? '').trim();
      if (q && q !== 'all') ats.push(q);
    } else if (t === 'reply') {
      hasReply = true;
    } else if (t) {
      hasMedia = true;
    }
  };

  const msg = firstVal([e.message, e.segments, e.content, e.text, e.raw_message]);
  if (Array.isArray(msg)) {
    for (const seg of msg) pushSeg(seg);
  } else if (typeof msg === 'string') {
    text += msg;
  } else {
    const t = firstVal([e.text, e.raw_message, e.content]);
    if (typeof t === 'string') text += t;
  }

  if (e.hasReply === true) hasReply = true;
  if (Array.isArray(e.media) && e.media.length) hasMedia = true;

  // CQ 码形式的 at / reply / 媒体
  for (const m of text.matchAll(/\[CQ:at,qq=(\d+)[^\]]*\]/g)) ats.push(m[1]);
  if (/\[CQ:reply/.test(text)) hasReply = true;
  if (/\[CQ:(image|record|video|file)/.test(text)) hasMedia = true;

  text = text.replace(/\[CQ:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, ats, hasReply, hasMedia };
}

/** store.recent 可能返回数组，也可能返回包了一层的对象 */
function unwrapList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flat(1).filter(Boolean);
  if (typeof x === 'object') {
    for (const k of ['messages', 'entries', 'items', 'list', 'data', 'records']) {
      if (Array.isArray(x[k])) return x[k].filter(Boolean);
    }
  }
  return [];
}

function firstVal(list) {
  for (const v of list) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    return v;
  }
  return undefined;
}

function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

// ───────────────────────────── 查询辅助 ─────────────────────────────

/**
 * 确认"是谁在问"。私聊场景 chatId 就是对方 QQ 号，直接用；
 * 群聊场景取聊天记录里最近一条、且内容和本次触发文本对得上的非机器人消息。
 */
async function resolveRequester(ctx, chatKey, selfId, s) {
  if (ctx?.kind === 'private' && ctx?.chatId) {
    return { userId: String(ctx.chatId), name: '' };
  }
  const store = ctx?.store;
  if (!store || typeof store.recent !== 'function') return { userId: '', name: '' };
  let list = [];
  try {
    list = unwrapList(await store.recent(chatKey, { limit: 20 }));
  } catch {
    return { userId: '', name: '' };
  }
  const ents = list
    .map((raw) => normalizeEntry(raw, selfId))
    .filter((x) => x && !x.isSelf && x.userId)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!ents.length) return { userId: '', name: '' };

  const trigger = String(ctx?.session?.triggerText || '').replace(/\s+/g, '').trim();
  if (trigger) {
    for (const ent of ents) {
      const t = String(ent.text || '').replace(/\s+/g, '');
      if (!t) continue;
      const a = t.slice(0, 30);
      const b = trigger.slice(0, 30);
      if (trigger.includes(a) || t.includes(b)) return { userId: ent.userId, name: ent.name };
    }
  }
  // 兜底：最近发言的人。仅用于查询类场景；改写类操作会再校验是否主人
  return { userId: ents[0].userId, name: ents[0].name };
}

/** 按 QQ 号 / 昵称找人 */
export function findMember(members, target) {
  const q = String(target ?? '').trim();
  if (!q) return null;
  const pure = q.replace(/[^\d]/g, '');
  if (pure && members[pure]) return { userId: pure, rec: members[pure] };

  const list = Object.entries(members || {});
  const norm = (x) => String(x || '').trim().toLowerCase();
  const key = norm(q);

  const exact = list.find(([, r]) => norm(r.name) === key);
  if (exact) return { userId: exact[0], rec: exact[1] };

  const fuzzy = list.filter(([, r]) => norm(r.name) && (norm(r.name).includes(key) || key.includes(norm(r.name))));
  if (fuzzy.length === 1) return { userId: fuzzy[0][0], rec: fuzzy[0][1] };
  if (fuzzy.length > 1) {
    // 多个同名时取分数最高的那个，并在结果里说明有歧义
    fuzzy.sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
    return { userId: fuzzy[0][0], rec: fuzzy[0][1], ambiguous: fuzzy.length };
  }
  return null;
}

function sortedMembers(members) {
  return Object.entries(members || {}).sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
}

function rankOf(members, userId, s) {
  const list = sortedMembers(members);
  const idx = list.findIndex(([id]) => id === String(userId));
  return { rank: idx >= 0 ? idx + 1 : 0, total: list.length };
}

/** 昵称缺失时，用 OneBot 封装方法补一次（失败就算了，不影响主流程） */
async function fillName(ctx, rec, userId) {
  if (!rec || rec.name || ctx?.kind !== 'group' || !ctx?.onebot) return;
  if (typeof ctx.onebot.getGroupMemberInfo !== 'function') return;
  const gid = Number(ctx.chatId);
  const uid = Number(userId);
  if (!Number.isInteger(gid) || gid <= 0 || !Number.isInteger(uid) || uid <= 0) return;
  try {
    const info = await ctx.onebot.getGroupMemberInfo(gid, uid);
    const nm = String(firstVal([info?.card, info?.nickname, info?.name]) ?? '').trim();
    if (nm) {
      rec.name = nm;
      markDirty();
    }
  } catch (error) {
    warn(`补全群昵称失败（QQ ${userId}）：${error?.message ?? error}`);
  }
}

// ───────────────────────────── 纯函数 ─────────────────────────────

/** 按设置里的门槛拼出等级表（从高到低） */
export function levelTable(s) {
  let th = DEFAULT_THRESHOLDS.slice();
  const raw = String(s?.levelThresholds ?? '').trim();
  if (raw) {
    const parts = raw.split(/[,，\s]+/).map((x) => Number(String(x).trim()));
    const ok =
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n) && n > 0) &&
      parts.every((n, i) => i === 0 || n > parts[i - 1]);
    if (ok) th = parts.map((n) => Math.round(n));
    else if (raw) th = DEFAULT_THRESHOLDS.slice(); // 格式不对就回退默认，不抛错
  }
  return [
    { min: th[3], level: 5, title: LEVEL_TITLES[4] },
    { min: th[2], level: 4, title: LEVEL_TITLES[3] },
    { min: th[1], level: 3, title: LEVEL_TITLES[2] },
    { min: th[0], level: 2, title: LEVEL_TITLES[1] },
    { min: 0, level: 1, title: LEVEL_TITLES[0] }
  ];
}

export function levelOf(score, s) {
  const v = Math.max(0, Math.floor(Number(score) || 0));
  const table = levelTable(s);
  for (const L of table) if (v >= L.min) return L;
  return table[table.length - 1];
}

export function titleOf(score, s) {
  return levelOf(score, s).title;
}

export function progressText(score, s) {
  const v = Math.max(0, Math.floor(Number(score) || 0));
  const next = levelTable(s).filter((L) => L.min > v).sort((a, b) => a.min - b.min)[0];
  if (!next) return '已经是最高等级「挚友」了';
  return `再攒 ${next.min - v} 分升到 Lv.${next.level}「${next.title}」`;
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function dayString(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(ts) {
  if (!ts) return '未知';
  return dayString(ts);
}

function chatKeyOf(ctx) {
  if (!ctx) return '';
  if (ctx.chatKey) return String(ctx.chatKey);
  if (ctx.kind && ctx.chatId) return `${ctx.kind}:${ctx.chatId}`;
  return '';
}

/** 生效设定 = 内置默认 < 控制台设置 < 主人在聊天里做的覆盖 */
function currentSettings() {
  const out = { ...DEFAULTS };
  let c = {};
  try {
    c = cfg() || {};
  } catch {
    c = {};
  }
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  const ov = db?.meta?.overrides;
  if (ov && typeof ov === 'object') {
    for (const [k, v] of Object.entries(ov)) {
      if (v === undefined || v === null) continue;
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, k)) continue; // 只接受白名单里的键
      out[k] = v;
    }
  }
  return out;
}

// ───────────────────────────── 持久化 ─────────────────────────────

function dataFilePath() {
  if (dbFile) return dbFile;
  const dir = process.env.QQ_AGENT_DATA_DIR || path.resolve(process.cwd(), 'data');
  dbFile = path.join(dir, 'affinity.json');
  return dbFile;
}

async function ensureLoaded() {
  if (loaded && db) return db;
  loaded = true;
  db = { version: 1, meta: {}, chats: {} };
  try {
    const raw = await fs.readFile(dataFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.meta && typeof parsed.meta === 'object') db.meta = parsed.meta;
      if (parsed.chats && typeof parsed.chats === 'object') db.chats = parsed.chats;
      if (!db.meta.overrides || typeof db.meta.overrides !== 'object') db.meta.overrides = {};
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`读取好感度数据失败，将从空数据开始：${error?.message ?? error}`);
  }
  syncOwners();
  return db;
}

function getChat(chatKey) {
  const c = db.chats[chatKey] || (db.chats[chatKey] = { members: {}, seen: [], lastScanAt: 0 });
  if (!c.members || typeof c.members !== 'object') c.members = {};
  if (!Array.isArray(c.seen)) c.seen = [];
  return c;
}

function newRecord(now) {
  return {
    name: '',
    score: 0,
    level: 1,
    msgs: 0,
    firstSeen: now,
    lastSeen: now,
    dayKey: dayString(now),
    dayGain: 0,
    pinned: false,
    pending: []
  };
}

function markDirty() {
  dirty = true;
}

async function flush() {
  if (!dirty || !db) return;
  dirty = false;
  try {
    const file = dataFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(db), 'utf8');
  } catch (error) {
    dirty = true; // 写失败就保留脏标记，下次再试
    warn(`写入好感度数据失败：${error?.message ?? error}`);
  }
}
