/**
 * 已读判定的纯逻辑（不碰 DOM，可在 node 下直接跑）。
 *
 * 背景：以前「打开会话」就整段标记已读、在会话里收到消息也立刻标记已读，
 * 对方可能根本没看（窗口在后台、消息还在可视区外），发送方却看到「已读」。
 * 现在只有「消息真的落进消息列表可视区」才算已读，且已读位置单向前进。
 *
 * 组件（ChatWindow.vue）只负责把 IntersectionObserver 的结果喂进来：
 *   可见消息 id 集合 → readPositionToReport(...) → app.markRead(convId, pos)
 */

/** 可视区内的最大消息 id；没有有效 id（空集合 / 本地临时消息 local-xxx）返回 null */
export function maxVisibleId(ids: Iterable<number>): number | null {
  let max = 0
  for (const id of ids) {
    if (Number.isFinite(id) && id > max) max = id
  }
  return max > 0 ? max : null
}

/**
 * 该不该上报、上报到哪一条。
 *
 * 已读位置是单向的：读到第 10 条即前 10 条都读过了，所以只上报可视区内最大的 id。
 * knownPos 是「已知已读位置」（本地已上报过的 + 服务端回执里带回来的），
 * 不超过它就没必要再上报（滚动过程中会反复触发，避免刷接口）。
 * 返回 null 表示不需要上报。
 */
export function readPositionToReport(visibleIds: Iterable<number>, knownPos: number): number | null {
  const max = maxVisibleId(visibleIds)
  if (max == null) return null
  const known = Number.isFinite(knownPos) && knownPos > 0 ? knownPos : 0
  return max > known ? max : null
}

/**
 * 是否贴着底部（≤阈值 px）。新消息到达时用它决定跟不跟随滚动：
 * 不跟随时消息留在可视区外，也就不会变成「已读」。
 */
export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 80): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold
}

/** 回执位置合并：只前进不后退（乱序/重复回执不把「已读」打回「未读」）；null 视为无信息 */
export function mergeReadPosition(prev: number | null | undefined, next: number | null | undefined): number | null {
  const n = next != null && Number.isFinite(next) && next > 0 ? next : null
  if (n == null) return prev ?? null
  if (prev != null && prev > n) return prev
  return n
}
