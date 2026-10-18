/** 代理申请卡片深链：ChatWindow 点击卡片 → 设置 requestId → ProxyView 打开后定位高亮 */
import { ref } from 'vue'

export const proxyDeepLinkId = ref<number | null>(null)
export function setProxyDeepLink(id: number): void {
  proxyDeepLinkId.value = id
  // 通知 MainScreen 切到 proxy tab
  window.dispatchEvent(new CustomEvent('mochi:nav', { detail: 'proxy' }))
}
export function clearProxyDeepLink(): void { proxyDeepLinkId.value = null }
