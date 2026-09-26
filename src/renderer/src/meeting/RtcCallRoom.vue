<script setup lang="ts">
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import VideoStream from '@renderer/media/VideoStream'
import RtcEngine from '@renderer/rtc/RtcEngine'
import { saveCallRecording } from '@renderer/rtc/recording'
import UserAvatar from '@renderer/components/UserAvatar.vue'
import VoiceAvatar from '@renderer/components/VoiceAvatar.vue'
import MediaDevicePanel from '@renderer/components/MediaDevicePanel.vue'
import type {
  Ack,
  RtcChatMessageEvent,
  RtcIceServer,
  RtcKind,
  RtcPeer,
  RtcRoom
} from '@shared/server-types'
import type { NotifTarget } from '@shared/ipc'


// 发送会议聊天消息：preload 发送封装由主进程侧注册，此处做窄类型断言桥接（与 stores/rtc.ts 同约定）
interface MeetingChatPantry {
  rtcChatMessage(roomId: string, content: string): Promise<Ack>
}
const pantry = window.pantry as unknown as typeof window.pantry & MeetingChatPantry

// ─── 状态 ────────────────────────────────────────────────
const room = ref<RtcRoom | null>(null)
const peers = ref<RtcPeer[]>([])
const remoteStreams = reactive<Record<number, MediaStream>>({})
const localVoiceRef = ref<{ getStream?: () => MediaStream | null } | null>(null)
const isMuted = ref(false)
const isCameraOff = ref(false)
const isScreenSharing = ref(false)
const isRecording = ref(false)
// ─── 右键切换设备菜单（麦克风/摄像头）───
const showMicMenu = ref(false)
const showCamMenu = ref(false)
const micMenuX = ref(0)
const micMenuY = ref(0)
const camMenuX = ref(0)
const camMenuY = ref(0)
const micDevices = ref<MediaDeviceInfo[]>([])
const camDevices = ref<MediaDeviceInfo[]>([])
const currentMic = ref('default')
const currentCam = ref('default')
const connectionState = ref<'connecting' | 'connected'>('connecting')
const chatMessages = ref<Array<{ from: { userId: number; nick: string; avatar?: string }; content: string; ts: number; isMe: boolean }>>([])
const showChat = ref(false)
const showParticipants = ref(false)
const showMeetingInfo = ref(false)
const showDevices = ref(false)
const callDuration = ref(0)
const error = ref('')
// 轻提示（录制保存结果等，不打断通话、不弹全屏遮罩）
const toast = ref('')
let toastTimer: number | null = null
// 最近一次录制保存路径（双击提示打开所在文件夹）
const lastSavedPath = ref('')
function showToast(msg: string): void {
  toast.value = msg
  if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null }
  toastTimer = window.setTimeout(() => { toast.value = '' }, 3500)
}
function openToastPath(): void {
  if (lastSavedPath.value) void window.pantry.openFileLocation(lastSavedPath.value)
}
const myNick = ref('我')
const myAvatar = ref('')
const myUserId = ref(0)
const chatInput = ref('')

// 音视频通话质量：默认 48kHz / 2ch / 16bit / 原始分辨率
function audioOpts(): { sampleRate: number; channelCount: number } {
  return {
    sampleRate: 48000,
    channelCount: 2
  }
}

// 无摄像头状态（isCameraOff）的默认视频轨：本地频谱头像画面；不可用则空视频兜底
function spectrumVideoTrack(): MediaStreamTrack | null {
  return localVoiceRef.value?.getStream?.()?.getVideoTracks()[0] ?? null
}

// 设备面板「应用」→ 切换本端麦克风/扬声器/摄像头（对每个 PC replaceTrack 并重新协商）
async function applyDevicesFromPanel(p: {
  audioInId: string
  audioOutId: string
  cameraId: string
  sampleRate: number
  channelCount: number
}): Promise<void> {
  try {
    if (p.audioInId) {
      const ms = await VideoStream.GetAudioStream(p.audioInId, { sampleRate: p.sampleRate, channelCount: p.channelCount })
      const track = ms.getAudioTracks()[0] ?? null
      await VideoStream.UpdateAudioStream(new MediaStream(track ? [track] : []))
      engine?.replaceTrack(track, 'audio')
    }
    if (p.cameraId) {
      let track: MediaStreamTrack | null
      if (p.cameraId === 'default') {
        // 关闭摄像头 → 频谱占位
        track = spectrumVideoTrack() ?? VideoStream.GetEmptyVideoStream().getVideoTracks()[0] ?? null
        isCameraOff.value = true
      } else {
        const ms = await VideoStream.GetCameraStream(p.cameraId)
        track = ms.getVideoTracks()[0] ?? null
        isCameraOff.value = false
      }
      await VideoStream.UpdateVideoStream(new MediaStream(track ? [track] : []))
      engine?.replaceTrack(track, 'video')
    }
    if (p.audioOutId) {
      if (localVideoRef.value) VideoStream.SetSinkId(localVideoRef.value, p.audioOutId)
      document.querySelectorAll('video').forEach((el) => VideoStream.SetSinkId(el as HTMLVideoElement, p.audioOutId))
    }
    showDevices.value = false
  } catch {
    error.value = '设备切换失败'
  }
}

// ─── 右键切换设备（麦克风/摄像头）：左键点击功能保持不变 ──
async function openMicMenu(e: MouseEvent): Promise<void> {
  e.preventDefault()
  micDevices.value = await VideoStream.GetAudioDevices()
  micMenuX.value = e.clientX
  micMenuY.value = e.clientY
  showMicMenu.value = true
  showCamMenu.value = false
}
async function openCamMenu(e: MouseEvent): Promise<void> {
  e.preventDefault()
  camDevices.value = await VideoStream.GetVideoDevices()
  camMenuX.value = e.clientX
  camMenuY.value = e.clientY
  showCamMenu.value = true
  showMicMenu.value = false
}
async function switchMic(deviceId: string): Promise<void> {
  showMicMenu.value = false
  try {
    const ms = await VideoStream.GetAudioStream(deviceId, audioOpts())
    const track = ms.getAudioTracks()[0] ?? null
    await VideoStream.UpdateAudioStream(new MediaStream(track ? [track] : []))
    engine?.replaceTrack(track, 'audio')
    currentMic.value = deviceId
  } catch {
    error.value = '麦克风切换失败'
  }
}
async function switchCamera(deviceId: string): Promise<void> {
  showCamMenu.value = false
  try {
    let track: MediaStreamTrack | null
    if (deviceId === 'default') {
      // 关闭摄像头 → 频谱占位
      track = spectrumVideoTrack() ?? VideoStream.GetEmptyVideoStream().getVideoTracks()[0] ?? null
      isCameraOff.value = true
    } else {
      const ms = await VideoStream.GetCameraStream(deviceId)
      track = ms.getVideoTracks()[0] ?? null
      isCameraOff.value = false
    }
    await VideoStream.UpdateVideoStream(new MediaStream(track ? [track] : []))
    engine?.replaceTrack(track, 'video')
    currentCam.value = deviceId
  } catch {
    error.value = '摄像头切换失败'
  }
}

// ─── 多用户九宫格：点击放大 + 全屏 ──────────────────────────
const focusedKey = ref<string | null>(null)
const focusedPeer = computed(() => peers.value.find((p) => p.socketId === focusedKey.value) ?? null)
function focusTile(key: string): void {
  focusedKey.value = key
}
function closeFocus(): void {
  focusedKey.value = null
}
function fullscreenEl(ev: Event): void {
  const el = (ev.currentTarget as HTMLElement | null)?.parentElement
  if (el && el.requestFullscreen) {
    void el.requestFullscreen().catch(() => { /* ignore */ })
  }
}

// ─── 内部引用 ─────────────────────────────────────────────
let engine: RtcEngine | null = null
let unsubscribers: Array<() => void> = []
let durationTimer: number | null = null
const localVideoRef = ref<HTMLVideoElement | null>(null)
const chatListRef = ref<HTMLDivElement | null>(null)

// ─── 计算属性 ─────────────────────────────────────────────
const formattedDuration = computed(() => {
  const s = callDuration.value
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
})

const localHasVideo = computed(() => {
  if (room.value?.kind === 'voice') return false
  return !isCameraOff.value || isScreenSharing.value
})

function hasRemoteVideo(userId: number): boolean {
  const s = remoteStreams[userId]
  if (!s) return false
  const t = s.getVideoTracks()[0]
  return !!t && t.readyState !== 'ended'
}

// ─── 通话入口参数（私聊/群/会议共用本组件）──────────────────
const props = withDefaults(
  defineProps<{ mode: 'create' | 'join'; kind: RtcKind; meetingNo?: string; password?: string }>(),
  { meetingNo: '', password: '' }
)

// 窗口未聚焦时弹 Windows 通知（来电/会议消息提醒）
async function notifyIfUnfocused(title: string, body: string, target?: NotifTarget): Promise<void> {
  try {
    const st = await window.pantry.getWindowState()
    if (st && !st.focused) await window.pantry.notify({ title, body, target })
  } catch { /* 忽略 */ }
}

// ─── 进入房间 ─────────────────────────────────────────────
async function enterRoom(roomInfo: RtcRoom, roomPeers: RtcPeer[], iceServers: RtcIceServer[], _kind: RtcKind): Promise<void> {
  room.value = roomInfo
  peers.value = [...roomPeers]

  // 1. 本地媒体：默认只开麦克风（高清），摄像头默认关闭，需要时手动开启
  let mic: MediaStream
  try {
    mic = await VideoStream.GetAudioStream(undefined, audioOpts())
  } catch {
    // 无可用音频输入设备（如另一台电脑没接麦克风）→ 用静音空音频，保证能进入会议/通话
    mic = VideoStream.GetEmptyAudioStream()
  }
  const empty = VideoStream.GetEmptyVideoStream()
  const localStream = new MediaStream([...empty.getTracks(), ...mic.getTracks()])
  isCameraOff.value = true
  VideoStream.stream = localStream

  // 2. WebRTC 引擎
  engine = new RtcEngine({
    roomId: roomInfo.id,
    iceServers,
    localStream,
    onSignal: (signal) => { void window.pantry.rtcSignal(roomInfo.id, signal) },
    onRemoteStream: (userId, stream) => { remoteStreams[userId] = stream },
    onPeerDisconnected: (userId) => {
      delete remoteStreams[userId]
      peers.value = peers.value.filter((p) => p.userId !== userId)
    }
  })

  // 3. 已有对端逐个建连
  for (const p of roomPeers) {
    engine.addPeer(p.userId)
  }

  connectionState.value = 'connected'

  // 4. 订阅 RTC 事件（仅匹配本房间）
  unsubscribers.push(
    window.pantry.onRtcPeerJoined((d) => {
      if (d.room !== roomInfo.id) return
      const idx = peers.value.findIndex((p) => p.userId === d.peer.userId)
      if (idx >= 0) peers.value[idx] = d.peer
      else peers.value.push(d.peer)
      engine?.addPeer(d.peer.userId)
    }),
    window.pantry.onRtcPeerLeft((d) => {
      if (d.room !== roomInfo.id) return
      const peer = peers.value.find((p) => p.socketId === d.peerId)
      if (peer) {
        engine?.closePeer(peer.userId)
        delete remoteStreams[peer.userId]
        peers.value = peers.value.filter((p) => p.socketId !== d.peerId)
      }
    }),
    window.pantry.onRtcSignal((d) => {
      if (d.room !== roomInfo.id) return
      engine?.handleSignal(d.from.userId, d.signal)
    }),
    window.pantry.onRtcEnded((d) => {
      if (d.room !== roomInfo.id) return
      void stopRecordingAndSave().then(() => {
        cleanup()
        window.close()
      })
    }),
    pantry.onRtcChatMessage((d: RtcChatMessageEvent) => {
      if (d.room !== roomInfo.id) return
      chatMessages.value.push({
        from: d.from,
        content: d.content,
        ts: d.ts,
        isMe: d.from.userId === myUserId.value
      })
      if (showChat.value) nextTick(scrollChatToBottom)
      // 窗口未聚焦时会议消息 → Windows 通知
      if (d.from.userId !== myUserId.value) {
        void notifyIfUnfocused(`会议消息（${roomInfo.meetingNo || roomInfo.id}）`, `${d.from.nick || ''}: ${d.content}`, { kind: 'main' })
      }
    })
  )

  // 5. 计时
  durationTimer = window.setInterval(() => { callDuration.value++ }, 1000)
}

// ─── 通话控制 ──────────────────────────────────────────────
function toggleMute(): void {
  isMuted.value = !isMuted.value
  const t = VideoStream.GetCurrentAudioTrack()
  if (t) t.enabled = !isMuted.value
}

async function toggleCamera(): Promise<void> {
  try {
    if (isCameraOff.value) {
      const camStream = await VideoStream.GetCameraStream()
      const track = camStream.getVideoTracks()[0] ?? null
      await VideoStream.UpdateVideoStream(new MediaStream(track ? [track] : []))
      engine?.replaceTrack(track, 'video')
    } else {
      // 关摄像头 → 频谱占位
      const track = spectrumVideoTrack() ?? VideoStream.GetEmptyVideoStream().getVideoTracks()[0] ?? null
      await VideoStream.UpdateVideoStream(new MediaStream(track ? [track] : []))
      engine?.replaceTrack(track, 'video')
    }
    isCameraOff.value = !isCameraOff.value
  } catch {
    error.value = '切换摄像头失败'
  }
}

async function toggleScreenShare(): Promise<void> {
  if (!engine) return
  try {
    if (isScreenSharing.value) {
      // 停止共享：回到摄像头（若仍开启）或频谱占位（无摄像头）
      let track: MediaStreamTrack | null = null
      if (!isCameraOff.value) {
        const camStream = await VideoStream.GetCameraStream().catch(() => null)
        track = camStream?.getVideoTracks()[0] ?? null
      }
      if (!track) track = spectrumVideoTrack() ?? VideoStream.GetEmptyVideoStream().getVideoTracks()[0] ?? null
      await VideoStream.UpdateVideoStream(new MediaStream(track ? [track] : []))
      engine.replaceTrack(track, 'video')
      isScreenSharing.value = false
    } else {
      // 开启共享：getDisplayMedia 用户取消会 reject，捕获后不改变状态、不崩溃
      const screenStream = await VideoStream.GetScreenStream()
      const track = screenStream.getVideoTracks()[0] ?? null
      if (!track) throw new Error('未获取到屏幕画面')
      await VideoStream.UpdateVideoStream(new MediaStream([track]))
      engine.replaceTrack(track, 'video')
      isScreenSharing.value = true
    }
  } catch {
    error.value = '屏幕共享切换失败'
  }
}

// ─── 录制（保存到 {下载目录}/通话录制/）────────────────────
async function stopRecordingAndSave(): Promise<void> {
  if (!engine || !isRecording.value) return
  const label = room.value?.meetingNo || room.value?.id || '会议'
  try {
    const r = await engine.stopRecording()
    isRecording.value = false
    if (r) {
      const res = await saveCallRecording(r.blob, r.kind, label)
      if (res.ok) {
        lastSavedPath.value = res.path ?? '' 
        showToast(`录制已保存：${res.path}（双击打开所在文件夹）`)
      } else showToast(`录制保存失败：${res.error}`)
    }
  } catch {
    isRecording.value = false
    showToast('录制停止失败')
  }
}

async function toggleRecording(): Promise<void> {
  if (!engine) return
  if (isRecording.value) {
    await stopRecordingAndSave()
  } else {
    engine.startRecording()
    if (engine.isRecording()) isRecording.value = true
    else error.value = '录制启动失败（未获取到音视频流）'
  }
}

async function leaveCall(): Promise<void> {
  if (isRecording.value) await stopRecordingAndSave()
  try {
    if (room.value) await window.pantry.rtcLeave(room.value.id)
  } catch {
    // 忽略，本地仍清理
  }
  cleanup()
  window.close()
}

function cleanup(): void {
  if (durationTimer !== null) {
    clearInterval(durationTimer)
    durationTimer = null
  }
  unsubscribers.forEach((fn) => { try { fn() } catch { /* ignore */ } })
  unsubscribers = []
  engine?.closeAll()
  engine = null
  VideoStream.Destroy()
}

// ─── 面板切换 / 聊天 ──────────────────────────────────────
function toggleChat(): void {
  showChat.value = !showChat.value
  if (showChat.value) {
    showParticipants.value = false
    nextTick(scrollChatToBottom)
  }
}

function toggleParticipants(): void {
  showParticipants.value = !showParticipants.value
  if (showParticipants.value) showChat.value = false
}

async function sendChat(): Promise<void> {
  const text = chatInput.value.trim()
  if (!text || !room.value) return
  chatInput.value = ''
  try {
    const ack = await pantry.rtcChatMessage(room.value.id, text)
    if (ack.ok) {
      chatMessages.value.push({
        from: { userId: myUserId.value, nick: myNick.value, avatar: myAvatar.value },
        content: text,
        ts: Date.now(),
        isMe: true
      })
      nextTick(scrollChatToBottom)
    }
  } catch {
    // 发送失败不本地追加
  }
}

function copyMeetingNo(): void {
  const no = room.value?.meetingNo ?? room.value?.id ?? ''
  if (no && navigator.clipboard) {
    void navigator.clipboard.writeText(no).catch(() => { /* ignore */ })
  }
}

function scrollChatToBottom(): void {
  if (chatListRef.value) chatListRef.value.scrollTop = chatListRef.value.scrollHeight
}

// ─── 窗口控制 ──────────────────────────────────────────────
function onMinimize(): void { void window.pantry.minimizeWindow() }
function onToggleMaximize(): void { void window.pantry.toggleMaximize() }
function onClose(): void { window.close() }

// ─── 生命周期 ─────────────────────────────────────────────
onMounted(async () => {
  // 取本地用户身份
  try {
    const s = await window.pantry.serverGetState()
    myUserId.value = s.userId ?? 0
    myNick.value = s.username ?? '我'
    myAvatar.value = s.avatar ?? ''
  } catch {
    myNick.value = '我'
  }

  const mode = props.mode
  const kind = props.kind
  const meetingNo = props.meetingNo ?? ''
  const password = props.password ?? ''

  try {
    if (mode === 'create') {
      const ack = await window.pantry.rtcCreateMeeting({ kind })
      if (!ack.ok || !ack.data?.meeting) throw new Error(ack.error || '创建会议失败')
      await enterRoom(ack.data.meeting, ack.data.peers ?? [], ack.data.iceServers ?? [], kind)
    } else {
      if (!meetingNo) throw new Error('缺少会议号')
      const ack = await window.pantry.rtcJoin(meetingNo, password || undefined, kind)
      if (!ack.ok || !ack.data?.room) throw new Error(ack.error || '加入会议失败')
      await enterRoom(ack.data.room, ack.data.peers, ack.data.iceServers, kind)
    }
    nextTick(() => {
      if (localVideoRef.value) VideoStream.SetVideoElement(localVideoRef.value)
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
})

onBeforeUnmount(() => { cleanup() })
</script>

<template>
  <!-- 错误页 -->
  <div v-if="error" class="error-screen">
    <i class="fas fa-circle-exclamation error-icon"></i>
    <div class="error-text">{{ error }}</div>
    <button class="error-close" @click="onClose">关闭</button>
  </div>

  <!-- 轻提示（录制保存等，非阻断；双击打开所在文件夹） -->
  <div v-if="toast" class="rec-toast" title="双击打开所在文件夹" @dblclick="openToastPath">{{ toast }}</div>

  <template v-else>
    <div class="meeting-root">
    <!-- 顶部栏 -->
    <div class="top-bar">
      <button class="top-btn" title="会议信息" @click="showMeetingInfo = !showMeetingInfo">
        <i class="fas fa-info-circle"></i>
      </button>
      <div class="timer">
        <span class="timer-time">{{ formattedDuration }}</span>
        <span class="timer-sub">(60分钟)</span>
      </div>
      <span class="meeting-no" title="点击复制会议号" @click="copyMeetingNo">会议号：{{ room?.meetingNo ?? room?.id }}</span>
      <div class="top-right">
        <button class="top-btn" title="视图"><i class="fas fa-th-large"></i></button>
        <button class="top-btn no-drag" title="最小化" @click="onMinimize"><i class="fas fa-minus"></i></button>
        <button class="top-btn no-drag" title="最大化" @click="onToggleMaximize"><i class="fas fa-square"></i></button>
        <button class="top-btn no-drag close-btn" title="关闭" @click="leaveCall"><i class="fas fa-times"></i></button>
      </div>
    </div>

    <!-- 会议信息浮层 -->
    <div v-if="showMeetingInfo" class="meeting-info">
      <div class="info-title">会议信息</div>
      <div class="info-row">会议号：{{ room?.meetingNo ?? room?.id }}</div>
      <div class="info-row">主题：{{ room?.title || '视频会议' }}</div>
      <div class="info-row">状态：{{ connectionState === 'connected' ? '已连接' : '连接中' }}</div>
    </div>

    <!-- 音视频设备浮层（更多菜单） -->
    <div v-if="showDevices" class="dev-panel-wrap">
      <MediaDevicePanel @apply="applyDevicesFromPanel" />
    </div>

    <!-- 中央视频区 -->
    <div class="center-area">
      <div class="video-grid">
        <!-- 本地 "我" -->
        <div class="tile" :class="{ focused: focusedKey === 'me' }" @click="focusTile('me')">
          <video
            ref="localVideoRef"
            autoplay
            playsinline
            muted
            :style="{ display: localHasVideo ? 'block' : 'none' }"
          ></video>
          <div v-if="!localHasVideo" class="tile-avatar">
            <VoiceAvatar ref="localVoiceRef" :stream="VideoStream.stream" :nick="myNick" :avatar="myAvatar" :size="96" />
          </div>
          <div class="tile-name">我：{{ myNick }}</div>
          <button class="tile-fs" title="全屏" @click.stop="fullscreenEl"><i class="fas fa-expand"></i></button>
        </div>

        <!-- 远端 peers -->
        <div v-for="p in peers" :key="p.socketId" class="tile" :class="{ focused: focusedKey === p.socketId }" @click="focusTile(p.socketId)">
          <video
            v-if="hasRemoteVideo(p.userId)"
            :srcObject="remoteStreams[p.userId]"
            autoplay
            playsinline
            :muted="focusedKey === p.socketId"
          ></video>
          <div v-else class="tile-avatar">
            <VoiceAvatar :stream="remoteStreams[p.userId]" :nick="p.nick" :avatar="p.avatar" :size="96" />
          </div>
          <div class="tile-name">{{ p.nick }}</div>
          <button class="tile-fs" title="全屏" @click.stop="fullscreenEl"><i class="fas fa-expand"></i></button>
        </div>
      </div>

      <!-- 左下角当前参会者 -->
      <div class="who-am-i">我：{{ myNick }}</div>

      <!-- 点击放大视图 -->
      <div v-if="focusedKey" class="focus-overlay" @click.self="closeFocus">
        <template v-if="focusedKey === 'me'">
          <video v-if="localHasVideo" autoplay playsinline muted :srcObject="VideoStream.stream"></video>
          <div v-else class="focus-avatar">
            <VoiceAvatar :stream="VideoStream.stream" :nick="myNick" :avatar="myAvatar" :size="180" />
          </div>
          <div class="focus-name">我：{{ myNick }}</div>
        </template>
        <template v-else-if="focusedPeer">
          <video v-if="hasRemoteVideo(focusedPeer.userId)" autoplay playsinline :srcObject="remoteStreams[focusedPeer.userId]"></video>
          <div v-else class="focus-avatar">
            <VoiceAvatar :stream="remoteStreams[focusedPeer.userId]" :nick="focusedPeer.nick" :avatar="focusedPeer.avatar" :size="180" />
          </div>
          <div class="focus-name">{{ focusedPeer.nick }}</div>
        </template>
        <div class="focus-btns">
          <button class="focus-btn" title="关闭" @click="closeFocus"><i class="fas fa-times"></i></button>
          <button class="focus-btn" title="全屏" @click="fullscreenEl"><i class="fas fa-expand"></i></button>
        </div>
      </div>
    </div>

    <!-- 聊天面板 -->
    <div v-if="showChat" class="side-panel chat-panel">
      <div class="panel-title">聊天</div>
      <div ref="chatListRef" class="chat-list">
        <div v-for="(m, i) in chatMessages" :key="i" class="chat-msg" :class="{ mine: m.isMe }">
          <div class="chat-head">
            <UserAvatar :nick="m.from.nick" :avatar="m.from.avatar" :size="22" />
            <div class="chat-nick">{{ m.from.nick }}</div>
          </div>
          <div class="chat-bubble">{{ m.content }}</div>
        </div>
      </div>
      <div class="chat-input-row">
        <input v-model="chatInput" placeholder="发送消息" @keyup.enter="sendChat" />
        <button class="chat-send" @click="sendChat"><i class="fas fa-paper-plane"></i></button>
      </div>
    </div>

    <!-- 参会者面板 -->
    <div v-if="showParticipants" class="side-panel">
      <div class="panel-title">参会者（{{ peers.length + 1 }}）</div>
      <div class="participant-row">
        <UserAvatar :nick="myNick" :avatar="myAvatar" :size="32" />
        <span class="participant-name">我：{{ myNick }}</span>
        <span class="participant-status">主持人</span>
      </div>
      <div v-for="p in peers" :key="p.socketId" class="participant-row">
        <UserAvatar :nick="p.nick" :avatar="p.avatar" :size="32" />
        <span class="participant-name">{{ p.nick }}</span>
        <span class="participant-status">在线</span>
      </div>
    </div>

    <!-- 底部控制栏 -->
    <div class="control-bar">
      <button class="ctrl" :class="{ danger: isMuted }" title="左键静音/解除静音，右键切换麦克风" @click="toggleMute" @contextmenu.prevent="openMicMenu($event)">
        <i class="fas" :class="isMuted ? 'fa-microphone-slash' : 'fa-microphone'"></i>
      </button>
      <button v-if="room?.kind === 'video'" class="ctrl" :class="{ danger: isCameraOff }" title="左键开关摄像头，右键切换摄像头" @click="toggleCamera" @contextmenu.prevent="openCamMenu($event)">
        <i class="fas" :class="isCameraOff ? 'fa-video-slash' : 'fa-video'"></i>
      </button>
      <button class="ctrl" title="安全"><i class="fas fa-shield-alt"></i></button>
      <button class="ctrl" title="邀请/复制会议号" @click="copyMeetingNo"><i class="fas fa-user-plus"></i></button>
      <button class="ctrl" :class="{ on: showParticipants }" title="参会者" @click="toggleParticipants"><i class="fas fa-users"></i></button>
      <button v-if="room?.kind === 'video'" class="ctrl" :class="{ sharing: isScreenSharing }" title="共享屏幕" @click="toggleScreenShare">
        <i class="fas fa-desktop"></i>
      </button>
      <button class="ctrl" :class="{ on: showChat }" title="聊天" @click="toggleChat"><i class="fas fa-comment"></i></button>
      <button class="ctrl rec" :class="{ on: isRecording }" title="录制" @click="toggleRecording"><i class="fas fa-circle"></i></button>
      <button class="ctrl" title="AI听记"><i class="fas fa-robot"></i></button>
      <button class="ctrl" :class="{ on: showDevices }" title="更多（音视频设备/音质）" @click="showDevices = !showDevices"><i class="fas fa-ellipsis-h"></i></button>
      <button class="ctrl hangup" title="结束" @click="leaveCall">
        <i class="fas fa-phone-slash"></i><span class="hangup-text">结束</span>
      </button>
    </div>

    <!-- 麦克风设备菜单（右键麦克风按钮，居中显示） -->
    <div v-if="showMicMenu" class="dev-pop" @click.stop>
      <div class="dev-pop-title">麦克风</div>
      <button class="dev-pop-item" :class="{ cur: currentMic === 'default' }" @click="switchMic('default')"><i class="fas fa-microphone"></i> 系统默认</button>
      <button v-for="d in micDevices" :key="d.deviceId" class="dev-pop-item" :class="{ cur: currentMic === d.deviceId }" @click="switchMic(d.deviceId)">
        <i class="fas fa-microphone"></i> {{ d.label || d.deviceId }}
      </button>
      <button v-if="micDevices.length === 0" class="dev-pop-empty" disabled>未检测到麦克风</button>
    </div>

    <!-- 摄像头设备菜单（右键摄像头按钮，居中显示） -->
    <div v-if="showCamMenu" class="dev-pop" @click.stop>
      <div class="dev-pop-title">摄像头</div>
      <button class="dev-pop-item" :class="{ cur: currentCam === 'default' }" @click="switchCamera('default')"><i class="fas fa-video"></i> 系统默认</button>
      <button v-for="d in camDevices" :key="d.deviceId" class="dev-pop-item" :class="{ cur: currentCam === d.deviceId }" @click="switchCamera(d.deviceId)">
        <i class="fas fa-video"></i> {{ d.label || d.deviceId }}
      </button>
      <button v-if="camDevices.length === 0" class="dev-pop-empty" disabled>未检测到摄像头</button>
    </div>
    </div>
  </template>
</template>

<style scoped>
* { box-sizing: border-box; }

/* 根容器：顶部栏 / 中央区 / 底部栏 垂直填满整窗，不留白 */
.meeting-root {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #0d1117;
  overflow: hidden;
}

.error-screen {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: #0d1117;
  color: #e6e6e6;
}
.error-icon { font-size: 48px; color: #ff7d00; }
.error-text { font-size: 15px; }
.error-close {
  padding: 8px 28px;
  border: none;
  border-radius: 6px;
  background: #ff7d00;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
}
.rec-toast {
  position: fixed;
  bottom: 84px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(22, 27, 34, 0.95);
  color: #e6e6e6;
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid #2d2d44;
  z-index: 80;
  max-width: 70vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 顶部栏 */
.top-bar {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 12px;
  background: #0d1117;
  -webkit-app-region: drag;
  gap: 8px;
}
.top-btn {
  background: transparent;
  border: none;
  color: #cfd3dc;
  font-size: 15px;
  cursor: pointer;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.top-btn:hover { background: rgba(255, 255, 255, 0.08); }
.no-drag { -webkit-app-region: no-drag; }
.close-btn:hover { background: #e81123; color: #fff; }
.timer { display: flex; align-items: baseline; gap: 6px; color: #cfd3dc; }
.timer-time { font-size: 14px; font-variant-numeric: tabular-nums; }
.timer-sub { font-size: 12px; color: #8a8f99; }
.meeting-no {
  margin-left: 12px;
  color: #cfd3dc;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  padding: 4px 10px;
  border: 1px solid #2d2d44;
  border-radius: 6px;
  background: rgba(255,255,255,0.04);
}
.meeting-no:hover { border-color: #1677ff; color: #fff; }
.top-right { margin-left: auto; display: flex; align-items: center; gap: 4px; }

.meeting-info {
  position: absolute;
  top: 48px;
  left: 12px;
  background: #1a1a2e;
  border: 1px solid #2d2d44;
  border-radius: 8px;
  padding: 12px 14px;
  color: #e6e6e6;
  font-size: 13px;
  z-index: 20;
  min-width: 220px;
}
.info-title { font-weight: 600; margin-bottom: 8px; }
.info-row { margin: 4px 0; color: #b8bcc6; }

/* 音视频设备浮层 */
.device-panel {
  position: absolute;
  top: 48px;
  right: 12px;
  width: 300px;
  background: #1a1a2e;
  border: 1px solid #2d2d44;
  border-radius: 8px;
  padding: 12px 14px;
  color: #e6e6e6;
  font-size: 13px;
  z-index: 20;
}
.dev-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.dev-row label { color: #8a8f99; font-size: 12px; }
.dev-row select {
  background: #0d1117;
  border: 1px solid #2d2d44;
  border-radius: 6px;
  color: #e6e6e6;
  font-size: 13px;
  padding: 6px 8px;
  outline: none;
}
.dev-hint { color: #6b7280; font-size: 11px; margin-bottom: 10px; }
.dev-actions { display: flex; justify-content: flex-end; }
.dev-apply {
  background: #1677ff;
  border: none;
  color: #fff;
  padding: 7px 20px;
  border-radius: 6px;
  font-size: 13px;
  cursor: pointer;
}
.dev-apply:hover { background: #3a8aff; }
.dev-panel-wrap {
  position: absolute;
  top: 48px;
  right: 12px;
  z-index: 20;
}
.dev-pop {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  min-width: 220px;
  max-width: 320px;
  background: #1a1a2e;
  border: 1px solid #2d2d44;
  border-radius: 8px;
  padding: 6px;
  color: #e6e6e6;
  font-size: 13px;
  z-index: 50;
  max-height: 320px;
  overflow-y: auto;
}
.dev-pop-title { font-size: 12px; color: #8a8f99; padding: 4px 8px 6px; }
.dev-pop-item {
  display: flex; align-items: center; gap: 8px;
  width: 100%; text-align: left;
  padding: 7px 10px; border-radius: 6px;
  border: none; background: transparent;
  color: #e6e6e6; font-size: 13px; cursor: pointer;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dev-pop-item:hover { background: rgba(255,255,255,0.08); }
.dev-pop-item.cur { color: #1677ff; }
.dev-pop-empty { padding: 8px; color: #6b7280; font-size: 12px; border: none; background: transparent; }
.tile.focused { outline: 2px solid #1677ff; }
.tile-fs {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  z-index: 5;
}
.tile-fs:hover { background: #1677ff; }
.focus-overlay {
  position: absolute;
  inset: 0;
  z-index: 30;
  background: rgba(0, 0, 0, 0.86);
  display: flex;
  align-items: center;
  justify-content: center;
}
.focus-overlay video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.focus-avatar { display: flex; align-items: center; justify-content: center; }
.focus-name {
  position: absolute;
  left: 16px;
  bottom: 16px;
  color: #fff;
  font-size: 14px;
  background: rgba(0, 0, 0, 0.55);
  padding: 4px 12px;
  border-radius: 6px;
}
.focus-btns {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  gap: 10px;
}
.focus-btn {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: rgba(45, 45, 68, 0.92);
  color: #fff;
  font-size: 16px;
  cursor: pointer;
}
.focus-btn:hover { background: #1677ff; }

/* 中央 */
.center-area {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #0d1117;
}
.video-grid {
  flex: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  grid-template-columns: repeat(3, 1fr);
  align-content: center;
  justify-items: center;
  overflow: auto;
}
.tile {
  position: relative;
  width: 100%;
  max-width: 560px;
  aspect-ratio: 16 / 9;
  background: #1a1a2e;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tile video { width: 100%; height: 100%; object-fit: cover; }
.tile-avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.tile-name {
  position: absolute;
  left: 8px;
  bottom: 6px;
  color: #fff;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.45);
  padding: 2px 8px;
  border-radius: 4px;
}
.who-am-i {
  position: absolute;
  left: 16px;
  bottom: 12px;
  color: #b8bcc6;
  font-size: 12px;
}

/* 侧边面板 */
.side-panel {
  position: absolute;
  right: 0;
  top: 44px;
  bottom: 64px;
  width: 300px;
  background: #1a1a2e;
  border-left: 1px solid #2d2d44;
  display: flex;
  flex-direction: column;
  z-index: 15;
}
.panel-title {
  padding: 12px 16px;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  border-bottom: 1px solid #2d2d44;
}
.chat-list { flex: 1; overflow-y: auto; padding: 12px; }
.chat-msg { margin-bottom: 10px; }
.chat-head { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
.chat-nick { font-size: 11px; color: #8a8f99; }
.chat-bubble {
  display: inline-block;
  background: #2d2d44;
  color: #e6e6e6;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 13px;
  max-width: 100%;
  word-break: break-word;
}
.chat-msg.mine { text-align: right; }
.chat-msg.mine .chat-bubble { background: #1677ff; color: #fff; }
.chat-input-row {
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid #2d2d44;
}
.chat-input-row input {
  flex: 1;
  background: #0d1117;
  border: 1px solid #2d2d44;
  border-radius: 6px;
  padding: 7px 10px;
  color: #e6e6e6;
  font-size: 13px;
  outline: none;
}
.chat-send {
  background: #1677ff;
  border: none;
  color: #fff;
  width: 36px;
  border-radius: 6px;
  cursor: pointer;
}

.participant-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
}
.participant-name { color: #e6e6e6; font-size: 13px; flex: 1; }
.participant-status { color: #8a8f99; font-size: 11px; }

/* 底部控制栏 */
.control-bar {
  height: 64px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: rgba(13, 17, 23, 0.92);
  padding: 0 16px;
}
.ctrl {
  background: #2d2d44;
  border: none;
  color: #e6e6e6;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  font-size: 16px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ctrl:hover { background: #3a3a55; }
.ctrl.danger { background: #e81123; }
.ctrl.on { background: #1677ff; }
.ctrl.sharing { background: #1677ff; }
.ctrl.rec { color: #ff4d4f; }
.hangup {
  width: auto;
  border-radius: 22px;
  padding: 0 18px;
  gap: 6px;
  background: #ff7d00;
}
.hangup:hover { background: #ff9033; }
.hangup-text { font-size: 13px; }
</style>

<style>
/* 独立会议窗口：整页深色，杜绝底部/四周白色 */
html, body, #app {
  height: 100%;
  margin: 0;
  background: #0d1117;
}
</style>
