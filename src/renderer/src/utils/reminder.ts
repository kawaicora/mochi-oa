/**
 * 1 小时未处理审批循环提醒。
 * 维护待审批 id 集合（proxy pending + attendance received pending）。
 * 每 TEST_INTERVAL（默认 60s 便于测试）/ HOUR（3600s 正式）复查一次，
 * 仍 pending → 弹 company 通知（铃声）；状态变化 → 从集合移除。
 */
import { ref } from 'vue'

export const REMINDER_TEST_INTERVAL = 60_000 // 测试用 60s
export const REMINDER_HOUR = 3_600_000

/** 待审批 id 集合（proxy:xxx / attendance:xxx 前缀去重） */
export const pendingIds = ref<Set<string>>(new Set())

let timer: ReturnType<typeof setInterval> | null = null
let onCheck: (() => Promise<void>) | null = null

/** 注册复查回调（外部实现：重新拉 pending 列表，更新 pendingIds，对新增/仍存在的弹通知） */
export function startReminder(check: () => Promise<void>, intervalMs: number = REMINDER_TEST_INTERVAL): void {
  stopReminder()
  onCheck = check
  timer = setInterval(() => { void onCheck?.().catch((e) => console.error('[reminder] 复查异常', e)) }, intervalMs)
}
export function stopReminder(): void {
  if (timer) { clearInterval(timer); timer = null }
  onCheck = null
}
export function addPending(key: string): void { pendingIds.value.add(key) }
export function removePending(key: string): void { pendingIds.value.delete(key) }
export function hasPending(key: string): boolean { return pendingIds.value.has(key) }
