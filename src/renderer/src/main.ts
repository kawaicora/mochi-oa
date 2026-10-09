import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles/base.css'
import './styles/diyu.css'
import '@fortawesome/fontawesome-free/css/all.min.css'

// ---- 品牌标题：软件名一处配置，渲染窗口标题跟随 ----
try {
  window.pantry?.getBranding?.().then((b) => { document.title = b.name }).catch((e) => {
    console.warn('[main] getBranding 失败', e)
  })
} catch (e) { console.warn('[main] 品牌初始化异常', e) }

// ---- 渲染进程全局错误日志：window.onerror / unhandledrejection → 主进程写 renderer-error.log（不再闪现丢失） ----
function safeLog(msg: string): void {
  try {
    if (window.pantry?.logError) window.pantry.logError(msg)
  } catch (e) { console.warn('[main] logError 失败', e) }
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

// ---- 远程设备控制（被控端）：登录后向服务端注册本机，供 web 管理远程查看 ----
// 注意：必须静态 import —— Electron 打包后动态 import('./...') 会报 'a dynamic import undefined'，
// 导致被控端不加载（web 列表看不到本机）。静态加载后仅 init() 订阅登录态，不影响主界面启动。
import RemoteControl from './remote/RemoteControl'
try {
  RemoteControl.init()
} catch (e) {
  console.error('[remote] RemoteControl 初始化失败（被控端将不会注册）', e)
  safeLog('[remote] RemoteControl 初始化失败 ' + (e instanceof Error ? (e.stack || e.message) : String(e)))
}
