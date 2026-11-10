import { createApp } from 'vue'
import RemotePreview from '../components/RemotePreview.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'

document.body.style.margin = '0'
document.body.style.overflow = 'hidden'

/**
 * 独立远程预览窗口入口。
 * 由 main 进程 openAdminDevPreview IPC 打开 dev-preview.html，
 * 参数从 URL query 读取（deviceId, deviceName）。
 */
function boot(): void {
  const q = new URLSearchParams(window.location.search)
  const deviceId = q.get('deviceId') || ''
  const deviceName = q.get('deviceName') || '远程设备'
  if (!deviceId) {
    document.body.innerHTML = '<div style="padding:40px;color:#9aa0aa;font-size:14px">缺少设备ID</div>'
    return
  }
  const app = createApp(RemotePreview, { deviceId, deviceName })
  app.mount('#app')
}
boot()
