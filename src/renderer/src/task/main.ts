import { createApp } from 'vue'
import { createPinia } from 'pinia'
import TaskDetailWindow from './TaskDetailWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

const app = createApp(TaskDetailWindow)
app.use(createPinia())
app.mount('#app')
