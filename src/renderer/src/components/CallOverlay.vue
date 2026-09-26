<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRtcStore } from '../stores/rtc'
import { useServerStore } from '../stores/server'
import VideoStream from '../media/VideoStream'
import UserAvatar from './UserAvatar.vue'
import MediaDevicePanel from './MediaDevicePanel.vue'

const rtc = useRtcStore()
const server = useServerStore()

// ─── 通话标题 ───
const callTitle = computed(() => {
  const ac = rtc.activeCall
  if (!ac) return ''
  if (ac.room.title) return ac.room.title
  if (ac.room.meetingNo) return `会议 ${ac.room.meetingNo}`
  if (ac.room.type === 'dm') {
    return ac.peers[0]?.nick ?? '私聊通话'
  }
  if (ac.room.type === 'group') return '群通话'
  return '通话'
})

// ─── 参与者瓦片（含本地"我"） ───
interface Tile {
  key: string
  isLocal: boolean
  userId: number
  nick: string
  avatar?: string
  hasVideo: boolean
}

const localNick = computed(() => server.state.username || '我')

const tiles = computed<Tile[]>(() => {
  const ac = rtc.activeCall
  if (!ac) return []
  const list: Tile[] = []
  // 本地瓦片：仅视频通话且未关摄像头时有视频
  list.push({
    key: 'local',
    isLocal: true,
    userId: server.state.userId ?? 0,
    nick: '我',
    avatar: server.state.avatar || undefined,
    hasVideo: ac.kind === 'video' && (!ac.isCameraOff || ac.isScreenSharing)
  })
  for (const peer of ac.peers) {
    const stream = ac.remoteStreams[peer.userId]
    list.push({
      key: String(peer.userId),
      isLocal: false,
      userId: peer.userId,
      nick: peer.nick,
      avatar: peer.avatar,
      hasVideo: ac.kind === 'video' && !!stream
    })
  }
  return list
})

// ─── 通话时长计时器 ───
const elapsed = ref(0)
let timer: number | null = null

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

onMounted(() => {
  timer = window.setInterval(() => {
    if (rtc.activeCall) elapsed.value++
  }, 1000)
})

onUnmounted(() => {
  if (timer !== null) clearInterval(timer)
})

// ─── 本地视频绑定 ───
const localVideoEl = ref<HTMLVideoElement | null>(null)

onMounted(async () => {
  await nextTick()
  if (localVideoEl.value) {
    VideoStream.SetVideoElement(localVideoEl.value)
  }
})

// ─── 远端视频 ref 绑定 ───
const remoteVideoEls = ref<Record<number, HTMLVideoElement | null>>({})

function setRemoteVideoEl(userId: number, el: HTMLVideoElement | null): void {
  remoteVideoEls.value[userId] = el
}

// 监听 remoteStreams 变化，绑定到对应 video 元素
watch(
  () => rtc.activeCall?.remoteStreams,
  (streams) => {
    if (!streams) return
    for (const [userIdStr, stream] of Object.entries(streams)) {
      const userId = Number(userIdStr)
      const el = remoteVideoEls.value[userId]
      if (el && el.srcObject !== stream) {
        el.srcObject = stream
        void el.play().catch(() => { /* ignore autoplay */ })
      }
    }
  },
  { deep: true }
)

// ─── 参与者侧栏 ───
const showParticipants = ref(false)

// ─── 网格布局（按总参与人数：1=居中，2=左右，3-4=2x2，更多自适应） ───
const gridClass = computed(() => {
  const n = tiles.value.length
  if (n <= 1) return 'grid-1'
  if (n === 2) return 'grid-2'
  if (n <= 4) return 'grid-2x2'
  return 'grid-auto'
})

// ─── 设备面板 / 九宫格放大 / 全屏 ───
const showDevices = ref(false)
const focusedKey = ref<string | null>(null)
const focusedTile = computed(() => tiles.value.find((t) => t.key === focusedKey.value) ?? null)
function focusTile(key: string): void { focusedKey.value = key }
function closeFocus(): void { focusedKey.value = null }
function fullscreenEl(ev: Event): void {
  const el = (ev.currentTarget as HTMLElement | null)?.parentElement
  if (el && el.requestFullscreen) { void el.requestFullscreen().catch(() => { /* ignore */ }) }
}
</script>

<template>
  <div v-if="rtc.activeCall" class="call-overlay">
    <!-- 顶部栏 -->
    <div class="call-header">
      <div class="call-header-left">
        <i class="fas fa-video"></i>
        <span class="call-title">{{ callTitle }}</span>
        <span class="call-kind-badge" :class="rtc.activeCall.kind">
          {{ rtc.activeCall.kind === 'video' ? '视频' : '语音' }}
        </span>
      </div>
      <div class="call-header-right">
        <span class="call-timer">{{ formatDuration(elapsed) }}</span>
      </div>
    </div>

    <!-- 中部视频/头像网格 -->
    <div class="call-body">
      <div class="video-grid" :class="gridClass">
        <div
          v-for="tile in tiles"
          :key="tile.key"
          class="video-tile"
          :class="{ local: tile.isLocal, 'no-video': !tile.hasVideo, focused: focusedKey === tile.key }"
          @click="focusTile(tile.key)"
        >
          <!-- 有视频流 -->
          <video
            v-if="tile.hasVideo && tile.isLocal"
            ref="localVideoEl"
            autoplay
            playsinline
            muted
            class="video-element"
          ></video>
          <video
            v-else-if="tile.hasVideo"
            :ref="(el) => setRemoteVideoEl(tile.userId, el as HTMLVideoElement | null)"
            autoplay
            playsinline
            class="video-element"
          ></video>
          <!-- 无视频（语音/关摄像头）→ 居中头像 + 昵称 -->
          <div v-else class="tile-avatar">
            <UserAvatar
              :nick="tile.isLocal ? localNick : tile.nick"
              :avatar="tile.avatar"
              :size="104"
            />
            <span class="tile-avatar-name">{{ tile.nick }}{{ tile.isLocal && rtc.activeCall?.isMuted ? '（静音）' : '' }}</span>
          </div>
          <span v-if="tile.hasVideo" class="tile-label">{{ tile.nick }}{{ tile.isLocal && rtc.activeCall?.isMuted ? '（静音）' : '' }}</span>
          <button class="tile-fs" title="全屏" @click.stop="fullscreenEl"><i class="fas fa-expand"></i></button>
        </div>
      </div>

      <!-- 参与者侧栏 -->
      <Transition name="slide">
        <div v-if="showParticipants" class="participants-panel">
          <div class="participants-header">
            <span>参与者 ({{ rtc.activeCall.peers.length + 1 }})</span>
            <button class="icon-btn" @click="showParticipants = false">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <div class="participant-item">
            <i class="fas fa-circle self-icon"></i>
            <span>我</span>
          </div>
          <div
            v-for="peer in rtc.activeCall.peers"
            :key="peer.userId"
            class="participant-item"
          >
            <i class="fas fa-circle online-icon"></i>
            <span>{{ peer.nick }}</span>
          </div>
        </div>
      </Transition>

      <!-- 点击放大视图 -->
      <div v-if="focusedKey" class="focus-overlay" @click.self="closeFocus">
        <template v-if="focusedTile">
          <video v-if="focusedTile.hasVideo && focusedTile.isLocal" :srcObject="VideoStream.stream" autoplay playsinline muted class="focus-video"></video>
          <video v-else-if="focusedTile.hasVideo" :srcObject="rtc.activeCall?.remoteStreams[focusedTile.userId]" autoplay playsinline class="focus-video"></video>
          <div v-else class="focus-avatar">
            <UserAvatar :nick="focusedTile.nick" :avatar="focusedTile.avatar" :size="180" />
            <span class="focus-name">{{ focusedTile.nick }}</span>
          </div>
          <div v-if="focusedTile.hasVideo" class="focus-name">{{ focusedTile.nick }}</div>
        </template>
        <div class="focus-btns">
          <button class="focus-btn" title="关闭" @click="closeFocus"><i class="fas fa-times"></i></button>
          <button class="focus-btn" title="全屏" @click="fullscreenEl"><i class="fas fa-expand"></i></button>
        </div>
      </div>

      <!-- 设备面板（更多） -->
      <div v-if="showDevices" class="dev-panel-mask" @click.self="showDevices = false">
        <MediaDevicePanel @apply="rtc.applyDevices($event)" />
      </div>
    </div>

    <!-- 底部控制栏 -->
    <div class="call-controls">
      <!-- 静音 -->
      <button
        class="ctrl-btn"
        :class="{ active: rtc.activeCall.isMuted }"
        @click="rtc.toggleMute()"
        :title="rtc.activeCall.isMuted ? '取消静音' : '静音'"
      >
        <i :class="rtc.activeCall.isMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone'"></i>
      </button>

      <!-- 摄像头（仅视频通话显示） -->
      <button
        v-if="rtc.activeCall.kind === 'video'"
        class="ctrl-btn"
        :class="{ active: rtc.activeCall.isCameraOff }"
        @click="rtc.toggleCamera()"
        :title="rtc.activeCall.isCameraOff ? '开启摄像头' : '关闭摄像头'"
      >
        <i :class="rtc.activeCall.isCameraOff ? 'fas fa-video-slash' : 'fas fa-video'"></i>
      </button>

      <!-- 屏幕共享（仅视频通话显示） -->
      <button
        v-if="rtc.activeCall.kind === 'video'"
        class="ctrl-btn"
        :class="{ active: rtc.activeCall.isScreenSharing }"
        @click="rtc.toggleScreenShare()"
        :title="rtc.activeCall.isScreenSharing ? '停止共享' : '共享屏幕'"
      >
        <i class="fas fa-desktop"></i>
      </button>

      <!-- 参与者列表 -->
      <button
        class="ctrl-btn"
        :class="{ active: showParticipants }"
        @click="showParticipants = !showParticipants"
        title="参与者"
      >
        <i class="fas fa-users"></i>
      </button>

      <!-- 录制 -->
      <button
        class="ctrl-btn rec"
        :class="{ active: rtc.isRecording }"
        @click="rtc.toggleRecording()"
        :title="rtc.isRecording ? '停止录制' : '录制'"
      >
        <i class="fas fa-circle"></i>
      </button>

      <!-- 更多（设备/音质） -->
      <button
        class="ctrl-btn"
        :class="{ active: showDevices }"
        @click="showDevices = !showDevices"
        title="更多（音视频设备/音质）"
      >
        <i class="fas fa-ellipsis-h"></i>
      </button>

      <!-- 挂断 -->
      <button class="ctrl-btn hangup" @click="rtc.leave()" title="挂断">
        <i class="fas fa-phone-slash"></i>
      </button>

      <!-- 结束通话 -->
      <button class="ctrl-btn end-call" @click="rtc.end()" title="结束通话">
        <i class="fas fa-times"></i>
      </button>
    </div>

    <!-- 错误提示 -->
    <div v-if="rtc.error" class="call-error" @click="rtc.error = ''">
      {{ rtc.error }}
    </div>
  </div>
</template>

<style scoped>
.call-overlay {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: #0d1117;
  display: flex;
  flex-direction: column;
  color: #e6edf3;
}

/* 顶部栏 */
.call-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 24px;
  background: rgba(0, 0, 0, 0.3);
  flex-shrink: 0;
}
.call-header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.call-title {
  font-size: 16px;
  font-weight: 600;
}
.call-kind-badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: #1677ff;
}
.call-kind-badge.voice {
  background: #722ed1;
}
.call-timer {
  font-size: 14px;
  font-variant-numeric: tabular-nums;
  color: #8b949e;
}

/* 中部 */
.call-body {
  flex: 1;
  position: relative;
  display: flex;
  overflow: hidden;
}
.video-grid {
  flex: 1;
  display: grid;
  gap: 12px;
  padding: 16px;
  align-content: center;
  justify-content: center;
}
.grid-1 {
  grid-template-columns: 1fr;
  grid-template-rows: 1fr;
}
.grid-2 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr;
}
.grid-2x2 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
}
.grid-auto {
  grid-template-columns: repeat(3, 1fr);
  grid-auto-rows: 1fr;
}

.video-tile {
  position: relative;
  background: #1a1a2e;
  border-radius: 8px;
  overflow: hidden;
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.video-tile.no-video {
  background: #161b2e;
}
.tile-avatar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.tile-avatar-name {
  font-size: 14px;
  color: #c9d1d9;
}
.video-element {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tile-label {
  position: absolute;
  bottom: 8px;
  left: 8px;
  background: rgba(0, 0, 0, 0.6);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}

.video-tile.focused { outline: 2px solid #1677ff; }
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
.focus-video { width: 100%; height: 100%; object-fit: contain; }
.focus-avatar { display: flex; flex-direction: column; align-items: center; gap: 12px; }
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
.dev-panel-mask {
  position: absolute;
  inset: 0;
  z-index: 25;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
}
/* 参与者侧栏 */
.participants-panel {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 240px;
  background: rgba(22, 27, 34, 0.95);
  border-left: 1px solid #30363d;
  padding: 12px;
  overflow-y: auto;
}
.participants-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
  font-size: 14px;
  font-weight: 600;
}
.icon-btn {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  font-size: 14px;
}
.participant-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px;
  font-size: 14px;
}
.online-icon {
  color: #00b42a;
  font-size: 8px;
}
.self-icon {
  color: #1677ff;
  font-size: 8px;
}

/* 底部控制栏 */
.call-controls {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: rgba(0, 0, 0, 0.4);
  flex-shrink: 0;
}
.ctrl-btn {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: #30363d;
  color: #e6edf3;
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s, transform 0.1s;
}
.ctrl-btn:hover {
  background: #444c56;
}
.ctrl-btn:active {
  transform: scale(0.95);
}
.ctrl-btn.active {
  background: #1677ff;
}
.ctrl-btn.rec {
  color: #ff4d4f;
}
.ctrl-btn.hangup {
  background: #f53f3f;
  width: 56px;
  height: 56px;
  font-size: 22px;
}
.ctrl-btn.hangup:hover {
  background: #d9363e;
}
.ctrl-btn.end-call {
  background: #f53f3f;
}
.ctrl-btn.end-call:hover {
  background: #d9363e;
}

/* 错误提示 */
.call-error {
  position: absolute;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  background: #f53f3f;
  color: #fff;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
  z-index: 10;
}

/* 侧栏动画 */
.slide-enter-active,
.slide-leave-active {
  transition: transform 0.25s ease;
}
.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}
</style>
