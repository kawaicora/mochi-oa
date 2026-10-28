/** 考勤申请卡片深链：ChatWindow 点击卡片 → 设置 requestId → 通知 MainScreen 切到 apply → ApplyHome 打开考勤申请 tab → AttendanceView 定位高亮 */
import { ref } from 'vue'

export const attendanceDeepLinkId = ref<number | null>(null)
export function setAttendanceDeepLink(id: number): void {
  attendanceDeepLinkId.value = id
  // 考勤申请在 ApplyHome 的 attendance tab，统一落到 'apply'（ApplyHome 按本 ref 是否有值决定内层 tab）
  window.dispatchEvent(new CustomEvent('mochi:nav', { detail: 'apply' }))
}
export function clearAttendanceDeepLink(): void { attendanceDeepLinkId.value = null }
