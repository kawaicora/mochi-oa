<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Node, mergeAttributes } from '@tiptap/core'
import { ref, watch, nextTick } from 'vue'
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
      width: {
        default: null,
        parseHTML: (el) => Number(el.getAttribute('width') || (el.style.width || '').replace('px', '')) || null,
        renderHTML: (attrs) => (attrs.width ? { width: String(attrs.width), style: `width:${attrs.width}px` } : {})
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

// 点击图片/视频 → 弹窗看原图（全尺寸，懒加载）
const lightbox = ref<{ src: string; kind: 'image' | 'video' } | null>(null)

const editor = useEditor({
  extensions: [
    StarterKit,
    // 图片节点扩展：加 width 属性（持久化进 HTML，保存/重进/预览保持尺寸）
    Image.configure({ inline: false, allowBase64: false }).extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          width: {
            default: null,
            parseHTML: (el) => Number(el.getAttribute('width') || (el.style.width || '').replace('px', '')) || null,
            renderHTML: (attrs) => (attrs.width ? { width: String(attrs.width), style: `width:${attrs.width}px` } : {})
          }
        }
      }
    }),
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
    // 编辑态单击图片 = 选中节点（不弹窗，走默认选择）；弹窗由 onBodyClick(readonly) / dblclick(edit) 触发
  },
  onUpdate: ({ editor }) => {
    if (props.readonly) return
    emit('update:modelValue', editor.getHTML())
  }
})

watch(
  () => props.modelValue,
  (v) => {
    const ed = editor.value
    if (ed && v !== ed.getHTML()) {
      // 恢复 setContent 前的滚动位置（避免图片缩放等触发重渲染时跳回顶部）
      const wrap = wrapRef.value
      const st = wrap?.scrollTop ?? 0
      ed.commands.setContent(v || '', { emitUpdate: false })
      requestAnimationFrame(() => { if (wrap) wrap.scrollTop = st })
    }
  }
)
watch(
  () => props.readonly,
  (ro) => { editor.value?.setEditable(!ro) }
)

/** 选中图片后调宽度：缩小 / 还原 */
function shrinkImage(): void {
  const ed = editor.value
  if (!ed) return
  const attrs = ed.getAttributes('image')
  const cur = attrs.width ? parseInt(attrs.width, 10) : 0
  ed.chain().focus().updateAttributes('image', { width: Math.max(120, Math.round((cur || 480) * 0.8)) }).run()
}
function resetImageWidth(): void {
  editor.value?.chain().focus().updateAttributes('image', { width: null }).run()
}

/** 选文件 → 复用聊天同一套分块上传 → 拿 url → 插入图片/视频/附件节点。 */
async function insertMedia(kind: 'image' | 'video' | 'doc'): Promise<void> {
  const ed = editor.value
  if (!ed || props.readonly) return
  const filePath = kind === 'doc' ? await window.pantry.pickFile() : await window.pantry.pickFile(kind)
  if (!filePath) return
  uploading.value = true
  err.value = ''
  try {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const up = await window.pantry.serverUploadChunked(filePath, clientId, app.activeCompanyId || 0, '')
    if (!up.ok || !up.url) {
      console.error('[富文本] 上传失败', up.error)
      err.value = up.error || '上传失败'
      return
    }
    // 相对路径拼绝对 URL（与聊天图片一致），否则按 renderer origin 解析会破图
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

// 只读预览：单击图片/视频 → 弹窗看原图。编辑态单击=选中节点，双击=弹窗。
function onBodyClick(e: MouseEvent): void {
  if (!props.readonly) return
  const t = e.target as HTMLElement
  if (t.tagName === 'IMG' && t.getAttribute('src')) {
    lightbox.value = { src: t.getAttribute('src') as string, kind: 'image' }
  } else if (t.tagName === 'VIDEO' && t.getAttribute('src')) {
    lightbox.value = { src: t.getAttribute('src') as string, kind: 'video' }
  }
}
// 编辑态双击图片/视频 → 弹窗看原图
function onBodyDblclick(e: MouseEvent): void {
  if (props.readonly) return
  const t = e.target as HTMLElement
  if (t.tagName === 'IMG' && t.getAttribute('src')) {
    lightbox.value = { src: t.getAttribute('src') as string, kind: 'image' }
  } else if (t.tagName === 'VIDEO' && t.getAttribute('src')) {
    lightbox.value = { src: t.getAttribute('src') as string, kind: 'video' }
  }
}

// ── 图片拖拽缩放手柄：选中图片时在右下角显示手柄，拖动改 width ──
const wrapRef = ref<HTMLElement | null>(null)
const handlePos = ref<{ x: number; y: number } | null>(null) // 手柄相对 wrap 的位置
let dragStartX = 0
let dragStartW = 0
function updateHandle(): void {
  if (props.readonly || !wrapRef.value) { handlePos.value = null; return }
  const sel = wrapRef.value.querySelector('.ProseMirror-selectednode') as HTMLElement | null
  if (!sel || (sel.tagName !== 'IMG' && sel.tagName !== 'VIDEO')) { handlePos.value = null; return }
  const wr = wrapRef.value.getBoundingClientRect()
  const r = sel.getBoundingClientRect()
  handlePos.value = { x: r.right - wr.left, y: r.bottom - wr.top }
}
function onHandleDown(e: MouseEvent): void {
  e.preventDefault()
  e.stopPropagation()
  const ed = editor.value
  if (!ed) return
  dragStartX = e.clientX
  dragStartW = ed.getAttributes('image').width ? parseInt(ed.getAttributes('image').width, 10) : (wrapRef.value?.querySelector('.ProseMirror-selectednode') as HTMLElement)?.getBoundingClientRect().width ?? 300
  const move = (ev: MouseEvent): void => {
    const w = Math.max(120, Math.round(dragStartW + (ev.clientX - dragStartX)))
    ed.chain().focus().updateAttributes('image', { width: w }).run()
    updateHandle()
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    updateHandle()
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
// 选择变化时刷新手柄位置
watch(editor, (ed) => {
  if (!ed) return
  ed.on('selectionUpdate', () => updateHandle())
  ed.on('transaction', () => setTimeout(updateHandle, 0))
})
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
      <button class="rte-btn" title="图片缩小" :disabled="!editor?.isActive('image')" @click="shrinkImage"><i class="fas fa-compress-arrows-alt"></i></button>
      <button class="rte-btn" title="图片原尺寸" :disabled="!editor?.isActive('image')" @click="resetImageWidth"><i class="fas fa-expand"></i></button>
      <span class="rte-sep"></span>
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
    <div ref="wrapRef" class="rte-body-wrap" @click="onBodyClick" @dblclick="onBodyDblclick">
      <EditorContent :editor="editor" />
      <div v-if="uploading" class="rte-loading"><i class="fas fa-spinner fa-spin"></i>&nbsp;上传中…</div>
      <!-- 选中图片拖拽手柄 -->
      <div v-if="handlePos" class="rte-resize-handle" :style="{ left: handlePos.x + 'px', top: handlePos.y + 'px' }" @mousedown="onHandleDown"></div>
    </div>
    <div v-if="err && !readonly" class="rte-err">{{ err }}</div>

    <!-- 点击图片/视频 → 全尺寸查看弹窗 -->
    <div v-if="lightbox" class="rte-lightbox" @click="lightbox = null">
      <div class="rte-lightbox-inner" @click.stop>
        <img v-if="lightbox.kind === 'image'" :src="lightbox.src" alt="" loading="lazy" />
        <video v-else :src="lightbox.src" controls autoplay />
        <div class="rte-lightbox-bar">
          <a :href="lightbox.src" target="_blank" download class="rte-lightbox-dl"><i class="fas fa-download"></i> 打开原图</a>
          <button class="rte-lightbox-close" @click="lightbox = null"><i class="fas fa-times"></i></button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rte { border: 1px solid var(--dt-border-light); border-radius: 8px; background: #fff; overflow: hidden; display: flex; flex-direction: column; flex: 1; min-height: 0; }
.rte.readonly { border-color: transparent; background: transparent; }
.rte-bar { display: flex; align-items: center; gap: 2px; padding: 4px 6px; background: #fafbfc; border-bottom: 1px solid var(--dt-border-light); flex-wrap: wrap; }
.rte-btn { border: none; background: transparent; width: 28px; height: 26px; border-radius: 6px; cursor: pointer; color: var(--dt-text-2); font-size: 13px; }
.rte-btn:hover { background: #eef4ff; color: var(--dt-primary); }
.rte-btn.on { background: #e3edff; color: var(--dt-primary); }
.rte-btn:disabled { opacity: .5; cursor: not-allowed; }
.rte-sep { width: 1px; height: 16px; background: var(--dt-border-light); margin: 0 4px; }
/* 编辑区 flex 自适应占满剩余空间（不再写死 800），内容多时在 wrap 内滚动 */
.rte-body-wrap { position: relative; flex: 1; min-height: 0; overflow-y: auto; }
.rte-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.75); color: var(--dt-text-3); font-size: 13px; }
.rte-err { padding: 4px 10px; color: #d92b3a; font-size: 12px; }
/* 原图查看弹窗 */
.rte-lightbox { position: fixed; inset: 0; background: rgba(0,0,0,.85); z-index: 999; display: flex; align-items: center; justify-content: center; padding: 24px; }
.rte-lightbox-inner { position: relative; max-width: 96vw; max-height: 92vh; display: flex; flex-direction: column; align-items: center; }
.rte-lightbox-inner img, .rte-lightbox-inner video { max-width: 96vw; max-height: 86vh; border-radius: 6px; }
.rte-lightbox-bar { margin-top: 10px; display: flex; gap: 10px; align-items: center; }
.rte-lightbox-dl { color: #fff; background: rgba(255,255,255,.15); padding: 6px 14px; border-radius: 6px; font-size: 13px; text-decoration: none; }
.rte-lightbox-close { background: rgba(255,255,255,.15); border: none; color: #fff; width: 32px; height: 32px; border-radius: 50%; cursor: pointer; }
/* 选中图片右下角拖拽手柄 */
.rte-resize-handle { position: absolute; width: 12px; height: 12px; background: var(--dt-primary); border: 2px solid #fff; border-radius: 3px; cursor: ew-resize; transform: translate(-50%, -50%); box-shadow: 0 1px 4px rgba(0,0,0,.3); z-index: 5; }
</style>

<!--
  Tiptap 运行时创建的 .ProseMirror(.rte-body) 节点没有 Vue scoped data-v-xxx 属性，
  scoped 选择器永不匹配。因此 .rte-body 及其排版规则必须放在【非 scoped】块里。
  用 .rte 前缀避免污染全局。
-->
<style>
.rte .rte-body { padding: 10px 12px; min-height: 200px; outline: none; font-size: 14px; line-height: 1.6; }
.rte.readonly .rte-body { padding: 4px 0; min-height: 0; }
.rte .rte-body p { margin: 4px 0; }
.rte .rte-body img { max-width: 100%; border-radius: 6px; cursor: zoom-in; }
.rte .rte-body video { max-width: 100%; border-radius: 6px; }
.rte .rte-body h2 { font-size: 16px; font-weight: 700; margin: 8px 0; }
.rte .rte-body ul, .rte .rte-body ol { padding-left: 22px; margin: 4px 0; }
.rte .rte-body a.rte-attach { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; background: #f0f4ff; color: var(--dt-primary); border-radius: 6px; font-size: 13px; }
.rte .rte-body a.rte-attach::before { content: '\f0c6'; font-family: 'Font Awesome 5 Free'; font-weight: 900; }
.rte .rte-body p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--dt-text-4); float: left; height: 0; pointer-events: none; }
</style>
