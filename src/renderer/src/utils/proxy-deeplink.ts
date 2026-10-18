/** 代理申请卡片深链：ChatWindow 点击卡片 → 设置 requestId → 通知 MainScreen 切到 apply → ApplyHome 打开网络申请 tab → ProxyView 定位高亮 */
import { ref } from 'vue'

export const proxyDeepLinkId = ref<number | null>(null)
export function setProxyDeepLink(id: number): void {
  proxyDeepLinkId.value = id
  // NavTab 无 'proxy'，必须落到 'apply' 才会渲染 ApplyHome；ProxyView 内层 tab 不受影响
  window.dispatchEvent(new CustomEvent('mochi:nav', { detail: 'apply' }))
}
export function clearProxyDeepLink(): void { proxyDeepLinkId.value = null }
