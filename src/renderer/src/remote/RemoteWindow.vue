<script setup lang="ts">
/**
 * 独立远程控制窗口（控制端）。
 * 无边框 + 主窗口样式 + 可缩放（缩放不压缩内部布局，画面 object-fit: contain）。
 * 窗口内建立 LiveKit SFU 会话：订阅被控端屏幕 + 系统声音（48kHz/2ch），键鼠经
 * LiveKit data 消息发送。窗口关闭自动结束会话并复位/解冻被控端鼠标。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RemoteSession, { type RemoteMode, type RemoteRole, type RemoteInputCapability, type RemoteDisplayMeta, type RemoteDeviceKind } from './RemoteSession'
import { mapRemotePoint, containBox, type RemotePoint } from '../utils/remote-coords'
import { rlog, rwarn } from '../../../shared/remote-log'

const props = defineProps<{
  room: string
  iceServers: RTCIceServer[]
  mode: RemoteMode
  peerId: number
  peerName: string
  meId: number
  sfu?: { url: string; token: string; roomName: string }
}>()

const videoEl = ref<HTMLVideoElement | null>(null)
const holderEl = ref<HTMLDivElement | null>(null)
const stream = ref<MediaStream | null>(null)
const meta = ref<{ w: number; h: number; mode: RemoteMode } | null>(null)
/** 被控端键鼠注入能力：不可用时在界面上说清楚，否则用户会以为「连上了但坏了」 */
const inputCap = ref<RemoteInputCapability | null>(null)
/** 被控端显示器列表与当前活动显示器（会话内下拉切换） */
const displays = ref<RemoteDisplayMeta[]>([])
const activeDisplayId = ref('')
const connected = ref(false)
const errMsg = ref('')

/** 初始输入设备预判：有多点触控能力的平板按触摸，否则按键鼠；首次实际事件会再校正。 */
function detectInitialDevice(): RemoteDeviceKind {
  return navigator.maxTouchPoints > 0 ? 'touch' : 'mouse'
}
/** 按住中（拖动期间即使指针移出画面区也继续追踪；松开后只响应画面区内移动） */
let pressing = false
/** Pointer Lock 状态：锁定后指针锚在画面中心，靠相对位移控制远程光标 */
let locked = false
/** 锁定期间的虚拟远程光标坐标（被控端屏幕像素）；未锁定为 null */
let virt: RemotePoint | null = null

function targetSize(): { w: number; h: number } | null {
  const m = meta.value
  if (!m || !m.w || !m.h) return null
  return { w: m.w, h: m.h }
}

/** 锁定成功：虚拟光标初始放到远程屏幕正中间 */
function initVirtCenter(): void {
  const t = targetSize()
  if (!t) return
  virt = { x: Math.round(t.w / 2), y: Math.round(t.h / 2) }
}

function lockPointer(): void {
  const el = holderEl.value
  if (!el || locked) return
  try {
    const r = el.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined
    if (r && typeof r.catch === 'function') {
      r.catch(() => { try { el.requestPointerLock() } catch { /* 不支持平滑位移就退回默认 */ } })
    }
  } catch {
    try { el.requestPointerLock() } catch { /* Pointer Lock 不可用时退回绝对坐标 */ }
  }
}

function unlockPointer(): void {
  if (locked) { try { document.exitPointerLock() } catch { /* ignore */ } }
}

function onLockChange(): void {
  locked = document.pointerLockElement === holderEl.value
  if (locked) initVirtCenter()
  else virt = null
}

function onLockError(): void {
  rwarn('window', 'Pointer Lock 失败，退回绝对坐标操作')
}

/** 锁定态：按相对位移（movementX/Y）累积虚拟远程光标 */
function moveLocked(e: MouseEvent): void {
  const t = targetSize()
  const holder = holderEl.value
  if (!t || !holder || !virt) return
  const rect = holder.getBoundingClientRect()
  const frameW = videoEl.value?.videoWidth || t.w
  const frameH = videoEl.value?.videoHeight || t.h
  const box = containBox(rect.width, rect.height, frameW, frameH)
  if (box.renderW <= 0 || box.renderH <= 0) return
  const sx = t.w / box.renderW
  const sy = t.h / box.renderH
  virt.x = Math.min(t.w, Math.max(0, Math.round(virt.x + e.movementX * sx)))
  virt.y = Math.min(t.h, Math.max(0, Math.round(virt.y + e.movementY * sy)))
  RemoteSession.sendControl({ t: 'move', x: virt.x, y: virt.y })
}

// ── 键鼠采集 → LiveKit data ──
function screenOf(e: MouseEvent): RemotePoint | null {
  const m = meta.value
  const holder = holderEl.value
  if (!m || !m.w || !m.h || !holder) return null
  const rect = holder.getBoundingClientRect()
  // 帧尺寸取不到时回退被控端屏幕尺寸；映射目标始终是 meta 上报的屏幕尺寸
  const frameW = videoEl.value?.videoWidth || m.w
  const frameH = videoEl.value?.videoHeight || m.h
  return mapRemotePoint(rect, e.clientX, e.clientY, frameW, frameH, m.w, m.h)
}
function btnOf(button: number): 'left' | 'middle' | 'right' {
  return button === 2 ? 'right' : button === 1 ? 'middle' : 'left'
}
function onMouseMove(e: MouseEvent): void {
  RemoteSession.announceDevice('mouse')
  if (locked) { moveLocked(e); return }
  const holder = holderEl.value
  const inside = !!holder && holder.contains(e.target as Node)
  if (!pressing && !inside) return
  const p = screenOf(e)
  if (p) RemoteSession.sendControl({ t: 'move', x: p.x, y: p.y })
}
function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
  RemoteSession.announceDevice('mouse')
  // 阻止浏览器原生拖拽/文本选中，否则按住拖动会进入 HTML5 drag，页面收不到后续 mousemove
  e.preventDefault()
  lockPointer()
  const p = locked && virt ? virt : screenOf(e)
  if (!p) return
  pressing = true
  // 先把光标落到按下点，再按下，保证拖动起点在正确位置
  RemoteSession.sendControl({ t: 'move', x: p.x, y: p.y })
  RemoteSession.sendControl({ t: 'down', btn: btnOf(e.button) })
}
function onMouseUp(e: MouseEvent): void {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
  pressing = false
  RemoteSession.sendControl({ t: 'up', btn: btnOf(e.button) })
}
function onContextMenu(e: MouseEvent): void {
  // 右键拖动时不弹本机菜单，避免打断远程右键按住
  e.preventDefault()
}
function onEnterStage(): void {
  // 指针滑入远程窗口：要求被控端强制显示鼠标（采集帧里可见远程光标）
  RemoteSession.sendControl({ t: 'cursorShow' })
}

// ── 触摸采集（Windows 触控屏平板）：多点触控 down/move/up，长按=触点保持按下 ──
function mapTouch(t: Touch): RemotePoint | null {
  const m = meta.value
  const holder = holderEl.value
  if (!m || !m.w || !m.h || !holder) return null
  const rect = holder.getBoundingClientRect()
  const frameW = videoEl.value?.videoWidth || m.w
  const frameH = videoEl.value?.videoHeight || m.h
  return mapRemotePoint(rect, t.clientX, t.clientY, frameW, frameH, m.w, m.h)
}
function forEachTouch(e: TouchEvent, phase: 'touchdown' | 'touchmove' | 'touchup'): void {
  e.preventDefault()
  RemoteSession.announceDevice('touch')
  for (const t of Array.from(e.changedTouches)) {
    const p = mapTouch(t)
    if (p) RemoteSession.sendControl({ t: phase, touchId: t.identifier, x: p.x, y: p.y })
  }
}
function onTouchStart(e: TouchEvent): void { forEachTouch(e, 'touchdown') }
function onTouchMove(e: TouchEvent): void { forEachTouch(e, 'touchmove') }
function onTouchEnd(e: TouchEvent): void { forEachTouch(e, 'touchup') }

// ── 手柄采集（Gamepad API）：轮询标准映射按键/摇杆，状态变化才上报 ──
let padTimer: ReturnType<typeof setInterval> | null = null
let lastPadKey = ''

function readGamepad(): Gamepad | null {
  if (!navigator.getGamepads) return null
  const pads = navigator.getGamepads()
  for (const p of pads) if (p) return p
  return null
}
function pollGamepad(): void {
  const g = readGamepad()
  if (!g) return
  RemoteSession.announceDevice('gamepad')
  const buttons = g.buttons.map((b) => (b.pressed ? 1 : 0))
  const axes = Array.from(g.axes).map((a) => Number(a.toFixed(3)))
  const key = JSON.stringify({ buttons, axes })
  if (key === lastPadKey) return
  lastPadKey = key
  RemoteSession.sendControl({ t: 'gamepad', buttons, axes })
}
function onPadConnect(): void { lastPadKey = '' }
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  RemoteSession.sendControl({ t: 'scroll', d: e.deltaY })
}
function onKeyDown(e: KeyboardEvent): void {
  const k = e.keyCode || e.which
  if (k) RemoteSession.sendControl({ t: 'kdown', k })
}
function onKeyUp(e: KeyboardEvent): void {
  const k = e.keyCode || e.which
  if (k) RemoteSession.sendControl({ t: 'kup', k })
}
function onSwitchDisplay(e: Event): void {
  const id = (e.target as HTMLSelectElement).value
  if (!id || id === activeDisplayId.value) return
  RemoteSession.requestSwitchDisplay(id)
}

onMounted(() => {
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  document.addEventListener('pointerlockchange', onLockChange)
  document.addEventListener('pointerlockerror', onLockError)
  window.addEventListener('gamepadconnected', onPadConnect)
  window.addEventListener('gamepaddisconnected', onPadConnect)
  padTimer = setInterval(pollGamepad, 50)
  rlog('window', `远程窗口打开 room=${props.room} peer=${props.peerId}(${props.peerName}) mode=${props.mode}`)
  // 窗口被关掉（任务栏 X / Alt+F4 / 系统关闭）时也要收场：
  // 渲染层来得及就自己 stop（会发 bye）；来不及则由主进程在 close 时补发（见 server-ipc）
  window.addEventListener('beforeunload', onBeforeUnload)
  // 建立会话（控制端订阅被控端 SFU 屏幕/声音，键鼠走 LiveKit data）
  RemoteSession.startMaster({
    room: props.room,
    sfu: props.sfu!,
    mode: props.mode,
    meId: props.meId,
    peerId: props.peerId,
    callbacks: {
      onRemoteStream: (s) => {
        rlog('window', `收到远程画面 tracks=${s.getTracks().map((t) => t.kind).join('+')}`)
        stream.value = s
      },
      onMeta: (m) => {
        meta.value = m
        inputCap.value = m.input ?? null
        displays.value = m.displays ?? []
        activeDisplayId.value = m.active ?? ''
        if (m.input && !m.input.ok) {
          rwarn('window', `被控端键鼠注入不可用：${m.input.backend} ${m.input.detail}`)
        }
      },
      onState: (st) => {
        connected.value = st.connected
        if (st.ended) {
          rlog('window', '会话结束 → 关闭远程窗口')
          window.pantry.closeWindow()
        }
      },
      onError: (msg) => {
        rwarn('window', `远程会话错误：${msg}`)
        errMsg.value = msg
        setTimeout(() => window.pantry.closeWindow(), 2600)
      }
    }
  }).then(() => RemoteSession.announceDevice(detectInitialDevice()))
})
function onBeforeUnload(): void {
  // 主动结束：发 bye 通知被控端收场（best-effort，主进程还有一道兜底）
  rlog('window', '窗口即将关闭 → 结束远程会话')
  RemoteSession.stop('window-unload')
}
onBeforeUnmount(() => {
  pressing = false
  unlockPointer()
  document.removeEventListener('mousemove', onMouseMove)
  document.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('keyup', onKeyUp)
  document.removeEventListener('pointerlockchange', onLockChange)
  document.removeEventListener('pointerlockerror', onLockError)
  window.removeEventListener('gamepadconnected', onPadConnect)
  window.removeEventListener('gamepaddisconnected', onPadConnect)
  if (padTimer) { clearInterval(padTimer); padTimer = null }
  window.removeEventListener('beforeunload', onBeforeUnload)
  RemoteSession.stop('window-unmount')
})

watch(
  stream,
  (s) => {
    if (videoEl.value && s) videoEl.value.srcObject = s
  },
  { immediate: true }
)

// ── 无边框标题栏按钮 ──
function minimize(): void { void window.pantry.minimizeWindow() }
function toggleMax(): void { void window.pantry.toggleMaximize() }
function close(): void {
  rlog('window', '点击关闭按钮 → 结束远程会话')
  RemoteSession.stop('window-close')
  window.pantry.closeWindow()
}
</script>

<template>
  <div class="remote-window">
    <!-- 无边框标题栏（拖拽区 + 窗口控制） -->
    <div class="rw-titlebar">
      <div class="rw-title">
        <i class="fas fa-desktop"></i>
        <span>远程控制 · {{ peerName }}</span>
        <span v-if="meta" class="rw-sub">{{ meta.w }}×{{ meta.h }} · {{ meta.mode === 'remote' ? '远程模式' : '本地模式' }}</span>
        <span v-else-if="errMsg" class="rw-sub err">{{ errMsg }}</span>
      </div>
      <div class="rw-winbtns">
        <select
          v-if="displays.length > 1"
          class="rw-display"
          :value="activeDisplayId"
          title="切换被控端显示器"
          @change="onSwitchDisplay"
        >
          <option v-for="d in displays" :key="d.id" :value="d.id">
            {{ d.primary ? '● ' : '' }}{{ d.label }} {{ d.w }}×{{ d.h }}
          </option>
        </select>
        <button class="rw-win" title="最小化" @click="minimize"><i class="fas fa-minus"></i></button>
        <button class="rw-win" title="最大化/还原" @click="toggleMax"><i class="far fa-square"></i></button>
        <button class="rw-win close" title="关闭" @click="close"><i class="fas fa-times"></i></button>
      </div>
    </div>

    <!-- 画面区：缩放不压缩布局（object-fit contain），键鼠事件采集 -->
    <div ref="holderEl" class="rw-stage" @mouseenter="onEnterStage" @mousedown="onMouseDown" @wheel="onWheel" @contextmenu.prevent="onContextMenu" @touchstart="onTouchStart" @touchmove="onTouchMove" @touchend="onTouchEnd" @touchcancel="onTouchEnd">
      <video ref="videoEl" autoplay playsinline muted draggable="false" class="rw-video" />
      <div v-if="!stream" class="rw-loading">
        {{ errMsg || (connected ? '正在建立远程控制连接…' : '等待对端接受远程控制…') }}
      </div>
      <!-- 被控端键鼠注入不可用：直接说清楚原因，别让人以为是"点不动"的玄学问题 -->
      <div v-if="inputCap && !inputCap.ok" class="rw-inputwarn">
        <i class="fas fa-triangle-exclamation"></i>
        <span>对方键鼠不可用（{{ inputCap.backend }}）：{{ inputCap.detail }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remote-window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0e0f12;
  user-select: none;
}
/* 标题栏：主窗口样式，可拖拽 */
.rw-titlebar {
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #16181d;
  border-bottom: 1px solid #262a32;
  -webkit-app-region: drag;
  padding-left: 14px;
}
.rw-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #e8eaed;
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.rw-sub {
  color: #9aa0aa;
  font-size: 12px;
  font-weight: 400;
}
.rw-sub.err {
  color: #f04438;
}
.rw-winbtns {
  display: flex;
  -webkit-app-region: no-drag;
  height: 100%;
  align-items: center;
  gap: 6px;
}
.rw-display {
  -webkit-app-region: no-drag;
  background: #22252c;
  color: #e8eaed;
  border: 1px solid #2f343d;
  border-radius: 6px;
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
  max-width: 220px;
}
.rw-display option {
  background: #16181d;
  color: #e8eaed;
}
.rw-win {
  width: 46px;
  height: 100%;
  border: none;
  background: transparent;
  color: #c9cdd4;
  font-size: 13px;
  cursor: pointer;
}
.rw-win:hover {
  background: rgba(255, 255, 255, 0.08);
}
.rw-win.close:hover {
  background: #d93026;
  color: #fff;
}
/* 画面区：可缩放，布局不压缩 */
.rw-stage {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  /* 禁止浏览器原生触摸滚动/缩放手势，保证 touchmove 全程可采集 */
  touch-action: none;
  /* 本地原生光标隐藏，光标以远程画面内嵌的被控端光标为准 */
  cursor: none;
}
.rw-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
  /* 禁止原生拖拽/选中，保证按住拖动全程能收到 mousemove */
  -webkit-user-drag: none;
  user-select: none;
  pointer-events: none;
}
.rw-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9aa0aa;
  font-size: 15px;
}
/* 被控端键鼠注入不可用提示（贴近画面底部，不挡操作） */
.rw-inputwarn {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  max-width: 90%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 8px;
  background: rgba(255, 125, 0, 0.94);
  color: #fff;
  font-size: 12.5px;
  line-height: 1.5;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
</style>
