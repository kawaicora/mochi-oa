import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/base.css'
import './styles/diyu.css'
import '@fortawesome/fontawesome-free/css/all.min.css'

// ---- 渲染进程全局错误日志：window.onerror / unhandledrejection → 主进程写 renderer-error.log（不再闪现丢失） ----
function safeLog(msg: string): void {
  try {
    if (window.pantry?.logError) window.pantry.logError(msg)
  } catch { /* 忽略 */ }
}
window.addEventListener('error', (e) => {
  safeLog(`[window.onerror] ${e.message || 'unknown'} @ ${e.filename || ''}:${e.lineno ?? ''}:${e.colno ?? ''}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  safeLog(`[unhandledrejection] ${r instanceof Error ? (r.stack || r.message) : String(r)}`)
})

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
