import { createApp } from 'vue'
import ToolbarWindow from './ToolbarWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

const app = createApp(ToolbarWindow)
app.mount('#app')
