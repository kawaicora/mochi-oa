<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useServerStore } from './stores/server'
import { useAppStore } from './stores/app'
import { useRtcStore } from './stores/rtc'
import LoginScreen from './components/LoginScreen.vue'
import MainScreen from './components/MainScreen.vue'
import IncomingCallModal from './components/IncomingCallModal.vue'
import type { NewDeviceLoginEvent, SessionRevokedEvent } from '@shared/server-types'

const server = useServerStore()
const app = useAppStore()
const rtc = useRtcStore()
const booted = ref(false)

const authenticated = computed(() => server.isAuthenticated)

// 窗口模式与登录态对齐：已登录→主窗口尺寸(可缩放/可最大化)；未登录→固定 480x638 登录模式。
// 覆盖三条路径：手动登录、自动登录(已存 token 启动即进主界面)、登出/被踢/过期回登录页。
watch(authenticated, (v, prev) => {
  if (!booted.value) return
  void (v ? window.pantry.setMainMode() : window.pantry.setLoginMode())
  void prev
})

// 轻量弹窗提醒（新设备登录等）
interface Toast { id: number; text: string; kind: 'info' | 'warn' }
const toasts = ref<Toast[]>([])
let toastSeq = 1
function toast(text: string, kind: 'info' | 'warn' = 'info'): void {
  const id = toastSeq++
  toasts.value.push({ id, text, kind })
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }, 5000)
}
function fmtAt(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(async () => {
  await server.init()
  const off = server.wire()
  await server.connect()

  // 实时推送 → 主界面 store
  const offMsg = window.pantry.onServerMessage(app.onServerMessage)
  const offDeleted = window.pantry.onServerMessageDeleted(app.onServerMessageDeleted)
  const offPresence = window.pantry.onServerPresence(app.onServerPresence)

  // 多会话：新设备登录弹窗提醒；本端会话被踢/过期 → 清 token 回登录页
  const offNewDevice = window.pantry.onServerSessionNewDevice((d: NewDeviceLoginEvent) => {
    toast(`你的账号于 ${fmtAt(d.at)} 在「${d.device}」(${d.ip}) 登录`, 'warn')
  })
  const offRevoked = window.pantry.onServerSessionRevoked((d: SessionRevokedEvent) => {
    toast(d.reason === 'ended' ? '你的账号已在其他设备退出登录，本端已下线' : '登录会话已过期，请重新登录', 'warn')
    void server.clearSession()
  })

  booted.value = true
  // 启动时按当前登录态应用一次窗口模式（自动登录成功时 authenticated 可能已为 true）
  void (authenticated.value ? window.pantry.setMainMode() : window.pantry.setLoginMode())
  // 清理在应用卸载时由环境隐式完成；保留引用
  const offRtc = rtc.wire()
  void off
  void offMsg
  void offDeleted
  void offPresence
  void offNewDevice
  void offRevoked
  void offRtc
})
</script>

<template>
  <LoginScreen v-if="booted && !authenticated" />
  <MainScreen v-else-if="booted && authenticated" />
  <div v-else class="boot-splash">麻薯 OA 加载中…</div>

  <!-- 全局通话：来电弹窗 + 全屏通话浮层 -->
  <IncomingCallModal />

  <!-- 全局弹窗提醒 -->
  <transition-group name="toast" tag="div" class="toast-wrap">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="t.kind">
      <i class="fas fa-info-circle" v-if="t.kind === 'info'"></i>
      <i class="fas fa-exclamation-triangle" v-else></i>
      <span>{{ t.text }}</span>
    </div>
  </transition-group>
</template>

<style scoped>
.boot-splash {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dt-text-3);
  background: #fff;
}
.toast-wrap {
  position: fixed;
  top: 18px;
  right: 18px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 320px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
  background: #fff;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16);
  border: 1px solid var(--dt-border-light);
  color: var(--dt-text-2);
}
.toast.warn {
  border-color: #ffb020;
  color: #b36d00;
  background: #fffdf5;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.25s, transform 0.25s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
