<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { RoomEvent, type Room } from 'livekit-client'
import { connectSfu } from '../rtc/livekitClient'

const props = defineProps<{ deviceId: string; deviceName: string }>()

const videoEl = ref<HTMLVideoElement | null>(null)
const audioEl = ref<HTMLAudioElement | null>(null)
const connecting = ref(true)
const error = ref('')
const activeKind = ref<'screen' | 'camera' | 'mic'>('screen')
let room: Room | null = null

async function start() {
  connecting.value = true
  error.value = ''
  try {
    const ack = await window.pantry.serverAdminDevView(props.deviceId)
    console.log('[remote-preview] dev:view ack:', ack)
    if (!ack.ok) {
      error.value = ack.error || '无法获取设备信息'
      connecting.value = false
      return
    }
    // 服务端 dev:view 把 SFU 信息嵌套在 sfu 字段下
    const s = ack.data?.sfu
    if (!s?.url || !s?.token || !s?.roomName) {
      error.value = '服务端未配置 LiveKit SFU'
      connecting.value = false
      return
    }
    console.log('[remote-preview] 连接 SFU:', s.url, 'room:', s.roomName)

    // 用和会议相同的 connectSfu() 连接
    room = await connectSfu(s, {
      onRoomCreated: (r) => {
        // 必须在 connect 前订阅事件
        r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          console.log('[remote-preview] track subscribed:', track.kind, 'from', participant.identity)
          if (!track.mediaStreamTrack) return
          if (track.kind === 'video' && videoEl.value) {
            videoEl.value.srcObject = new MediaStream([track.mediaStreamTrack])
            videoEl.value.play().catch((e) => console.warn('[remote-preview] video play:', e))
          } else if (track.kind === 'audio' && audioEl.value) {
            audioEl.value.srcObject = new MediaStream([track.mediaStreamTrack])
            audioEl.value.play().catch(() => {})
          }
        })
        r.on(RoomEvent.TrackUnsubscribed, (track) => {
          console.log('[remote-preview] track unsubscribed:', track.kind)
          if (track.kind === 'video' && videoEl.value) videoEl.value.srcObject = null
        })
        r.on(RoomEvent.ParticipantDisconnected, (p) => {
          console.log('[remote-preview] participant left:', p.identity)
        })
      },
      onDisconnected: () => {
        console.log('[remote-preview] disconnected')
      }
    })
    connecting.value = false
    // 连接成功后请求切换到屏幕
    await switchKind('screen')
  } catch (e: any) {
    console.error('[remote-preview] 连接失败:', e)
    error.value = e?.message || '连接失败'
    connecting.value = false
  }
}

async function switchKind(kind: 'screen' | 'camera' | 'mic') {
  activeKind.value = kind
  try {
    await window.pantry.serverAdminDevStart(props.deviceId, kind)
  } catch (e) {
    console.warn('[remote-preview] dev:start failed:', e)
  }
}

function minWin(): void { void window.pantry.minimizeWindow() }
function toggleWin(): void { void window.pantry.toggleMaximize() }

function close() {
  if (room) { try { room.disconnect() } catch (e) { console.warn('[remote-preview] disconnect:', e) } }
  void window.pantry.closeWindow()
}

onMounted(() => { void start() })
onUnmounted(() => { if (room) { try { room.disconnect() } catch (e) { console.warn('[remote-preview] unmount disconnect:', e) } } })
</script>

<template>
  <div class="rp">
    <div class="rp-titlebar">
      <span class="rp-title"><i class="fas fa-desktop"></i> 远程预览 — {{ deviceName }}</span>
      <div class="rp-winbtns">
        <button class="rp-wb" @click="minWin"><i class="fas fa-minus"></i></button>
        <button class="rp-wb" @click="toggleWin"><i class="far fa-square"></i></button>
        <button class="rp-wb rp-wb-close" @click="close"><i class="fas fa-times"></i></button>
      </div>
    </div>
    <div class="rp-controls">
      <button :class="{ on: activeKind === 'screen' }" @click="switchKind('screen')"><i class="fas fa-desktop"></i> 屏幕</button>
      <button :class="{ on: activeKind === 'camera' }" @click="switchKind('camera')"><i class="fas fa-video"></i> 摄像头</button>
      <button :class="{ on: activeKind === 'mic' }" @click="switchKind('mic')"><i class="fas fa-microphone"></i> 麦克风</button>
    </div>
    <div class="rp-video-wrap">
      <div v-if="connecting" class="rp-loading"><i class="fas fa-spinner fa-spin"></i> 连接中…</div>
      <div v-else-if="error" class="rp-error">{{ error }}</div>
      <template v-else>
        <video ref="videoEl" autoplay playsinline></video>
        <audio ref="audioEl" autoplay></audio>
      </template>
    </div>
  </div>
</template>

<style scoped>
.rp { display: flex; flex-direction: column; height: 100vh; background: #0a0a0a; }
.rp-titlebar { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: #1a1a1a; color: #ccc; -webkit-app-region: drag; }
.rp-title { font-size: 13px; }
.rp-winbtns { display: flex; gap: 4px; -webkit-app-region: no-drag; }
.rp-wb { background: none; border: none; color: #888; cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px; }
.rp-wb:hover { background: #333; color: #fff; }
.rp-wb-close:hover { background: #e81123; }
.rp-controls { display: flex; gap: 8px; padding: 8px 14px; background: #141414; }
.rp-controls button { padding: 6px 14px; border-radius: 6px; border: 1px solid #333; background: #222; color: #aaa; cursor: pointer; font-size: 12px; }
.rp-controls button.on { background: #2b6cb0; border-color: #2b6cb0; color: #fff; }
.rp-video-wrap { flex: 1; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.rp-video-wrap video { width: 100%; height: 100%; object-fit: contain; }
.rp-loading { color: #888; font-size: 14px; }
.rp-error { color: #e74c3c; font-size: 14px; }
</style>
