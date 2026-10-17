<script setup lang="ts">
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { Node, mergeAttributes } from '@tiptap/core'
import { ref, watch } from 'vue'
import { useAppStore } from '../stores/app'

/**
 * 自定义 video 节点：官方无扩展，自写一个块级原子节点。
 * 序列化（存入 content / v-html 展示）输出 <video src controls>。
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
    // 渲染为原生 <video src controls>，无内部 content
    return ['video', mergeAttributes(HTMLAttributes), 0]
  }
})

const props = defineProps<{ modelValue: string; placeholder?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const app = useAppStore()
const uploading = ref(false)
const err = ref('')

const editor = useEditor({
  extensions: [
    StarterKit,
    Image.configure({ inline: false, allowBase64: false }),
    Video
  ],
  content: props.modelValue || '',
  editorProps: {
    attributes: {
      class: 'rte-body',
      'data-placeholder': props.placeholder || '请输入内容…'
    }
  },
  onUpdate: ({ editor }) => {
    // 内容变化 → 对外 emit HTML 字符串
    emit('update:modelValue', editor.getHTML())
  }
})

// 外部值变化（编辑回填 / 清空表单）时同步进编辑器，避免光标跳动（false=不触发 onUpdate）
watch(
  () => props.modelValue,
  (v) => {
    const ed = editor.value
    if (ed && v !== ed.getHTML()) ed.commands.setContent(v || '', { emitUpdate: false })
  }
)

/** 选文件 → 走现成上传链路 → 拿 url → 插入图片/视频节点 */
async function insertMedia(kind: 'image' | 'video'): Promise<void> {
  const ed = editor.value
  if (!ed) return
  const filePath = await window.pantry.pickFile()
  if (!filePath) return
  uploading.value = true
  err.value = ''
  try {
    const ack = await window.pantry.serverUploadFile(filePath, app.activeCompanyId || 0)
    const d = ack.data as { url?: string } | undefined
    if (!ack.ok || !d?.url) {
      console.error('[富文本] 上传失败', ack.error)
      err.value = ack.error || '上传失败'
      return
    }
    ed.chain().focus()
    if (kind === 'image') ed.chain().focus().setImage({ src: d.url }).run()
    else ed.chain().focus().insertContent({ type: 'video', attrs: { src: d.url } }).run()
  } catch (e) {
    console.error('[富文本] 上传异常', e)
    err.value = '上传异常'
  }
  uploading.value = false
}
</script>

<template>
  <div class="rte">
    <!-- 工具栏 -->
    <div class="rte-bar">
      <button class="rte-btn" :class="{ on: editor?.isActive('bold') }" title="加粗" @click="editor?.chain().focus().toggleBold().run()"><i class="fas fa-bold"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('italic') }" title="斜体" @click="editor?.chain().focus().toggleItalic().run()"><i class="fas fa-italic"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('strike') }" title="删除线" @click="editor?.chain().focus().toggleStrike().run()"><i class="fas fa-strikethrough"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('heading', { level: 2 }) }" title="标题" @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"><i class="fas fa-heading"></i></button>
      <span class="rte-sep"></span>
      <button class="rte-btn" :class="{ on: editor?.isActive('bulletList') }" title="无序列表" @click="editor?.chain().focus().toggleBulletList().run()"><i class="fas fa-list-ul"></i></button>
      <button class="rte-btn" :class="{ on: editor?.isActive('orderedList') }" title="有序列表" @click="editor?.chain().focus().toggleOrderedList().run()"><i class="fas fa-list-ol"></i></button>
      <span class="rte-sep"></span>
      <button class="rte-btn" :disabled="uploading" title="插入图片" @click="insertMedia('image')">
        <i :class="uploading ? 'fas fa-spinner fa-spin' : 'far fa-image'"></i>
      </button>
      <button class="rte-btn" :disabled="uploading" title="插入视频" @click="insertMedia('video')">
        <i :class="uploading ? 'fas fa-spinner fa-spin' : 'fas fa-video'"></i>
      </button>
      <button class="rte-btn" title="清除格式" @click="editor?.chain().focus().unsetAllMarks().clearNodes().run()"><i class="fas fa-eraser"></i></button>
    </div>
    <!-- 编辑区 -->
    <div class="rte-body-wrap">
      <EditorContent :editor="editor" />
      <div v-if="uploading" class="rte-loading"><i class="fas fa-spinner fa-spin"></i>&nbsp;上传中…</div>
    </div>
    <div v-if="err" class="rte-err">{{ err }}</div>
  </div>
</template>

<style scoped>
.rte { border: 1px solid var(--dt-border-light); border-radius: 8px; background: #fff; overflow: hidden; }
.rte-bar { display: flex; align-items: center; gap: 2px; padding: 4px 6px; background: #fafbfc; border-bottom: 1px solid var(--dt-border-light); flex-wrap: wrap; }
.rte-btn { border: none; background: transparent; width: 28px; height: 26px; border-radius: 6px; cursor: pointer; color: var(--dt-text-2); font-size: 13px; }
.rte-btn:hover { background: #eef4ff; color: var(--dt-primary); }
.rte-btn.on { background: #e3edff; color: var(--dt-primary); }
.rte-btn:disabled { opacity: .5; cursor: not-allowed; }
.rte-sep { width: 1px; height: 16px; background: var(--dt-border-light); margin: 0 4px; }
.rte-body-wrap { position: relative; }
.rte-body { padding: 10px 12px; min-height: 120px; outline: none; font-size: 14px; line-height: 1.6; }
.rte-body p { margin: 4px 0; }
.rte-body img { max-width: 100%; border-radius: 6px; }
.rte-body video { max-width: 100%; border-radius: 6px; }
.rte-body h2 { font-size: 16px; font-weight: 700; margin: 8px 0; }
.rte-body ul, .rte-body ol { padding-left: 22px; margin: 4px 0; }
.rte-body p.is-editor-empty:first-child::before { content: attr(data-placeholder); color: var(--dt-text-4); float: left; height: 0; pointer-events: none; }
.rte-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.75); color: var(--dt-text-3); font-size: 13px; }
.rte-err { padding: 4px 10px; color: #d92b3a; font-size: 12px; }
</style>
