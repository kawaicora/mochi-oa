import { createApp } from 'vue'
import { createPinia } from 'pinia'
import MeetingWindow from './MeetingWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

try {
  window.pantry?.getBranding?.().then((b) => { document.title = b.name }).catch(() => {})
} catch { /* 忽略 */ }

// 主进程日志转发到本窗口控制台
window.pantry?.onMainConsole?.((line) => console.log(line))

const app = createApp(MeetingWindow)
app.use(createPinia())
app.mount('#app')
