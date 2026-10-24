// early-finish —— 提前收尾：把 orchestrator 里那个一直没人实现的 reply.local-policy 口子补上。
//
// 背景（2026-10-04 实测）：
//   每次运行要调 LLM 2~3 次，而**每一次都要把整份提示词重新发一遍**（实测约 26k 字符 ≈ 22k token）。
//   其中绝大多数运行的**最后一轮只是为了调一次 finish** —— 她要说的话上一轮已经发出去了，
//   这一轮没有任何实际产出，纯烧钱。orchestrator.js 里本来就留了口子（注释写着
//   "一批'只发送、不遗留待办'的工具结果之后允许提前结束，省掉没有意义的下一轮"），
//   但一直没有插件实现它。
//
// 这个插件只做一件事：实现它。判定逻辑见 lib/policy.js（宁可少省一轮，也不打断她做事）。
// 它**不碰提示词、不改人设、不拦发言** —— 纯粹的调度优化，所以对"她像不像人"零影响。

// ⚠️ 子模块必须用「带时间戳的动态 import」加载（2026-10-05 踩的坑）：
//    plugin-loader.js:305 只给插件入口加了 `?t=` 强制刷新，入口里静态 import 的子模块
//    仍被 Node 的 ESM 缓存锁住 —— "改了 lib/ 下的文件、reload 后还是旧代码"，而且测试
//    直接读文件会全绿，极难发现。这里自己加时间戳，让 lib 的改动也能热重载。
const { decideBatchEnd } = await import(`./lib/policy.js?t=${Date.now()}`);

let logFn = () => {};
let cfgFn = () => ({});

export function setup(api = {}) {
  if (typeof api.log === 'function') logFn = api.log;
  if (typeof api.config === 'function') cfgFn = api.config;
}

/**
 * 从她这一轮的思考里抽一句"她为什么这么说"，当收尾说明用（2026-10-06）。
 *
 * 为什么需要它：早收尾时 orchestrator 会写死话「本地收尾策略判定：本批已交付完毕」，
 *   控制台上就只剩这句、看不到她的意图了（群友反馈 + 主人点名）。
 *   她自己 finish 时那行是她的想法，早收尾时也该是 —— 否则等于为了省 token 把可读性丢了。
 *
 * 纯本地、**零成本**：思考本来就在手上（orchestrator 通过 ctx.reasoning 递过来），
 *   不需要额外调一次 LLM —— 所以"省 token 的原有效果"一点没动。
 */
export function digestIntent(reasoning) {
  const t = String(reasoning || '').replace(/\r/g, '').trim();
  if (!t) return '';
  const clean = (s) => String(s || '')
    .replace(/^[\s"'\u201c\u201d\u2018\u2019\-\u2022\u00b7]+/, '')
    .replace(/[\s"'\u201c\u201d\u2018\u2019]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // 结论通常在最后一个"落点标记"之后 —— 取它往后 200 字（保留完整思路，别截半句）
  // 分级：先找"她明确在说落点"的标记（回法/方案/回复），没有再退到宽泛的
  // （"最后"太宽 —— 实测抽到过她后面记心绪的那段，所以踢掉了）
  const primary = ['回法：', '回法:', '回复：', '回复:', '方案：', '方案:', '要说：', '要说:'];
  const secondary = ['就这么', '打算', '于是我', '我发'];
  let pos = -1;
  let ml = 0;
  for (const group of [primary, secondary]) {
    for (const mk of group) {
      const p = t.lastIndexOf(mk);
      if (p > pos) { pos = p; ml = mk.length; }
    }
    if (pos >= 0) break;   // 上一级找到了就不再往下退
  }
  if (pos >= 0) {
    const seg = clean(t.slice(pos + ml, pos + ml + 200));
    if (seg.length >= 15) return seg.slice(0, 120);
  }
  // 没有标记：取最后两行"像话的"（跳过纯符号/过短的行）
  const lines = t.split('\n').map((s) => s.trim()).filter((s) => s.length >= 8);
  return clean(lines.slice(-2).join(' ')).slice(0, 120);
}

// ── 自己把她的思考捞回来（2026-10-06）──────────────────────────────────────
//
// 为什么要这一手：新宿主会在调用 reply.local-policy 时把 reasoning 一起递过来（ctx.reasoning），
//   但**旧宿主不传** —— 那样"收尾说明显示她的意图"就只有更新过宿主的机器才有，
//   而**群友是只装插件的**（主人 2026-10-06 明确的要求：让他们只装插件也能用）。
//
// 好在 `after-response` 钩子是**核心一直就有的**，它的 payload 里带着 response（含 reasoning）；
//   而且**钩子在早收尾判定之前跑**：
//     L1049 runHook('after-response')  →  L1170 执行工具  →  L1288 判早收尾
//   所以这里存下来、provider 里取用 —— **不需要动宿主任何文件**。
//
// 只认 30 秒内的：provider 紧跟在同一次运行的钩子之后调用；超时说明是别的轮次的残留，
//   宁可不显示，也不能拿上一轮的思考冒充这一轮。
let lastThinkAt = 0;
let lastThinkText = '';

export const hooks = {
  async 'after-response'(ctx = {}) {
    try {
      const r = ctx?.response?.reasoning;
      if (typeof r === 'string' && r.trim()) {
        lastThinkText = r;
        lastThinkAt = Date.now();
      }
    } catch { /* 捞不到就算了，最多退回原来的说明 */ }
    return undefined;
  }
};

export function dispose() {
  lastThinkAt = 0;
  lastThinkText = '';
}

export const providers = {
  'reply.local-policy': (ctx = {}) => {
    try {
      const cfg = cfgFn() || {};
      if (cfg.enabled === false) return undefined;
      const r = decideBatchEnd(ctx.batch || {});
      if (r.shouldEnd) {
        if (cfg.dryRun === true) {
          logFn(`[early-finish] 试运行：这一批本来可以收尾（${r.reason}）`);
          return undefined;   // 试运行：只记录，不真的结束
        }
        logFn(`[early-finish] 提前收尾：${r.reason}`);
        // 把收尾说明换成"她的意图"（从她这一轮的思考里抽）—— 抽不出来才退回原来的死话
        const why = digestIntent(ctx.reasoning)
          || digestIntent(Date.now() - lastThinkAt < 30000 ? lastThinkText : '');
        if (why) return { ...r, reason: why };
      }
      return r;
    } catch (error) {
      // 任何异常都当"不收尾"处理 —— 省 token 不值得拿流程冒险
      try { logFn(`[early-finish] 判定出错（按不收尾处理）：${error?.message || error}`); } catch { /* 忽略 */ }
      return undefined;
    }
  }
};

