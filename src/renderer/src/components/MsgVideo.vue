<script setup lang="ts">
/**
 * 聊天内视频预览（支持完整播放控制器）：
 *  - FLV            → flv.js（MediaSource 解码，读本地缓存 bytes → Blob）
 *  - rm/avi/mkv/3gp/3gpp/rmvb/asf/wmv/vob/ts 等浏览器不支持的格式
 *                    → 服务端 ffmpeg 转码（/api/transcode），返回 h264+aac mp4 流播
 *  - 其余（mp4/webm/mov/m4v/ogg）→ 原生 <video>；优先本地缓存 Blob（避免 file:// 被拒），否则远程 URL
 * 点击封面播放；控制条含播放/暂停、进度、时间、音量、倍速、全屏。
 */
import { ref, onMounted, onBeforeUnmount, watch, computed } from 'vue'
import flvjs from 'flv.js'

type FlvPlayer = ReturnType<typeof flvjs.createPlayer>

const props = defineProps<{
  /** 预览地址（可能为 file:// 或远程 http URL） */
  src: string
  /** 本地缓存绝对路径（自动下载后；flv 解码 / 原生 Blob 用） */
  path?: string
  /** 消息原文 URL（http://host/files/{公司}/{文件}；用于取服务端 origin 与相对路径） */
  content: string
  /** 文件名（判断扩展名） */
  name: string
  /** 服务端地址（content 非 http 时回退用） */
  serverUrl?: string
  /** 大尺寸模式（单独预览窗口/MediaPreview 内使用） */
  big?: boolean
}>()

const playing = ref(false)
const errMsg = ref('')
const videoEl = ref<HTMLVideoElement | null>(null)
const current = ref(0)
const duration = ref(0)
const volume = ref(1)
const muted = ref(false)
const rate = ref(1)
const showCtrl = ref(false)
const ctrlTimer = ref<ReturnType<typeof setTimeout> | undefined>(undefined)
const isFull = ref(false)

let player: FlvPlayer | null = null
let objectUrl = ''

/** 需要服务端 ffmpeg 转码才能播放的扩展名（Chromium 原生不支持的容器/编码） */
const TRANSCODE_EXTS = new Set(['rm', 'rmvb', 'avi', '3gp', '3gpp', 'mkv', 'asf', 'wmv', 'vob', 'ts', 'm2ts', 'mts', 'divx', 'xvid'])
const FLV_RE = /\.flv(\?|$)/i
const isFlv = (n: string): boolean => FLV_RE.test(n)
function extOf(name: string): string {
  const m = String(name).match(/\.([a-z0-9]{2,5})(\?|$)/i)
  return m ? m[1].toLowerCase() : ''
}
function needsTranscode(name: string): boolean {
  return TRANSCODE_EXTS.has(extOf(name))
}

/** 从消息 content 推导服务端 origin */
function serverOrigin(): string {
  if (/^https?:\/\//i.test(props.content)) {
    try {
      return new URL(props.content).origin
    } catch {
      /* ignore */
    }
  }
  return String(props.serverUrl ?? '').replace(/\/+$/, '')
}

/** 构造转码 URL：/files/{rel} → /api/transcode?src={rel} */
function transcodeUrl(): string {
  const origin = serverOrigin()
  const rel = props.content.replace(/^https?:\/\/[^/]+/, '').replace(/^\/files\//, '')
  return `${origin}/api/transcode?src=${encodeURIComponent(rel)}`
}

/** 读本地缓存字节（path 缺失时按需下载） */
async function readLocalBytes(): Promise<ArrayBuffer | null> {
  let p = props.path
  if (!p) {
    const dl = await window.pantry.serverDownloadFile(props.content)
    if (dl.ok && dl.path) p = dl.path
  }
  if (!p) return null
  const rb = await window.pantry.serverReadFileBytes(p)
  if (!rb.ok || !rb.data) return null
  return rb.data
}

/** 原生播放：直接用远程 http URL 流播（CSP media-src 已放行 http/https，规避 file:// 被拒） */
function nativeSetup(): void {
  const el = videoEl.value
  if (!el || errMsg.value) return
  el.src = props.content || props.src
  el.load()
}

async function flvSetup(): Promise<void> {
  const el = videoEl.value
  if (!el) return
  const bytes = await readLocalBytes()
  if (!bytes) {
    errMsg.value = '视频文件不可用，请重新发送'
    return
  }
  const blob = new Blob([bytes], { type: 'video/x-flv' })
  objectUrl = URL.createObjectURL(blob)
  const { default: flvjs } = await import('flv.js')
  if (!flvjs.isSupported()) {
    errMsg.value = '当前环境不支持 FLV 解码'
    return
  }
  player = flvjs.createPlayer({ type: 'flv', url: objectUrl, isLive: false })
  player.attachMediaElement(el)
  player.load()
}

/** 需要转码的格式：直接用服务端转码后的 mp4 */
function transcodeSetup(): void {
  const el = videoEl.value
  if (!el) return
  const origin = serverOrigin()
  if (!origin) {
    errMsg.value = '无法确定服务器地址，转码失败'
    return
  }
  el.src = transcodeUrl()
  el.load()
}

function setup(): void {
  if (isFlv(props.name)) {
    void flvSetup()
  } else if (needsTranscode(props.name)) {
    transcodeSetup()
  } else {
    nativeSetup()
  }
}

onMounted(setup)
watch(() => props.src, () => setup())

function togglePlay(): void {
  const el = videoEl.value
  if (!el || errMsg.value) return
  if (playing.value) {
    el.pause()
    playing.value = false
  } else {
    void el.play()
      .then(() => { playing.value = true })
      .catch(() => { errMsg.value = '无法播放该视频源' })
  }
}

function onTimeUpdate(): void {
  const el = videoEl.value
  if (!el) return
  current.value = el.currentTime
}
function onLoaded(): void {
  const el = videoEl.value
  if (!el) return
  duration.value = isFinite(el.duration) ? el.duration : 0
}
function onEnded(): void {
  playing.value = false
}
function onVolume(): void {
  const el = videoEl.value
  if (!el) return
  volume.value = el.volume
  muted.value = el.muted
}

function seekTo(v: number): void {
  const el = videoEl.value
  if (!el) return
  el.currentTime = v
  current.value = v
}
function setVolume(v: number): void {
  const el = videoEl.value
  if (!el) return
  el.volume = v
  el.muted = false
  volume.value = v
  muted.value = false
}
function toggleMute(): void {
  const el = videoEl.value
  if (!el) return
  el.muted = !el.muted
  muted.value = el.muted
}
function setRate(r: number): void {
  const el = videoEl.value
  if (!el) return
  rate.value = r
  el.playbackRate = r
}
function toggleFullscreen(): void {
  const el = videoEl.value
  if (!el) return
  if (document.fullscreenElement) {
    void document.exitFullscreen()
  } else {
    void el.requestFullscreen().catch(() => { /* ignore */ })
  }
}
function onFullscreenChange(): void {
  isFull.value = !!document.fullscreenElement
  showCtrl.value = true
}

function showControls(): void {
  showCtrl.value = true
  if (ctrlTimer.value) clearTimeout(ctrlTimer.value)
  ctrlTimer.value = setTimeout(() => { if (!isFull.value) showCtrl.value = false }, 2600)
}
function hideControls(): void {
  if (ctrlTimer.value) clearTimeout(ctrlTimer.value)
  if (!isFull.value) showCtrl.value = false
}

function fmtTime(t: number): string {
  if (!isFinite(t) || t < 0) return '00:00'
  const s = Math.floor(t)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`
}
const progress = computed(() => (duration.value > 0 ? (current.value / duration.value) * 100 : 0))

onBeforeUnmount(() => {
  if (player) player.destroy()
  player = null
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = ''
  if (ctrlTimer.value) clearTimeout(ctrlTimer.value)
})
</script>

<template>
  <div
    class="msg-video-wrap"
    :class="{ big: big, full: isFull }"
    @mouseenter="showControls"
    @mouseleave="hideControls"
  >
    <video
      ref="videoEl"
      class="msg-video"
      preload="metadata"
      playsinline
      @click="togglePlay"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoaded"
      @durationchange="onLoaded"
      @ended="onEnded"
      @volumechange="onVolume"
      @play="playing = true"
      @pause="playing = false"
      @fullscreenchange="onFullscreenChange"
    ></video>

    <!-- 封面播放按钮 -->
    <div v-if="!playing && !errMsg" class="msg-video-play" @click="togglePlay"><i class="fas fa-play"></i></div>
    <div v-if="errMsg" class="msg-video-err"><i class="fas fa-exclamation-triangle"></i>&nbsp;{{ errMsg }}</div>

    <!-- 完整播放控制条 -->
    <div v-if="playing && !errMsg && showCtrl" class="msg-ctrl">
      <button class="mc-btn" title="播放/暂停" @click="togglePlay"><i :class="playing ? 'fas fa-pause' : 'fas fa-play'"></i></button>
      <span class="mc-time">{{ fmtTime(current) }}</span>
      <input
        class="mc-range"
        type="range"
        min="0"
        :max="duration || 0"
        step="0.1"
        :value="current"
        @input="seekTo(Number(($event.target as HTMLInputElement).value))"
      />
      <span class="mc-time">{{ fmtTime(duration) }}</span>
      <select class="mc-rate" :value="rate" @change="setRate(Number(($event.target as HTMLSelectElement).value))">
        <option :value="0.5">0.5x</option>
        <option :value="1">1x</option>
        <option :value="1.5">1.5x</option>
        <option :value="2">2x</option>
      </select>
      <div class="mc-vol">
        <button class="mc-btn" title="静音" @click="toggleMute"><i :class="muted || volume === 0 ? 'fas fa-volume-mute' : 'fas fa-volume-up'"></i></button>
        <input
          class="mc-range mc-vol-range"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="muted ? 0 : volume"
          @input="setVolume(Number(($event.target as HTMLInputElement).value))"
        />
      </div>
      <button class="mc-btn" title="全屏" @click="toggleFullscreen"><i class="fas fa-expand"></i></button>
    </div>
  </div>
</template>

<style scoped>
.msg-video-wrap {
  position: relative;
  display: inline-block;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  line-height: 0;
  max-width: 300px;
  max-height: 220px;
  background: #000;
}
.msg-video-wrap.big {
  max-width: 100%;
  max-height: 100%;
  width: 100%;
  border-radius: 0;
}
.msg-video {
  width: 300px;
  max-height: 220px;
  display: block;
  background: #000;
}
.msg-video-wrap.big .msg-video {
  width: 100%;
  max-height: 70vh;
  height: auto;
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
.msg-video-err {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: rgba(0, 0, 0, 0.6);
  color: #ffb3b3;
  font-size: 13px;
  padding: 0 12px;
  text-align: center;
  line-height: 1.4;
}
/* 播放控制条 */
.msg-ctrl {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.85));
  line-height: 1;
  box-sizing: border-box;
}
.mc-btn {
  background: none;
  border: none;
  color: #fff;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 4px;
  flex-shrink: 0;
}
.mc-time {
  font-size: 12px;
  color: #fff;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.mc-range {
  flex: 1;
  min-width: 40px;
  height: 4px;
  -webkit-appearance: none;
  appearance: none;
  background: rgba(255, 255, 255, 0.35);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.mc-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
}
.mc-rate {
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  padding: 1px 2px;
  flex-shrink: 0;
  outline: none;
}
.mc-vol {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.mc-vol-range {
  width: 56px;
  flex: none;
}
</style>
