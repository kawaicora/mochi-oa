/**
 * 远程控制专用日志：统一前缀 + 节流 + 阶段标记，便于在
 * userData/logs/renderer-console.log 里直接 `grep '[remote]'` 看完整链路。
 *
 * 主进程与渲染进程都会 import 本文件（渲染层 console 会被主进程落盘到同一个文件，
 * 主进程 console 也走同一份 patch，所以两边日志天然排在一起、按时间排序）。
 *
 * 为什么要节流：鼠标移动一秒能来 60+ 条，不节流会把日志冲爆、把真正有用的信息淹掉。
 */

const PREFIX = '[remote]'

/** 节流状态：key → 上次输出时间 */
const throttleAt = new Map<string, number>()

/** 普通日志（生命周期、状态变化、后端选择等，逐条输出） */
export function rlog(scope: string, msg: string, ...rest: unknown[]): void {
  console.log(`${PREFIX}[${scope}] ${msg}`, ...rest)
}

/** 警告（可恢复的问题：降级、重试、权限不足等） */
export function rwarn(scope: string, msg: string, ...rest: unknown[]): void {
  console.warn(`${PREFIX}[${scope}] ${msg}`, ...rest)
}

/** 错误（会话失败、注入失败等） */
export function rerr(scope: string, msg: string, ...rest: unknown[]): void {
  console.error(`${PREFIX}[${scope}] ${msg}`, ...rest)
}

/**
 * 高频日志节流：同一 key 在 intervalMs 内只输出第一条，且把期间被压掉的条数补在后面。
 * 例如 rlogThrottled('move', '鼠标移动', 1000) 一秒最多一条，并显示"（已省略 N 条）"。
 */
const throttleDropped = new Map<string, number>()
export function rlogThrottled(scope: string, key: string, msg: string, intervalMs = 1000, ...rest: unknown[]): void {
  const now = Date.now()
  const last = throttleAt.get(key) ?? 0
  if (now - last < intervalMs) {
    throttleDropped.set(key, (throttleDropped.get(key) ?? 0) + 1)
    return
  }
  throttleAt.set(key, now)
  const dropped = throttleDropped.get(key) ?? 0
  throttleDropped.set(key, 0)
  const suffix = dropped > 0 ? `（已省略 ${dropped} 条同类）` : ''
  console.log(`${PREFIX}[${scope}] ${msg}${suffix}`, ...rest)
}

/** 生成短会话 id，用于把一次远程控制的所有日志串起来 */
let seq = 0
export function newTraceId(kind: string): string {
  seq += 1
  return `${kind}-${seq}-${Date.now().toString(36).slice(-4)}`
}
