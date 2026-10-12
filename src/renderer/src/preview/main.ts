import { createApp, h, type Component } from 'vue'
import PdfPreview from '../components/PdfPreview.vue'
import DocxPreview from '../components/DocxPreview.vue'
import SheetPreview from '../components/SheetPreview.vue'
import '@fortawesome/fontawesome-free/css/all.min.css'
import '../styles/base.css'

/**
 * 独立 Office 预览窗口入口。
 * 由 main 进程 openPreviewWindow IPC 打开 preview.html?kind=&path=&name=，
 * 按 kind 复用 ChatWindow 内嵌的同一套预览组件（standalone 模式去掉弹窗遮罩、全屏渲染），
 * 不改任何渲染逻辑；Esc / 关闭按钮触发 window.close() 关闭本窗口。
 */
const q = new URLSearchParams(location.search)
const kind = q.get('kind') ?? ''
const path = q.get('path') ?? ''
const name = q.get('name') ?? '预览'
document.title = name

let comp: Component | null = null
if (kind === 'pdf') comp = PdfPreview
else if (kind === 'word') comp = DocxPreview
else if (kind === 'excel') comp = SheetPreview

const App = {
  render() {
    if (!comp) {
      return h('div', { style: 'padding:40px;color:#888;font-size:14px' }, `未知预览类型：${kind || '(空)'}`)
    }
    return h(comp, { path, name, standalone: true, onClose: () => window.close() })
  },
}

createApp(App).mount('#app')
