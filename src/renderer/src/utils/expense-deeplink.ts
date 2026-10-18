/** 报销申请卡片深链：ChatWindow 点击卡片 → 设置 requestId → 通知 MainScreen 切到 apply → ApplyHome 打开报销 tab → ExpenseView 定位高亮 */
import { ref } from 'vue'

export const expenseDeepLinkId = ref<number | null>(null)
export function setExpenseDeepLink(id: number): void {
  expenseDeepLinkId.value = id
  // NavTab 无 'expense'，统一落到 'apply'，由 ApplyHome 按本 ref 是否有值决定内层 tab
  window.dispatchEvent(new CustomEvent('mochi:nav', { detail: 'apply' }))
}
export function clearExpenseDeepLink(): void { expenseDeepLinkId.value = null }
