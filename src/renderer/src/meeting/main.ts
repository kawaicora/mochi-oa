import { createApp } from 'vue'
import { createPinia } from 'pinia'
import MeetingWindow from './MeetingWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

const app = createApp(MeetingWindow)
app.use(createPinia())
app.mount('#app')
