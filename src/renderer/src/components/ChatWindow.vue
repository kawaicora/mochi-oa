<script setup lang="ts">
import { ref, nextTick, watch, computed, onMounted } from 'vue'
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
    const r = await window.pantry.serverDownloadFile(server.absFileUrl(m.content))
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
      const r = await window.pantry.serverDownloadFile(server.absFileUrl(m.content))
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

/** 3D 预览弹窗 */
const previewModel = ref<{ path: string; name: string } | null>(null)
/** 单独窗口预览：图片大图 / 视频全屏播放 */
const previewMedia = ref<{ kind: 'image' | 'video'; m: ServerChatMessage } | null>(null)
async function openModelPreview(m: { content: string; id: string }): Promise<void> {
  let path = app.localCache[m.id]?.path
  if (!path) {
    const r = await window.pantry.serverDownloadFile(m.content)
    if (!r.ok || !r.path) {
      flashToast('模型文件下载失败')
      return
    }
    path = r.path
  }
  previewModel.value = { path, name: fileNameOf(m.content) }
}
</script>

<template>
  <section class="chat-panel">
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
              <!-- 文件：3D 模型显示预览按钮，否则普通文件 -->
              <template v-else-if="m.kind === 'file' || m.kind === 'image'">
                <div v-if="m.kind === 'file' && is3dModelUrl(m.content)" class="msg-model">
                  <i class="fas fa-cube msg-model-icon"></i>
                  <span class="msg-model-name" :title="fileNameOf(m.content)">{{ fileNameOf(m.content) }}</span>
                  <button class="msg-folder-dl" @click="openModelPreview(m)">
                    <i class="fas fa-cube"></i>&nbsp;3D 预览
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

    <!-- 下载结果提示 -->
    <div v-if="dlToast" class="dl-toast">{{ dlToast }}</div>

    <!-- 3D 模型预览 -->
    <ModelPreview v-if="previewModel" :path="previewModel.path" :name="previewModel.name" @close="previewModel = null" />

    <!-- 图片/视频单独预览 -->
    <MediaPreview v-if="previewMedia" :kind="previewMedia.kind" :m="previewMedia.m" @close="previewMedia = null" />

    <!-- 群设置 -->
    <GroupSettings v-if="app.groupSettingsOpen" />
  </section>
</template>

<style scoped>
.chat-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #fff;
  position: relative;
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
