import { createApp } from 'vue'
import PreviewWindow from './PreviewWindow.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

/**
 * 独立 Office 预览窗口入口。
 * 由 main 进程 openPreviewWindow IPC 打开 preview.html?kind=&path=&name=，
 * 通过 PreviewWindow 壳渲染无边框窗口的自定义标题栏 + 复用 ChatWindow 内嵌的同一套预览组件
 * （standalone 模式去掉弹窗遮罩、占满内容区），不改任何渲染逻辑。
 */
const q = new URLSearchParams(location.search)
const kind = q.get('kind') ?? ''
const path = q.get('path') ?? ''
const name = q.get('name') ?? '预览'
document.title = name

const app = createApp(PreviewWindow, { kind, path, name })
app.mount('#app')
