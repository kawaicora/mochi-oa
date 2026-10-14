<script setup lang="ts">
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import { useRtcStore } from '../stores/rtc'
import ModelPreview from './ModelPreview.vue'
import MediaPreview from './MediaPreview.vue'
import GroupSettings from './GroupSettings.vue'
import MsgVideo from './MsgVideo.vue'
import MsgAudio from './MsgAudio.vue'
import UserAvatar from './UserAvatar.vue'
import type { ServerChatMessage } from '@shared/server-types'

const app = useAppStore()
const server = useServerStore()
const rtc = useRtcStore()

const draft = ref('')
const sending = ref(false)
const showMembers = ref(false)
const showMsgMenu = ref<{ id: string; x: number; y: number } | null>(null)
const showEmoji = ref(false)
const dlToast = ref('')
let dlToastTimer: ReturnType<typeof setTimeout> | undefined
function flashToast(msg: string): void {
  dlToast.value = msg
  if (dlToastTimer) clearTimeout(dlToastTimer)
  dlToastTimer = setTimeout(() => { dlToast.value = '' }, 6000)
}

/**
 * 下载到本地的进度卡片。
 * 右键「下载 / 打开文件所在路径 / 预览」在缓存未命中时都要先把文件从服务端拉下来，
 * 大文件要好几秒到几十秒；不给进度的话界面毫无反应，会被当成点了没反应的 bug。
 * 只显示「本次操作发起的那一个下载」（按 url 匹配），后台自动下载不打扰界面。
 */
const dlProgress = ref<{ url: string; name: string; received: number; total: number; percent: number } | null>(null)

/** 标记开始下载（返回 true 表示需要显示进度卡片） */
function beginDownload(url: string, name: string): void {
  dlProgress.value = { url, name, received: 0, total: 0, percent: -1 }
}
function endDownload(): void {
  dlProgress.value = null
}
function dlPercentText(): string {
  const p = dlProgress.value
  if (!p) return ''
  if (p.percent < 0) return p.received > 0 ? `${fmtSize(p.received)}（大小未知）` : '正在连接…'
  return `${p.percent}% · ${fmtSize(p.received)}${p.total > 0 ? ' / ' + fmtSize(p.total) : ''}`
}
function fmtSize(n: number): string {
  if (!n || n < 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}
// 订阅主进程的下载进度：只更新「本次操作发起的那一个下载」，后台自动下载不打扰界面
const offDownloadProgress = window.pantry.onDownloadProgress((d) => {
  const cur = dlProgress.value
  if (!cur || cur.url !== d.url) return
  cur.received = d.received
  cur.total = d.total
  cur.percent = d.percent
})
onBeforeUnmount(() => { offDownloadProgress() })

const selected = computed(() => app.selected)
const myId = computed(() => server.state.userId)

// 群成员弹窗数据
const groupMembers = ref<Array<{ userId: number; nick?: string; avatar?: string; online?: boolean; role: string }>>([])

watch(
  () => app.messages.length,
  async () => {
    await nextTick()
    scrollBottom()
  }
)
watch(
  () => selected.value?.conversationId,
  async () => {
    showMembers.value = false
    showMsgMenu.value = null
    showEmoji.value = false
    await nextTick()
    scrollBottom()
  }
)

const msgListEl = ref<HTMLElement | null>(null)
function scrollBottom(): void {
  if (msgListEl.value) msgListEl.value.scrollTop = msgListEl.value.scrollHeight
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 消息已读回执标记：仅自己发出的消息；私聊=对方是否已读，群聊=已读人数 */
function readLabelOf(m: ServerChatMessage): string {
  const sel = selected.value
  if (!sel || m.fromId !== myId.value) return ''
  const id = Number(m.id)
  if (!Number.isFinite(id)) return ''
  const receipts = sel.readReceipts ?? []
  if (sel.kind === 'dm') {
    const peer = receipts.find((r) => r.userId !== myId.value)
    return peer && peer.lastReadMessageId && peer.lastReadMessageId >= id ? '已读' : '未读'
  }
  let n = 0
  for (const r of receipts) {
    if (r.userId !== myId.value && r.lastReadMessageId && r.lastReadMessageId >= id) n++
  }
  return n > 0 ? `已读 ${n}` : ''
}

async function onSend(): Promise<void> {
  if (!draft.value.trim() || sending.value) return
  sending.value = true
  const text = draft.value
  draft.value = ''
  await app.sendText(text)
  sending.value = false
}

async function onPickFile(): Promise<void> {
  const path = await window.pantry.pickFile()
  if (!path) return
  sending.value = true
  try {
    await app.sendFile(path)
  } finally {
    sending.value = false
  }
}

async function onPickImage(): Promise<void> {
  const path = await window.pantry.pickFile('image')
  if (!path) return
  sending.value = true
  try {
    await app.sendFile(path)
  } finally {
    sending.value = false
  }
}

async function onPickVideo(): Promise<void> {
  const path = await window.pantry.pickFile('video')
  if (!path) return
  sending.value = true
  try {
    await app.sendFile(path)
  } finally {
    sending.value = false
  }
}

async function onPickAudio(): Promise<void> {
  const path = await window.pantry.pickFile('audio')
  if (!path) return
  sending.value = true
  try {
    await app.sendFile(path)
  } finally {
    sending.value = false
  }
}

async function onScreenshot(): Promise<void> {
  if (sending.value) return
  const shot = await window.pantry.captureScreen()
  if (!shot) {
    flashToast('截屏失败')
    return
  }
  // 打开独立全屏截屏窗口；保存后主进程会回传临时 PNG 路径，由下方监听发送
  await window.pantry.openScreenshotWindow({ dataUrl: shot.dataUrl, width: shot.width, height: shot.height })
}
// 独立截屏窗口保存完成 → 把临时 PNG 发送到当前会话
onMounted(() => {
  window.pantry.onScreenshotSaved(async (path) => {
    if (!path || sending.value) return
    sending.value = true
    try {
      await app.sendFile(path)
    } finally {
      sending.value = false
    }
  })
})

// ─── 拖放上传 ───
/** 是否正处于拖放悬停状态（用于显示投放遮罩） */
const dragActive = ref(false)
/** dragenter/dragleave 会在子元素间反复触发，用计数器避免遮罩闪烁 */
let dragDepth = 0

interface DropItem {
  path: string
  isDir: boolean
  name: string
}

/** 拖拽内容里是否含文件（拖动选中文字时 types 不含 Files） */
function dragHasFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  return Array.prototype.indexOf.call(types, 'Files') >= 0
}

function onDragEnter(e: DragEvent): void {
  if (!selected.value || !dragHasFiles(e)) return
  e.preventDefault()
  dragDepth += 1
  dragActive.value = true
}

function onDragOver(e: DragEvent): void {
  if (!selected.value || !dragHasFiles(e)) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  if (!dragActive.value) dragActive.value = true
}

function onDragLeave(e: DragEvent): void {
  if (!dragActive.value) return
  e.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragActive.value = false
}

/** 从拖放事件收集待发送项：文件取绝对路径，文件夹标记出来交给 sendFolder */
function collectDropItems(e: DragEvent): DropItem[] {
  const dt = e.dataTransfer
  if (!dt) return []
  const files = Array.from(dt.files ?? [])
  if (files.length === 0) return []
  // File 对象拿不到 isDirectory，用 webkitGetAsEntry 判断（与 files 顺序一一对应）
  const dirFlags: boolean[] = []
  const items = dt.items ? Array.from(dt.items) : []
  for (let i = 0; i < files.length; i++) {
    let isDir = false
    const it = items[i]
    if (it && it.kind === 'file' && typeof it.webkitGetAsEntry === 'function') {
      try {
        isDir = it.webkitGetAsEntry()?.isDirectory === true
      } catch {
        isDir = false
      }
    }
    dirFlags.push(isDir)
  }
  const out: DropItem[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    // pathForFile 应返回字符串；类型不符时回退到旧版 File.path，避免把对象当成路径
    let path = ''
    try {
      const r = window.pantry.pathForFile(f)
      if (typeof r === 'string') path = r
    } catch {
      path = ''
    }
    if (!path) {
      const legacy = (f as File & { path?: string }).path
      if (typeof legacy === 'string') path = legacy
    }
    if (!path) continue
    out.push({ path, isDir: dirFlags[i] === true, name: f.name })
  }
  return out
}

async function onDrop(e: DragEvent): Promise<void> {
  if (dragActive.value) e.preventDefault()
  dragDepth = 0
  dragActive.value = false
  if (!selected.value || sending.value) return
  e.preventDefault()
  const items = collectDropItems(e)
  if (items.length === 0) {
    flashToast('未识别到可发送的文件')
    return
  }
  sending.value = true
  try {
    for (const it of items) {
      // 文件夹走 sendFolder（整目录打包上传），文件走 sendFile
      if (it.isDir) await app.sendFolder(it.path)
      else await app.sendFile(it.path)
    }
  } finally {
    sending.value = false
  }
}

/** 拖到聊天区以外时阻止 Electron 默认「打开该文件」的导航行为 */
function preventWindowDrop(e: DragEvent): void {
  if (!dragHasFiles(e)) return
  e.preventDefault()
  if (e.type === 'drop') {
    dragDepth = 0
    dragActive.value = false
  }
}

onMounted(() => {
  window.addEventListener('dragover', preventWindowDrop)
  window.addEventListener('drop', preventWindowDrop)
})
onBeforeUnmount(() => {
  window.removeEventListener('dragover', preventWindowDrop)
  window.removeEventListener('drop', preventWindowDrop)
})

const emojiList = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😜', '🤔', '😭', '😅', '😇', '🙃', '😎', '🤩', '🥳', '😴', '🤯', '🥺', '😤',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '🤞', '👀', '❤️', '💔', '🎉', '🎊', '🔥', '✨', '⭐', '🌈', '🍺', '☕', '🍰',
  '💯', '✅', '❌', '⚠️', '🚀', '🐱', '🐶', '🌹', '🍀', '🎈'
]
function insertEmoji(e: string): void {
  draft.value += e
  showEmoji.value = false
}

async function loadMembers(): Promise<void> {
  if (!selected.value?.groupId) return
  const ack = await window.pantry.serverGroupMembers(selected.value.groupId)
  const ms = (ack.data as { members?: Array<{ userId: number; nick?: string; avatar?: string; online?: boolean; role: string }> } | undefined)?.members
  if (ack.ok && ms) groupMembers.value = ms
  showMembers.value = true
}

async function onPin(): Promise<void> {
  if (!selected.value || selected.value.conversationId <= 0) return
  await app.togglePin(selected.value.conversationId, !selected.value.pinned)
}

function startDmVideo(): void {
  if (selected.value?.dmUserId) void rtc.startDmCall(selected.value.dmUserId, 'video')
}
// 远程控制：主叫发起；对方设了密码 → 弹密码输入框重试
const remotePwOpen = ref(false)
const remotePw = ref('')
const remoteReqUserId = ref(0)
async function startDmRemote(): Promise<void> {
  if (!selected.value?.dmUserId) return
  const id = selected.value.dmUserId
  try {
    const r = await rtc.startDmCall(id, 'remote')
    if (r.needPassword) {
      remoteReqUserId.value = id
      remotePw.value = ''
      remotePwOpen.value = true
    } else if (rtc.error) {
      flashToast(rtc.error)
    }
  } catch (e) {
    console.error('[chat] 发起远程控制失败', e)
    flashToast(String(e))
  }
}
async function submitRemotePw(): Promise<void> {
  const id = remoteReqUserId.value
  const pw = remotePw.value
  remotePwOpen.value = false
  try {
    const r = await rtc.startDmCall(id, 'remote', pw)
    if (r.needPassword) {
      remotePw.value = ''
      remotePwOpen.value = true
    } else if (rtc.error) {
      flashToast(rtc.error)
    }
  } catch (e) {
    console.error('[chat] 提交远程控制密码失败', e)
    flashToast(String(e))
  }
}
function startGroupVoice(): void {
  if (selected.value?.groupId) void rtc.startGroupCall(selected.value.groupId, 'voice')
}
function startGroupVideo(): void {
  if (selected.value?.groupId) void rtc.startGroupCall(selected.value.groupId, 'video')
}

function openMsgMenu(e: MouseEvent, id: string): void {
  e.preventDefault()
  showMsgMenu.value = { id, x: e.clientX, y: e.clientY }
}

function closeMsgMenu(): void {
  showMsgMenu.value = null
  showEmoji.value = false
}

async function onDelete(messageId: string): Promise<void> {
  closeMsgMenu()
  await app.deleteMessage(messageId)
}


/** 当前右键菜单对应的消息 */
const menuMsg = computed(() => (showMsgMenu.value ? app.messages.find((x) => x.id === showMsgMenu.value!.id) : undefined))

/** 下载当前右键文件/文件夹到配置的下载目录 */
async function onDownload(): Promise<void> {
  const id = showMsgMenu.value?.id
  closeMsgMenu()
  if (!id) return
  const m = app.messages.find((x) => x.id === id)
  if (!m) return
  // 自动下载开关开着时收到即已下载到本地；避免右键重复下载（不生成 xxx (1) 副本）
  if (m.kind !== 'folder' && app.localCache[id]?.path) {
    flashToast(`已下载 → ${app.localCache[id]!.path}`)
    return
  }
  if (m.kind === 'folder') {
    const r = await app.downloadFolder(m.content)
    if (r.ok) flashToast(`已下载 ${r.count ?? 0} 个文件 → ${r.destDir}`)
    else flashToast(`下载失败：${r.error || '未知错误'}`)
  } else {
    // 需用绝对 URL（相对 /files/... 传下载接口会报 Invalid URL）
    const url = server.absFileUrl(m.content)
    beginDownload(url, fileNameOf(m.content))
    const r = await window.pantry.serverDownloadFile(url)
    endDownload()
    if (r.ok && r.path) flashToast(`已下载 → ${r.path}`)
    else flashToast(`下载失败：${r.error || '未知错误'}`)
  }
}

/** 打开本地文件所在路径（视频/图片/文件/3D/文件夹） */
async function onOpenFileLocation(): Promise<void> {
  const id = showMsgMenu.value?.id
  closeMsgMenu()
  if (!id) return
  const m = app.messages.find((x) => x.id === id)
  if (!m) return
  let path = app.localCache[id]?.path
  if (!path) {
    if (m.kind === 'folder') {
      const r = await app.downloadFolder(m.content)
      if (r.ok && r.destDir) path = r.destDir
    } else {
      const url = server.absFileUrl(m.content)
      beginDownload(url, fileNameOf(m.content))
      const r = await window.pantry.serverDownloadFile(url)
      endDownload()
      if (r.ok && r.path) path = r.path
    }
  }
  if (!path) {
    flashToast('未找到本地文件，请先下载')
    return
  }
  await window.pantry.openFileLocation(path)
}

function fileNameOf(url: string): string {
  const seg = url.split('/').pop() || ''
  return decodeURIComponent(seg)
}

function isImageUrl(url: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(url)
}


/** 文件类型图标（Font Awesome），供文件消息/上传卡片使用 */
function fileIcon(url: string): string {
  const n = url.toLowerCase()
  if (/\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(n)) return 'fas fa-file-image'
  if (/\.(mp4|webm|mov|mkv|avi|m4v|flv)(\?|$)/i.test(n)) return 'fas fa-file-video'
  if (/\.pdf(\?|$)/i.test(n)) return 'fas fa-file-pdf'
  if (/\.docx?(\?|$)/i.test(n)) return 'fas fa-file-word'
  if (/\.(xlsx?|csv)(\?|$)/i.test(n)) return 'fas fa-file-excel'
  if (/\.pptx?(\?|$)/i.test(n)) return 'fas fa-file-powerpoint'
  if (/\.(zip|rar|7z|tar|gz)(\?|$)/i.test(n)) return 'fas fa-file-archive'
  if (/\.(mp3|wav|flac|aac|ogg|m4a)(\?|$)/i.test(n)) return 'fas fa-file-audio'
  return 'fas fa-file'
}

async function onPickFolder(): Promise<void> {
  const path = await window.pantry.pickFolder()
  if (!path) return
  sending.value = true
  try {
    await app.sendFolder(path)
  } finally {
    sending.value = false
  }
}

/** 文件夹名：取文件夹相对路径（如 6/p20260921_merge）最后一段 */
function folderNameOf(content: string): string {
  return decodeURIComponent(content.split('/').pop() || '文件夹')
}

/** 下载整个文件夹到配置目录（默认 Documents/麻薯） */
async function onDownloadFolder(m: { content: string }): Promise<void> {
  const r = await app.downloadFolder(m.content)
  if (r.ok) flashToast(`已下载 ${r.count ?? 0} 个文件 → ${r.destDir}`)
  else flashToast(`下载失败：${r.error || '未知错误'}`)
}

// ─── 本地预览（自动下载） + 3D 模型预览 ───

/** 3D 模型扩展名（FBX/OBJ/GLTF/GLB/STL/DAE） */
function is3dModelUrl(url: string): boolean {
  return /\.(fbx|obj|stl|glb|gltf|dae)(\?|$)/i.test(url)
}

/** 聊天内可预览的 Office 文档类型 */
type OfficePreviewKind = 'pdf' | 'word' | 'excel'

/** 按扩展名判断可预览类型：PDF / Word(.docx) / Excel(.xlsx/.xls/.csv)；旧版二进制 .doc 不支持 */
function officePreviewKind(url: string): OfficePreviewKind | null {
  if (/\.pdf(\?|$)/i.test(url)) return 'pdf'
  if (/\.docx(\?|$)/i.test(url)) return 'word'
  if (/\.(xlsx|xls|csv)(\?|$)/i.test(url)) return 'excel'
  return null
}

/** 取消息对应的本地绝对路径：优先自动下载缓存，其次按需下载（失败返回 null） */
async function ensureLocalPath(m: { content: string; id: string }): Promise<string | null> {
  const cached = app.localCache[m.id]?.path
  if (cached) return cached
  // 需用绝对 URL（相对 /files/... 传下载接口会报 Invalid URL）
  const url = server.absFileUrl(m.content)
  beginDownload(url, fileNameOf(m.content))
  const r = await window.pantry.serverDownloadFile(url)
  endDownload()
  return r.ok && r.path ? r.path : null
}

/** 3D 预览弹窗 */
const previewModel = ref<{ path: string; name: string } | null>(null)
/** 单独窗口预览：图片大图 / 视频全屏播放 */
const previewMedia = ref<{ kind: 'image' | 'video'; m: ServerChatMessage } | null>(null)

async function openModelPreview(m: { content: string; id: string }): Promise<void> {
  const path = await ensureLocalPath(m)
  if (!path) {
    flashToast('模型文件下载失败')
    return
  }
  previewModel.value = { path, name: fileNameOf(m.content) }
}

/** 打开聊天内 Office 文档预览（PDF / Word / Excel）：按需下载到本地后交给独立预览窗口（复用同一套预览组件） */
async function openOfficePreview(m: { content: string; id: string }): Promise<void> {
  const kind = officePreviewKind(m.content)
  if (!kind) return
  const label = kind === 'pdf' ? 'PDF' : kind === 'word' ? 'Word' : 'Excel'
  const path = await ensureLocalPath(m)
  if (!path) {
    flashToast(`${label} 文件下载失败`)
    return
  }
  const r = await window.pantry.openPreviewWindow({ kind, path, name: fileNameOf(m.content) })
  if (!r.ok) flashToast(r.error || `${label} 预览窗口打开失败`)
}
</script>

<template>
  <section
    class="chat-panel"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 拖放投放遮罩 -->
    <div v-if="dragActive" class="drop-mask">
      <div class="drop-box">
        <i class="fas fa-cloud-upload-alt"></i>
        <p>松手即可发送到「{{ selected?.name }}」</p>
        <span>支持文件与文件夹，可一次拖入多个</span>
      </div>
    </div>

    <!-- 空态 -->
    <template v-if="!selected">
      <div class="chat-empty">
        <i class="far fa-comments"></i>
        <p>选择一个会话开始聊天</p>
      </div>
    </template>

    <template v-else>
      <!-- 会话头部 -->
      <header class="chat-head">
        <div class="chat-title">{{ selected.name }}</div>
        <div class="chat-actions">
          <button v-if="selected.kind === 'group' && selected.groupId" class="chat-act" title="群设置" @click="app.openGroupSettings(selected.groupId!, selected.name)">
            <i class="fas fa-cog"></i>
          </button>
          <button v-if="selected.kind === 'dm' && selected.dmUserId" class="chat-act" title="通话" @click="startDmVideo">
            <i class="fas fa-video"></i>
          </button>
          <button v-if="selected.kind === 'dm' && selected.dmUserId" class="chat-act" title="远程控制" @click="startDmRemote">
            <i class="fas fa-desktop"></i>
          </button>
          <button v-if="selected.kind === 'group' && selected.groupId" class="chat-act" title="通话" @click="startGroupVideo">
            <i class="fas fa-video"></i>
          </button>
          <button v-if="selected.kind === 'group'" class="chat-act" title="群成员" @click="loadMembers">
            <i class="fas fa-users"></i>
          </button>
          <button v-if="selected.conversationId > 0" class="chat-act" :class="{ on: selected.pinned }" title="置顶" @click="onPin">
            <i class="fas fa-thumbtack"></i>
          </button>
        </div>
      </header>

      <!-- 消息列表 -->
      <div ref="msgListEl" class="chat-list" @click="closeMsgMenu">
        <div v-for="m in app.messages" :key="m.id" class="msg-row" :class="{ me: m.fromId === myId }">
          <UserAvatar :nick="m.nick" :avatar="m.avatar" :size="36" />
          <div class="msg-body">
            <div class="msg-meta">
              <span class="msg-nick">{{ m.fromId === myId ? '我' : m.nick || '' }}</span>
              <span class="msg-time">{{ fmtTime(m.ts) }}</span>
              <span v-if="m.fromId === myId && readLabelOf(m)" class="msg-read" :class="{ unread: readLabelOf(m) === '未读' }">{{ readLabelOf(m) }}</span>
            </div>
            <div class="msg-bubble" @contextmenu.prevent="openMsgMenu($event, m.id)">
              <span v-if="m.kind === 'text'">{{ m.content }}</span>
              <!-- 视频：FLV 走 flv.js；rm/avi/mkv/3gp/rmvb 走服务端 ffmpeg 转码；其余原生 Blob 播放 -->
              <MsgVideo
                v-else-if="m.kind === 'video'"
                :src="app.localPreviewUrl(m)"
                :path="app.localCache[m.id]?.path"
                :content="m.content"
                :name="m.content"
                :server-url="server.settings.serverUrl"
              />
              <img v-else-if="m.kind === 'image' && isImageUrl(m.content)" :src="app.localPreviewUrl(m)" class="msg-img" @error="app.fallbackPreview(m)" @click="previewMedia = { kind: 'image', m }" />
              <!-- 音频：内联播放控件 -->
              <MsgAudio v-else-if="m.kind === 'audio'" :m="m" />
              <!-- 文件：3D 模型 / Office 文档（PDF、Word、Excel）显示预览按钮，否则普通文件链接 -->
              <template v-else-if="m.kind === 'file' || m.kind === 'image'">
                <div v-if="m.kind === 'file' && is3dModelUrl(m.content)" class="msg-model">
                  <i class="fas fa-cube msg-model-icon"></i>
                  <span class="msg-model-name" :title="fileNameOf(m.content)">{{ fileNameOf(m.content) }}</span>
                  <button class="msg-folder-dl" @click="openModelPreview(m)">
                    <i class="fas fa-cube"></i>&nbsp;3D 预览
                  </button>
                </div>
                <div v-else-if="m.kind === 'file' && officePreviewKind(m.content)" class="msg-model">
                  <i :class="[fileIcon(m.content), 'msg-model-icon', 'msg-office-' + officePreviewKind(m.content)]"></i>
                  <span class="msg-model-name" :title="fileNameOf(m.content)">{{ fileNameOf(m.content) }}</span>
                  <button class="msg-folder-dl" @click="openOfficePreview(m)">
                    <i class="far fa-eye"></i>&nbsp;预览
                  </button>
                </div>
                <a v-else :href="app.localPreviewUrl(m)" target="_blank" class="msg-file">
                  <i :class="fileIcon(m.content)"></i>&nbsp;{{ fileNameOf(m.content) }}
                </a>
              </template>
              <div v-else-if="m.kind === 'folder'" class="msg-folder">
                <i class="fas fa-folder msg-folder-icon"></i>
                <span class="msg-folder-name" :title="m.content">{{ folderNameOf(m.content) }}</span>
                <button v-if="m.fromId !== myId" class="msg-folder-dl" @click="onDownloadFolder(m)">
                  <i class="fas fa-download"></i>&nbsp;下载
                </button>
              </div>
            </div>
          </div>
        </div>
        <div v-if="app.messages.length === 0" class="chat-none">暂无消息，发一条吧</div>
      </div>

      <!-- 输入区 -->
      <div class="chat-input-wrap">
        <!-- 上传/发送中卡片（圆圈进度 + 中间百分比 + 文件/文件夹图标） -->
        <div v-if="app.pendingUploads.length" class="up-list">
          <div v-for="p in app.pendingUploads" :key="p.clientId" class="up-card" :class="{ 'up-card-err': p.error }">
            <template v-if="!p.error">
              <i :class="p.kind === 'folder' ? 'fas fa-folder up-folder' : fileIcon(p.fileName || 'a.bin')"></i>
              <span class="up-name" :title="p.fileName">{{ p.fileName }}</span>
              <div class="up-ring" :style="{ background: `conic-gradient(var(--dt-primary) ${p.percent * 3.6}deg, #e6e9ee 0deg)` }">
                <span class="up-ring-inner">{{ p.percent }}%</span>
              </div>
            </template>
            <template v-else>
              <i class="fas fa-exclamation-triangle"></i>
              <span class="up-name up-err-text" :title="p.error">{{ p.fileName }}：{{ p.error }}</span>
            </template>
          </div>
        </div>
        <div class="chat-toolbar">
          <button class="chat-tool" title="表情" @click="showEmoji = !showEmoji"><i class="far fa-smile"></i></button>
          <button class="chat-tool" title="发送图片" @click="onPickImage"><i class="far fa-image"></i></button>
          <button class="chat-tool" title="发送视频" @click="onPickVideo"><i class="far fa-file-video"></i></button>
          <button class="chat-tool" title="发送音频" @click="onPickAudio"><i class="far fa-file-audio"></i></button>
          <button class="chat-tool" title="截屏发送" @click="onScreenshot"><i class="far fa-camera"></i></button>
          <button class="chat-tool" title="发送文件" @click="onPickFile"><i class="far fa-paperclip"></i></button>
          <button class="chat-tool" title="发送文件夹" @click="onPickFolder"><i class="far fa-folder-open"></i></button>
        </div>
        <div v-if="showEmoji" class="emoji-panel">
          <button v-for="e in emojiList" :key="e" class="emoji-item" @click="insertEmoji(e)">{{ e }}</button>
        </div>
        <textarea
          v-model="draft"
          class="chat-textarea"
          placeholder="输入消息，Enter 发送"
          @keydown.enter.exact.prevent="onSend"
        ></textarea>
        <div class="chat-send-row">
          <button class="chat-send" :disabled="!draft.trim() || sending" @click="onSend">
            {{ sending ? '发送中…' : '发送' }}
          </button>
        </div>
      </div>
    </template>

    <!-- 群成员弹窗 -->
    <div v-if="showMembers" class="modal-mask" @click.self="showMembers = false">
      <div class="modal members-modal">
        <div class="modal-head">
          <span>群成员（{{ groupMembers.length }}）</span>
          <button class="modal-x" @click="showMembers = false"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body members-body">
          <div v-for="mem in groupMembers" :key="mem.userId" class="member-row">
            <UserAvatar :nick="mem.nick" :avatar="mem.avatar" :size="34" />
            <span class="member-name">{{ mem.nick || mem.userId }}</span>
            <span v-if="mem.role === 'owner'" class="member-tag">群主</span>
            <span class="member-online" :class="{ off: !mem.online }">{{ mem.online ? '在线' : '离线' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- 消息右键菜单 -->
    <div v-if="showMsgMenu" class="ctx-menu" :style="{ left: showMsgMenu.x + 'px', top: showMsgMenu.y + 'px' }">
      <button v-if="menuMsg && menuMsg.kind !== 'text'" class="ctx-item" @click="onDownload"><i class="fas fa-download"></i> 下载</button>
      <button v-if="menuMsg && menuMsg.kind !== 'text'" class="ctx-item" @click="onOpenFileLocation"><i class="far fa-folder-open"></i> 打开文件所在路径</button>
      <button class="ctx-item" @click="onDelete(showMsgMenu!.id)"><i class="far fa-trash-alt"></i> 撤回消息</button>
    </div>

    <!-- 下载进度卡片：大文件下载期间给出明确反馈，避免"点了没反应"的错觉 -->
    <div v-if="dlProgress" class="dl-progress">
      <div class="dl-progress-name">
        <i class="fas fa-download"></i>&nbsp;正在下载 {{ dlProgress.name }}
      </div>
      <div class="dl-progress-bar">
        <div
          class="dl-progress-fill"
          :class="{ indet: dlProgress.percent < 0 }"
          :style="dlProgress.percent >= 0 ? { width: dlProgress.percent + '%' } : undefined"
        ></div>
      </div>
      <div class="dl-progress-meta">{{ dlPercentText() }}<span class="dl-progress-hint">下载完成后自动继续</span></div>
    </div>

    <!-- 下载结果提示 -->
    <div v-if="dlToast" class="dl-toast">{{ dlToast }}</div>

    <!-- 远程控制密码输入（对方设置了远程控制密码） -->
    <Teleport to="body">
      <div v-if="remotePwOpen" class="remote-pw-overlay" @click.self="remotePwOpen = false">
        <div class="remote-pw-box">
          <div class="remote-pw-title"><i class="fas fa-desktop"></i> 远程控制</div>
          <div class="remote-pw-desc">对方设置了远程控制密码，请输入后继续：</div>
          <input v-model="remotePw" class="remote-pw-input" type="password" placeholder="远程控制密码" @keydown.enter="submitRemotePw" autofocus />
          <div class="remote-pw-actions">
            <button class="remote-pw-cancel" @click="remotePwOpen = false">取消</button>
            <button class="remote-pw-ok" @click="submitRemotePw">确认连接</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 3D 模型预览 -->
    <ModelPreview v-if="previewModel" :path="previewModel.path" :name="previewModel.name" @close="previewModel = null" />

    <!-- 图片/视频单独预览 -->
    <MediaPreview v-if="previewMedia" :kind="previewMedia.kind" :m="previewMedia.m" @close="previewMedia = null" />

    <!-- 群设置 -->
    <GroupSettings v-if="app.groupSettingsOpen" />
  </section>
</template>

<style scoped>
.remote-pw-overlay {
  position: fixed;
  inset: 0;
  z-index: 9990;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
}
.remote-pw-box {
  background: #161b22;
  border-radius: 14px;
  padding: 24px 28px;
  width: 340px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
}
.remote-pw-title {
  font-size: 16px;
  font-weight: 600;
  color: #e6edf3;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.remote-pw-desc {
  font-size: 13px;
  color: #8b949e;
  margin-bottom: 14px;
}
.remote-pw-input {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid #30363d;
  background: #0d1117;
  color: #e6edf3;
  font-size: 14px;
  box-sizing: border-box;
}
.remote-pw-input:focus {
  outline: none;
  border-color: #6b7bff;
}
.remote-pw-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
.remote-pw-cancel {
  background: #30363d;
  color: #e6edf3;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  cursor: pointer;
}
.remote-pw-ok {
  background: #6b7bff;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  cursor: pointer;
}
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #fff;
  position: relative;
}
/* 拖放投放遮罩 */
.drop-mask {
  position: absolute;
  inset: 0;
  z-index: 200;
  background: rgba(0, 137, 255, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.drop-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 26px 38px;
  border: 2px dashed var(--dt-primary);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
}
.drop-box > .fas {
  font-size: 34px;
  color: var(--dt-primary);
}
.drop-box p {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
  color: var(--dt-text);
}
.drop-box span {
  font-size: 12px;
  color: var(--dt-text-4);
}
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--dt-text-4);
  font-size: 44px;
}
.chat-empty p {
  font-size: 13px;
  margin-top: 10px;
}
.chat-head {
  height: 52px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--dt-border-light);
}
.chat-title {
  font-size: 16px;
  font-weight: 600;
}
.chat-actions {
  display: flex;
  gap: 6px;
}
.chat-act {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.chat-act:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.chat-act.on {
  color: var(--dt-primary);
}
.chat-list {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  background: #f7f8fa;
}
.msg-row {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
}
.msg-row.me {
  flex-direction: row-reverse;
}
.msg-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, #0089ff, #5cb6ff);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.msg-body {
  max-width: 70%;
}
.msg-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 4px;
}
.msg-row.me .msg-meta {
  flex-direction: row-reverse;
}
.msg-nick {
  font-size: 12px;
  color: var(--dt-text-3);
}
.msg-time {
  font-size: 11px;
  color: var(--dt-text-4);
}
.msg-read {
  font-size: 10px;
  color: #52c41a;
  white-space: nowrap;
}
.msg-read.unread {
  color: var(--dt-text-4);
}
.msg-bubble {
  padding: 9px 12px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid var(--dt-border-light);
  font-size: 14px;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}
.msg-row.me .msg-bubble {
  background: var(--dt-active);
  border-color: transparent;
}
.msg-img {
  max-width: 240px;
  max-height: 240px;
  border-radius: 8px;
  display: block;
}
.msg-video {
  max-width: 300px;
  max-height: 220px;
  border-radius: 8px;
  display: block;
  background: #000;
}
/* 视频点击播放：封面 + 播放按钮覆盖层 */
.msg-video-wrap {
  position: relative;
  display: inline-block;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  line-height: 0;
}
.msg-video-play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-size: 34px;
  pointer-events: none;
}
/* 3D 模型文件：立方体图标 + 文件名 + 预览按钮 */
.msg-model {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 200px;
}
.msg-model-icon {
  font-size: 22px;
  color: #7b6bf0;
  flex-shrink: 0;
}
.msg-office-pdf {
  color: #e2574c;
}
.msg-office-word {
  color: #2b579a;
}
.msg-office-excel {
  color: #217346;
}
.msg-model-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--dt-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msg-file {
  color: var(--dt-primary);
  text-decoration: none;
}
/* 文件夹消息：文件夹图标 + 名称 + 下载按钮 */
.msg-folder {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 180px;
}
.msg-folder-icon {
  font-size: 22px;
  color: #f0a63a;
  flex-shrink: 0;
}
.msg-folder-name {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  color: var(--dt-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msg-folder-dl {
  flex-shrink: 0;
  height: 26px;
  padding: 0 10px;
  border-radius: 6px;
  background: var(--dt-primary);
  color: #fff;
  font-size: 12px;
}
.msg-folder-dl:hover {
  background: var(--dt-primary-hover);
}
/* 下载进度卡片（大文件下载期间） */
.dl-progress {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  width: min(420px, 80%);
  background: rgba(20, 24, 33, 0.94);
  color: #fff;
  font-size: 13px;
  padding: 12px 16px;
  border-radius: 10px;
  z-index: 131;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}
.dl-progress-name {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.dl-progress-bar {
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.16);
  overflow: hidden;
}
.dl-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--dt-primary, #0089ff);
  transition: width 0.15s linear;
}
/* 服务端没给 content-length 时：不确定进度，来回滑动 */
.dl-progress-fill.indet {
  width: 35%;
  animation: dl-indet 1.1s ease-in-out infinite;
}
@keyframes dl-indet {
  0% { margin-left: -35%; }
  100% { margin-left: 100%; }
}
.dl-progress-meta {
  margin-top: 7px;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: rgba(255, 255, 255, 0.75);
  font-size: 12px;
}
.dl-progress-hint { flex-shrink: 0; opacity: 0.7; }

/* 下载结果提示 */
.dl-toast {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  background: rgba(20, 24, 33, 0.92);
  color: #fff;
  font-size: 13px;
  padding: 10px 18px;
  border-radius: 8px;
  z-index: 130;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  max-width: 80%;
}
.chat-none {
  text-align: center;
  color: var(--dt-text-4);
  font-size: 13px;
  padding: 20px 0;
}

/* 输入区 */
.chat-input-wrap {
  flex-shrink: 0;
  border-top: 1px solid var(--dt-border-light);
  background: #fff;
  padding: 8px 14px 12px;
  position: relative;
}
/* 上传/发送中卡片 */
.up-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}
.up-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--dt-border-light);
  border-radius: 8px;
  background: #f7f8fa;
  max-width: 260px;
}
.up-card > .fa-folder, .up-card > .fas {
  color: var(--dt-primary);
  font-size: 18px;
  flex-shrink: 0;
}
.up-card > .fa-folder {
  color: #f0a63a;
}
.up-card-err {
  border-color: var(--dt-danger);
}
.up-card-err > .fas.fa-exclamation-triangle {
  color: var(--dt-danger);
}
.up-err-text {
  color: var(--dt-danger);
}
.up-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--dt-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.up-ring {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.up-ring-inner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 600;
  color: var(--dt-text-2);
}
.chat-toolbar {
  display: flex;
  gap: 4px;
  margin-bottom: 4px;
}
.chat-tool {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.chat-tool:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.emoji-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 320px;
  padding: 8px;
  margin-bottom: 6px;
  background: #f7f8fa;
  border: 1px solid var(--dt-border-light);
  border-radius: 8px;
  max-height: 180px;
  overflow-y: auto;
}
.emoji-item {
  font-size: 20px;
  width: 34px;
  height: 34px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.emoji-item:hover {
  background: #eef1f5;
}
.chat-textarea {
  width: 100%;
  height: 64px;
  border: none;
  outline: none;
  resize: none;
  font-size: 14px;
  font-family: inherit;
  color: var(--dt-text);
  line-height: 1.5;
}
.chat-send-row {
  display: flex;
  justify-content: flex-end;
}
.chat-send {
  height: 32px;
  padding: 0 20px;
  border-radius: 6px;
  background: var(--dt-primary);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
}
.chat-send:hover:not(:disabled) {
  background: var(--dt-primary-hover);
}
.chat-send:disabled {
  background: #a0cfff;
  cursor: not-allowed;
}

/* 弹窗 / 菜单 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}
.members-modal {
  width: 360px;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--dt-border-light);
}
.modal-x {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 14px;
}
.modal-x:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.modal-body {
  padding: 12px 16px;
}
.members-body {
  max-height: 420px;
  overflow-y: auto;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 4px;
  border-radius: 6px;
}
.member-row:hover {
  background: var(--dt-hover);
}
.member-av {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: linear-gradient(135deg, #6b7bff, #9aa5ff);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
}
.member-name {
  flex: 1;
  font-size: 14px;
}
.member-tag {
  font-size: 11px;
  color: var(--dt-danger);
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
}
.member-online {
  font-size: 12px;
  color: var(--dt-success);
}
.member-online.off {
  color: var(--dt-text-4);
}
.ctx-menu {
  position: fixed;
  background: #fff;
  border: 1px solid var(--dt-border-light);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  padding: 4px;
  z-index: 120;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--dt-danger);
  width: 100%;
  text-align: left;
}
.ctx-item:hover {
  background: var(--dt-hover);
}
</style>
