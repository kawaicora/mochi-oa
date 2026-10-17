<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Node, mergeAttributes } from '@tiptap/core'
import { ref, watch } from 'vue'
import { useAppStore } from '../../stores/app'
import { useServerStore } from '../../stores/server'

/**
 * 自定义 video 节点：官方无扩展，自写一个块级原子节点。
 * 序列化（存入 content / readonly 预览）输出 <video src controls>。
 */
const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      src: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('src'),
        renderHTML: (attrs) => ({ src: attrs.src })
      },
      controls: {
        default: 'controls',
        parseHTML: () => 'controls',
        renderHTML: () => ({ controls: 'controls' })
      }
    }
  },
  parseHTML() {
    return [{ tag: 'video[src]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes), 0]
  }
})

/**
 * 自定义附件节点：文档/文件上传后插入一个可点击下载的链接块。
 * 序列化输出 <a href target=_blank download>文件名</a>（与聊天附件展示一致）。
 */
const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('href'),
        renderHTML: (attrs) => ({ href: attrs.href })
      },
      name: {
        default: '附件',
        parseHTML: (el) => (el as HTMLElement).textContent || '附件',
        renderHTML: (attrs) => ({ 'data-name': attrs.name })
      }
    }
  },
  parseHTML() {
    return [{ tag: 'a[data-rte-attach]' }]
  },
  renderHTML({ HTMLAttributes, node }) {
    // 锚点 + 下载属性，文本为文件名
    return ['a', mergeAttributes({ 'data-rte-attach': '', class: 'rte-attach', target: '_blank', download: '' }, HTMLAttributes), node.attrs.name || '附件']
  }
})

const props = defineProps<{
  modelValue: string
  /** true = 预览/只读渲染模式（不显示工具栏，Tiptap editable:false） */
  readonly?: boolean
  placeholder?: string
}>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const app = useAppStore()
const server = useServerStore()
const uploading = ref(false)
const err = ref('')

const editor = useEditor({
  extensions: [
    StarterKit,
    Image.configure({ inline: false, allowBase64: false }),
    Video,
    Attachment
  ],
  content: props.modelValue || '',
  editable: !props.readonly,
  editorProps: {
    attributes: {
      class: 'rte-body',
      'data-placeholder': props.placeholder || '请输入内容…'
    }
  },
  onUpdate: ({ editor }) => {
    if (props.readonly) return
    // 内容变化 → 对外 emit HTML 字符串
    emit('update:modelValue', editor.getHTML())
  }
})

// 外部值变化（编辑回填 / 只读预览换内容）时同步进编辑器
watch(
  () => props.modelValue,
  (v) => {
    const ed = editor.value
    if (ed && v !== ed.getHTML()) ed.commands.setContent(v || '', { emitUpdate: false })
  }
)
// 只读/编辑切换时切 editable
watch(
  () => props.readonly,
  (ro) => { editor.value?.setEditable(!ro) }
)

/** 选文件 → 复用聊天同一套分块上传 → 拿 url → 插入图片/视频/附件节点。
 *  入口与图标对齐 ChatWindow：图片 far fa-image、视频 far fa-file-video、附件 fas fa-paperclip。 */
async function insertMedia(kind: 'image' | 'video' | 'doc'): Promise<void> {
  const ed = editor.value
  if (!ed || props.readonly) return
  // 与 ChatWindow 一致：图片/视频按类型过滤，附件不限类型
  const filePath = kind === 'doc' ? await window.pantry.pickFile() : await window.pantry.pickFile(kind)
  if (!filePath) return
  uploading.value = true
  err.value = ''
  try {
    // clientId：时间戳+随机串；companyId 取当前公司；第4参 relativePath 空
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const up = await window.pantry.serverUploadChunked(filePath, clientId, app.activeCompanyId || 0, '')
    if (!up.ok || !up.url) {
      console.error('[富文本] 上传失败', up.error)
      err.value = up.error || '上传失败'
      return
    }
    // 上传返回的可能是相对路径（/files/xxx），必须拼上服务端 base URL 成绝对地址后再插入——
    // 否则 <img>/<video> 会按 renderer origin 解析而破图。与聊天图片同一套 absFileUrl。
    const fileUrl = server.absFileUrl(up.url)
    ed.chain().focus()
    if (kind === 'image') ed.chain().focus().setImage({ src: fileUrl }).run()
    else if (kind === 'video') ed.chain().focus().insertContent({ type: 'video', attrs: { src: fileUrl } }).run()
    else ed.chain().focus().insertContent({ type: 'attachment', attrs: { href: fileUrl, name: up.fileName || '附件' } }).run()
  } catch (e) {
    console.error('[富文本] 上传异常', e)
    err.value = '上传异常'
  }
  uploading.value = false
}
</script>

<template>
  <div class="rte" :class="{ readonly: readonly }">
    <!-- 工具栏（仅编辑模式） -->
    <div v-if="!readonly" class="rte-bar">
      <button class="rte-btn" :class="{ on: editor?.isActive('bold') }" title="加粗" @click="editor?.chain().focus().toggleBold().run()"><i class="fas fa-bold"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('italic') }" title="斜体" @click="editor?.chain().focus().toggleItalic().run()"><i class="fas fa-italic"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('strike') }" title="删除线" @click="editor?.chain().focus().toggleStrike().run()"><i class="fas fa-strikethrough"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('heading', { level: 2 }) }" title="标题" @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"><i class="fas fa-heading"></i></button>
      <span class="rte-sep"></span>
      <button class="rte-btn" :class="{ on: editor?.isActive('bulletList') }" title="无序列表" @click="editor?.chain().focus().toggleBulletList().run()"><i class="fas fa-list-ul"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('orderedList') }" title="有序列表" @click="editor?.chain().focus().toggleOrderedList().run()"><i class="fas fa-list-ol"></i></button>
      <span class="rte-sep"></span>
      <!-- 上传入口对齐 ChatWindow：图片 far fa-image / 视频 far fa-file-video / 附件 fas fa-paperclip -->
      <button class="rte-btn" :disabled="uploading" title="插入图片" @click="insertMedia('image')">
        <i :class="uploading ? 'fas fa-spinner fa-spin' : 'far fa-image'"></i>
      </button>
      <button class="rte-btn" :disabled="uploading" title="插入视频" @click="insertMedia('video')">
        <i :class="uploading ? 'fas fa-spinner fa-spin' : 'far fa-file-video'"></i>
      </button>
      <button class="rte-btn" :disabled="uploading" title="插入附件/文档" @click="insertMedia('doc')">
        <i :class="uploading ? 'fas fa-spinner fa-spin' : 'fas fa-paperclip'"></i>
      </button>
      <button class="rte-btn" title="清除格式" @click="editor?.chain().focus().unsetAllMarks().clearNodes().run()"><i class="fas fa-eraser"></i></button>
    </div>
    <!-- 编辑/预览内容区 -->
    <div class="rte-body-wrap">
      <EditorContent :editor="editor" />
      <div v-if="uploading" class="rte-loading"><i class="fas fa-spinner fa-spin"></i>&nbsp;上传中…</div>
    </div>
    <div v-if="err && !readonly" class="rte-err">{{ err }}</div>
  </div>
</template>

<style scoped>
.rte { border: 1px solid var(--dt-border-light); border-radius: 8px; background: #fff; overflow: hidden; }
.rte.readonly { border-color: transparent; background: transparent; }
.rte-bar { display: flex; align-items: center; gap: 2px; padding: 4px 6px; background: #fafbfc; border-bottom: 1px solid var(--dt-border-light); flex-wrap: wrap; }
.rte-btn { border: none; background: transparent; width: 28px; height: 26px; border-radius: 6px; cursor: pointer; color: var(--dt-text-2); font-size: 13px; }
.rte-btn:hover { background: #eef4ff; color: var(--dt-primary); }
.rte-btn.on { background: #e3edff; color: var(--dt-primary); }
.rte-btn:disabled { opacity: .5; cursor: not-allowed; }
.rte-sep { width: 1px; height: 16px; background: var(--dt-border-light); margin: 0 4px; }
.rte-body-wrap { position: relative; }
.rte-body { padding: 10px 12px; min-height: 80px; outline: none; font-size: 14px; line-height: 1.6; }
.rte.readonly .rte-body { padding: 4px 0; min-height: 0; }
.rte-body p { margin: 4px 0; }
.rte-body img { max-width: 100%; border-radius: 6px; }
.rte-body video { max-width: 100%; border-radius: 6px; }
.rte-body h2 { font-size: 16px; font-weight: 700; margin: 8px 0; }
.rte-body ul, .rte-body ol { padding-left: 22px; margin: 4px 0; }
.rte-body a.rte-attach { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: #f0f4ff; color: var(--dt-primary); border-radius: 6px; font-size: 13px; }
.rte-body a.rte-attach::before { content: '\f0c6'; font-family: 'Font Awesome 5 Free'; font-weight: 900; }
.rte-body p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--dt-text-4); float: left; height: 0; pointer-events: none; }
.rte-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.75); color: var(--dt-text-3); font-size: 13px; }
.rte-err { padding: 4px 10px; color: #d92b3a; font-size: 12px; }
</style>
