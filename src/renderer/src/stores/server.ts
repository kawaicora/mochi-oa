import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ServerClientState, ServerSettings } from '@shared/server-types'

/** 服务器连接 + 会话 store（唯一事实来源）。 */
export const useServerStore = defineStore('server', () => {
  const state = ref<ServerClientState>({
    connected: false,
    state: 'idle',
    serverUrl: '',
    userId: undefined,
    username: undefined,
    token: undefined,
    error: undefined,
    activeCompanyId: 0
  })
  const settings = ref<ServerSettings>({ serverUrl: '', token: '', fileTransferMode: 'local', downloadDir: '', autoDownload: true })

  const isAuthenticated = computed(() => !!state.value.userId)

  async function init(): Promise<void> {
    const [s, cfg] = await Promise.all([window.pantry.serverGetState(), window.pantry.serverGetSettings()])
    state.value = s
    settings.value = cfg
  }

  function wire(): () => void {
    const off = window.pantry.onServerState((s) => {
      state.value = s
    })
    return off
  }

  async function setServerUrl(url: string): Promise<void> {
    settings.value.serverUrl = url
    settings.value = await window.pantry.serverSaveSettings({ serverUrl: url })
  }

  async function connect(): Promise<void> {
    await window.pantry.serverConnect(settings.value.serverUrl, settings.value.token)
  }

  async function login(username: string, password?: string, code?: string): Promise<boolean> {
    const ack = await window.pantry.serverLogin(username, password, code)
    if (ack.ok && ack.token) {
      settings.value.token = ack.token
      settings.value = await window.pantry.serverSaveSettings({ token: ack.token })
      return true
    }
    return false
  }

  async function register(username: string, password: string, nick?: string, email?: string, avatarPath?: string, code?: string): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverRegister(username, password, nick, email, avatarPath, code)
    if (ack.ok) {
      // 服务端 auth:register 会让当前 socket 自动登录并返回 token，
      // 客户端必须重置该认证态，否则 isAuthenticated 变 true → 直接进主界面，
      // 无法"注册后回登录页"。这里显式 logout，把 userId 清掉、切回登录。
      await window.pantry.serverLogout()
      settings.value.token = ''
      settings.value = await window.pantry.serverSaveSettings({ token: '' })
    }
    return { ok: ack.ok, error: ack.error }
  }

  /** ws/wss → http(s) 取服务访问根地址（用于拼接重置链接） */
  function httpBase(url: string): string {
    return (url || '')
      .replace(/^wss:/i, 'https:')
      .replace(/^ws:/i, 'http:')
      .replace(/\/+$/, '')
  }

  /** 忘记密码：发送重置验证码到绑定邮箱 */
  async function sendResetCode(email: string): Promise<{ ok: boolean; error?: string }> {
    return window.pantry.serverSendResetCode(email)
  }

  /** 忘记密码：验证码通过 → 服务端发送重置密码邮件（含 /view/reset-pwd 链接） */
  async function sendResetMail(email: string, code: string): Promise<{ ok: boolean; error?: string }> {
    return window.pantry.serverSendResetMail(email, code, httpBase(settings.value.serverUrl))
  }

  async function logout(): Promise<void> {
    await window.pantry.serverLogout()
    settings.value.token = ''
    settings.value = await window.pantry.serverSaveSettings({ token: '' })
  }

  async function setActiveCompany(companyId: number): Promise<void> {
    await window.pantry.serverSetActiveCompany(companyId)
  }

  // ─── 登录会话（多端）/ 账号安全 ──────────────────────────
  async function listSessions(): Promise<{
    sessions: import('@shared/server-types').ServerSession[]
    currentSessionId?: number
    sessionDays?: number | null
  }> {
    const ack = await window.pantry.serverSessions()
    const d = ack.data as { sessions?: import('@shared/server-types').ServerSession[]; currentSessionId?: number; sessionDays?: number | null }
    return { sessions: d?.sessions ?? [], currentSessionId: d?.currentSessionId, sessionDays: d?.sessionDays ?? null }
  }

  async function endSession(sessionId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverEndSession(sessionId)
    return { ok: ack.ok, error: ack.error }
  }

  async function endAllSessions(): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverEndAllSessions()
    return { ok: ack.ok, error: ack.error }
  }

  async function setSessionDays(days: number | null): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverSetSessionDays(days)
    return { ok: ack.ok, error: ack.error }
  }

  /** 本端会话被踢下线/过期：清掉持久化 token，回登录页 */
  async function clearSession(): Promise<void> {
    settings.value.token = ''
    settings.value = await window.pantry.serverSaveSettings({ token: '' })
  }

  return {
    state,
    settings,
    isAuthenticated,
    init,
    wire,
    setServerUrl,
    connect,
    login,
    register,
    sendResetCode,
    sendResetMail,
    logout,
    setActiveCompany,
    listSessions,
    endSession,
    endAllSessions,
    setSessionDays,
    clearSession
  }
})
