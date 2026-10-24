// lib/policy.js —— 本批是否已交付完毕（reply.local-policy 能力的实现）
//
// 由 early-finish 插件提供（2026-10-04 从 reply-guard 拆出，独立发布）。
//
// 为什么需要它（2026-10-04 实测）：
//   每次运行 2~3 次 LLM 调用，**每次都要重发整个 26k 字符的 prompt**（≈22k token）。
//   而绝大多数运行的最后一轮是「纯 finish」——批1 发完话，批2 只说一句"我结束了"。
//   这一轮纯粹为了让模型调 finish 而存在，22k token 全是浪费。
//
//   orchestrator.js:1273 本来就有 `reply.local-policy` 这个口子（注释写得明明白白：
//   "一批'只发送、不遗留待办'的工具结果之后允许提前结束，省掉没有意义的下一轮"），
//   但**没有任何插件提供它**，所以那段代码是 no-op —— 机制在，实现缺了。
//
// 设计原则：**宁可少省一轮，也不能打断她做事**。
//   只有"话确实发出去了、且这批没有遗留动作"时才 allow 提前结束；
//   任何失败、预告、未兑现的承诺，一律保留正常循环（让她继续说/补救）。

/** 预告式结尾：说了"我去看看/等下告诉你"但这一批没真的做完 —— 保留循环 */
const PREVIEW = /我(去|来)?(看看|查查|查一下|找找|问问|听听|翻翻)|等一下?(?:再)?(?:说|告诉|回)|待会(?:儿)?(?:说|告诉|回)|回头(?:再)?(?:说|告诉|回)/;

/** 预告要交东西（图/表情/语音/画）但这一批没交 —— 保留循环 */
const PROMISE_ASSET = /发(?:张|个|一)?(?:图|表情|照片|链接)|画(?:一|张)|给你(?:看|听)一?(?:下|张|段)|唱(?:一)?段/;

/**
 * 判定本批是否可以提前结束。
 *
 * @param {object} p
 * @param {Array}  p.calls    本批工具调用（{function:{name,arguments}}）
 * @param {Array}  p.results  本批工具结果（{isError, content}）
 * @param {Array}  p.newSent  本批新发出的消息（{type,text,...}）
 * @returns {{shouldEnd:boolean, reason:string}}
 */
export function decideBatchEnd({ calls = [], results = [], newSent = [] } = {}) {
  const no = (reason) => ({ shouldEnd: false, reason });

  // ① 这一批必须真的把话发出去了 —— 没有发送动作就谈不上"交付完毕"
  const hasSend = calls.some((c) => String(c?.function?.name || '') === 'send_message');
  if (!hasSend) return no('本批没有发送动作');
  if (!newSent.length) return no('发送未确认（没有实际发出的消息）');

  // ② 有工具失败 → 保留循环，让她补救（或说明）
  const failed = results.filter((r) => r && (r.isError || r.error));
  if (failed.length) return no('本批有工具失败，保留循环');

  // ③ 她这一批调了"取信息"类工具、但同一批还没发话（send_message 在别的批次）
  //    —— 这种情况 hasSend 已经为 false，上一关就挡掉了；这里不再重复。

  const text = newSent.map((s) => String(s?.text ?? s ?? '')).join('\n');

  // ④ 预告式结尾 → 保留循环（她说了"我去看看"，下一批应当真有后续）
  if (PREVIEW.test(text)) return no('预告式结尾，保留循环');

  // ⑤ 预告要交图/表情/语音，但这一批没交 → 保留循环
  const sentAsset = newSent.some((s) => s?.type === 'image' || s?.type === 'voice' || s?.type === 'record');
  if (PROMISE_ASSET.test(text) && !sentAsset) return no('预告要交东西却没交，保留循环');

  // ⑥ 通过了：这一批已经说完，没有遗留动作
  return { shouldEnd: true, reason: '本批已交付完毕（话已发出、无遗留动作），省掉多余的一轮' };
}
