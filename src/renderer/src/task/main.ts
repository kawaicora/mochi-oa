import { createApp } from 'vue'
import { createPinia } from 'pinia'
import TaskDetailWindow from './TaskDetailWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

try {
  window.pantry?.getBranding?.().then((b) => { document.title = b.name }).catch(() => {})
} catch { /* 忽略 */ }

const app = createApp(TaskDetailWindow)
app.use(createPinia())
app.mount('#app')
