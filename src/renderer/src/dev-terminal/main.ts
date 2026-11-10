import { createApp } from 'vue'
import TerminalWindow from '../components/TerminalWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'

// 重置 body 默认 margin
document.body.style.margin = '0'
document.body.style.overflow = 'hidden'

function boot(): void {
  const q = new URLSearchParams(window.location.search)
  const deviceId = q.get('deviceId') || ''
  const deviceName = q.get('deviceName') || '远程设备'
  if (!deviceId) {
    document.body.innerHTML = '<div style="padding:40px;color:#9aa0aa;font-size:14px">缺少设备ID</div>'
    return
  }
  const app = createApp(TerminalWindow, { deviceId, deviceName })
  app.mount('#app')
}
boot()
