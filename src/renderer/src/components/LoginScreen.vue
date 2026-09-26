<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useServerStore } from '../stores/server'
import UserAvatar from './UserAvatar.vue'

const server = useServerStore()

// ─── 顶部 tab：账号登录 / 扫码登录（置顶左上） ───
const tab = ref<'account' | 'qrcode'>('account')

// ─── 账号信息（记住上次用户：显示昵称头像，可编辑） ───
const nick = ref('')
const account = ref('') // 手机号/账号
const password = ref('')
const showPwd = ref(false)
// 登录方式：密码 / 验证码
const loginMode = ref<'password' | 'code'>('password')
const code = ref('')
const codeSending = ref(false)
const codeCountdown = ref(0)
let codeTimer: number | null = null
const autoLogin = ref(true)
const busy = ref(false)
const errorMsg = ref('')
const successMsg = ref('')

// ─── 注册弹窗 ───
const showRegister = ref(false)
const regAccount = ref('')
const regPassword = ref('')
const regNick = ref('')
const regEmail = ref('')
const regCode = ref('')
const regCodeSending = ref(false)
const regCodeCountdown = ref(0)
let regCodeTimer: number | null = null
const regBusy = ref(false)
const regError = ref('')
const regAvatar = ref('') // 注册时可选的本地头像文件路径

function regAvatarName(): string {
  const p = regAvatar.value
  if (!p) return ''
  const parts = p.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || p
}
async function pickRegAvatar(): Promise<void> {
  const p = await window.pantry.pickFile('image')
  if (p) regAvatar.value = p
}

async function sendRegCode(): Promise<void> {
  const e = regEmail.value.trim()
  if (!e) { regError.value = '请先填写邮箱'; return }
  if (!/.+@.+\..+/.test(e)) { regError.value = '邮箱格式不正确'; return }
  regCodeSending.value = true
  regError.value = ''
  try {
    const r = await window.pantry.serverSendEmailCode(e, 'register')
    if (!r.ok) { regError.value = r.error || '发送失败'; return }
    regCodeCountdown.value = 60
    if (regCodeTimer) clearInterval(regCodeTimer)
    regCodeTimer = window.setInterval(() => {
      regCodeCountdown.value -= 1
      if (regCodeCountdown.value <= 0 && regCodeTimer) {
        clearInterval(regCodeTimer)
        regCodeTimer = null
      }
    }, 1000)
  } catch (e) {
    regError.value = e instanceof Error ? e.message : String(e)
  } finally {
    regCodeSending.value = false
  }
}

// ─── 忘记密码弹窗 ───
const showForgot = ref(false)
const forgotEmail = ref('')
const forgotCode = ref('')
const forgotSending = ref(false)
const forgotCountdown = ref(0)
let forgotTimer: number | null = null
const forgotBusy = ref(false)
const forgotError = ref('')

function openForgot(): void {
  forgotError.value = ''
  forgotEmail.value = ''
  forgotCode.value = ''
  forgotCountdown.value = 0
  showForgot.value = true
}

async function sendForgotCode(): Promise<void> {
  const e = forgotEmail.value.trim()
  if (!e) { forgotError.value = '请填写邮箱'; return }
  if (!/.+@.+\..+/.test(e)) { forgotError.value = '邮箱格式不正确'; return }
  forgotSending.value = true
  forgotError.value = ''
  try {
    const r = await server.sendResetCode(e)
    if (!r.ok) { forgotError.value = r.error || '发送失败'; return }
    forgotCountdown.value = 60
    if (forgotTimer) clearInterval(forgotTimer)
    forgotTimer = window.setInterval(() => {
      forgotCountdown.value -= 1
      if (forgotCountdown.value <= 0 && forgotTimer) {
        clearInterval(forgotTimer)
        forgotTimer = null
      }
    }, 1000)
  } catch (e) {
    forgotError.value = e instanceof Error ? e.message : String(e)
  } finally {
    forgotSending.value = false
  }
}

async function doForgot(): Promise<void> {
  if (forgotEmail.value.trim().length === 0 || forgotCode.value.trim().length === 0) {
    forgotError.value = '请填写邮箱与验证码'
    return
  }
  forgotBusy.value = true
  forgotError.value = ''
  try {
    const r = await server.sendResetMail(forgotEmail.value.trim(), forgotCode.value.trim())
    if (!r.ok) { forgotError.value = r.error || '发送失败'; return }
    showForgot.value = false
    successMsg.value = '重置邮件已发送到邮箱，请打开邮件中的链接重置密码'
    forgotEmail.value = ''
    forgotCode.value = ''
  } catch (e) {
    forgotError.value = e instanceof Error ? e.message : String(e)
  } finally {
    forgotBusy.value = false
  }
}

// ─── 服务器设置弹窗 ───
const showSettings = ref(false)
const srvHost = ref('')
const srvPort = ref('')
const srvProtocol = ref<'http' | 'https'>('http')
const srvError = ref('')

const canLogin = computed(() => {
  if (busy.value) return false
  if (account.value.trim().length === 0) return false
  return loginMode.value === 'code' ? code.value.trim().length > 0 : password.value.length > 0
})

function switchLoginMode(): void {
  loginMode.value = loginMode.value === 'password' ? 'code' : 'password'
  code.value = ''
  errorMsg.value = ''
}

function startCountdown(): void {
  codeCountdown.value = 60
  if (codeTimer) clearInterval(codeTimer)
  codeTimer = window.setInterval(() => {
    codeCountdown.value -= 1
    if (codeCountdown.value <= 0 && codeTimer) {
      clearInterval(codeTimer)
      codeTimer = null
    }
  }, 1000)
}

async function sendLoginCode(): Promise<void> {
  const a = account.value.trim()
  if (!a) { errorMsg.value = '请输入账号（用户名或邮箱）'; return }
  if (!a.includes('@')) { errorMsg.value = '验证码登录需输入已绑定邮箱的账号'; return }
  codeSending.value = true
  errorMsg.value = ''
  successMsg.value = ''
  try {
    const r = await window.pantry.serverSendEmailCode(a, 'login')
    if (!r.ok) { errorMsg.value = r.error || '发送失败'; return }
    startCountdown()
    successMsg.value = '验证码已发送到邮箱'
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    codeSending.value = false
  }
}

function buildServerUrl(): string {
  const host = srvHost.value.trim() || '127.0.0.1'
  const port = srvPort.value.trim() || '3000'
  return `${srvProtocol.value}://${host}:${port}`
}

async function openSettings(): Promise<void> {
  const cfg = await window.pantry.serverGetSettings()
  try {
    const u = new URL(cfg.serverUrl)
    srvProtocol.value = u.protocol === 'https:' ? 'https' : 'http'
    srvHost.value = u.hostname
    srvPort.value = u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    srvHost.value = '127.0.0.1'
    srvPort.value = '3000'
    srvProtocol.value = 'http'
  }
  srvError.value = ''
  showSettings.value = true
}

async function saveSettings(): Promise<void> {
  const url = buildServerUrl()
  srvError.value = ''
  try {
    await server.setServerUrl(url)
    server.settings.token = ''
    await window.pantry.serverSaveSettings({ token: '' })
    await window.pantry.serverConnect(url, undefined)
    showSettings.value = false
  } catch (e) {
    srvError.value = e instanceof Error ? e.message : String(e)
  }
}

async function doLogin(): Promise<void> {
  if (!canLogin.value) return
  busy.value = true
  errorMsg.value = ''
  successMsg.value = ''
  try {
    const ok = loginMode.value === 'code'
      ? await server.login(account.value.trim(), undefined, code.value.trim())
      : await server.login(account.value.trim(), password.value)
    if (!ok) {
      errorMsg.value = server.state.error || '账号或密码错误'
    } else {
      successMsg.value = '登录成功'
      password.value = ''
      // 登录成功 → 切换为主窗口模式（可缩放、恢复大尺寸）
      void window.pantry.setMainMode()
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function doRegister(): Promise<void> {
  if (regAccount.value.trim().length === 0 || regPassword.value.length === 0) {
    regError.value = '请填写账号与密码'
    return
  }
  regBusy.value = true
  regError.value = ''
  try {
    const r = await server.register(
      regAccount.value.trim(),
      regPassword.value,
      regNick.value.trim() || undefined,
      regEmail.value.trim() || undefined,
      regAvatar.value || undefined,
      regCode.value.trim() || undefined
    )
    if (r.ok) {
      // 注册成功 → 跳到登录页：关弹窗、切回账号登录、预填账号，不自动登录
      showRegister.value = false
      tab.value = 'account'
      account.value = regAccount.value.trim()
      password.value = ''
      successMsg.value = '注册成功，请登录'
      // 清空注册表单，方便再次注册
      regAccount.value = ''
      regPassword.value = ''
      regNick.value = ''
      regEmail.value = ''
      regAvatar.value = ''
    } else {
      regError.value = r.error || '注册失败'
    }
  } catch (e) {
    regError.value = e instanceof Error ? e.message : String(e)
  } finally {
    regBusy.value = false
  }
}

onMounted(async () => {
  const appInfo = await window.pantry.getAppInfo()
  const cfg = await window.pantry.serverGetSettings()
  // 若已记住会话（重启自动恢复），用服务端返回的用户名回填问候语
  if (server.state.username) nick.value = server.state.username
  void appInfo
  void cfg
})

// 窗口控制
const minWin = () => window.pantry.minimizeWindow()
const closeWin = () => window.pantry.closeWindow()
</script>

<template>
  <div class="login-root">
    <!-- 顶部：tab（左上）+ 设置 + 窗口控制 -->
    <div class="login-top drag-region">
      <div class="login-tabs no-drag">
        <div
          class="login-tab"
          :class="{ active: tab === 'account' }"
          @click="tab = 'account'"
        >账号登录</div>
        <div
          class="login-tab"
          :class="{ active: tab === 'qrcode' }"
          @click="tab = 'qrcode'"
        >扫码登录</div>
      </div>
      <div class="login-top-right no-drag">
        <button class="icon-btn" title="服务器设置" @click="openSettings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <div class="win-controls">
          <button class="win-btn" @click="minWin">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button class="win-btn win-close" @click="closeWin">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 中部：头像（猫耳）+ 问候 + 表单 -->
    <div class="login-body">
      <!-- 账号登录 tab -->
      <template v-if="tab === 'account'">
        <div class="avatar-ring">
          <div class="avatar">
            <!-- 已记住会话且有头像 → 显示头像；否则默认人像（白色人形 FONT-ICON） -->
            <UserAvatar v-if="server.state.avatar" :nick="server.state.nick || '?'" :avatar="server.state.avatar" :size="86" />
            <svg v-else viewBox="0 0 120 120" width="88" height="88">
              <circle cx="60" cy="44" r="21" fill="#fff" />
              <path d="M24 102c0-19 17-31 36-31s36 12 36 31z" fill="#fff" />
            </svg>
          </div>
        </div>
        <h1 class="greeting">{{ nick.trim() ? `你好，${nick.trim()}` : '你好' }}</h1>

        <div class="form">
          <!-- 账号 -->
          <div class="field">
            <input
              class="field-input"
              v-model="account"
              type="text"
              placeholder="账号"
              maxlength="64"
            />
            <button v-if="account" class="field-clear" title="清空" @click="account = ''">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
            </button>
          </div>
          <!-- 密码（密码登录模式） -->
          <div v-if="loginMode === 'password'" class="field">
            <input
              class="field-input"
              v-model="password"
              :type="showPwd ? 'text' : 'password'"
              placeholder="请输入密码"
              maxlength="128"
              @keydown.enter="doLogin"
            />
            <button class="field-icon" :title="showPwd ? '隐藏密码' : '显示密码'" @click="showPwd = !showPwd">
              <svg v-if="!showPwd" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
            </button>
          </div>
          <!-- 验证码（验证码登录模式） -->
          <div v-else class="field">
            <input
              class="field-input"
              v-model="code"
              type="text"
              placeholder="请输入邮箱验证码"
              maxlength="6"
              @keydown.enter="doLogin"
            />
            <button class="code-send-btn" :disabled="codeCountdown > 0 || codeSending" @click="sendLoginCode">
              {{ codeCountdown > 0 ? `${codeCountdown}s` : (codeSending ? '发送中…' : '发送验证码') }}
            </button>
          </div>
        </div>

        <button class="login-btn" :class="{ enabled: canLogin }" :disabled="!canLogin" @click="doLogin">
          {{ busy ? '登录中…' : '登录' }}
        </button>

        <div v-if="errorMsg" class="login-msg login-error">{{ errorMsg }}</div>
        <div v-else-if="successMsg" class="login-msg login-success">{{ successMsg }}</div>

        <div class="login-sub">
          <label class="checkbox">
            <input type="checkbox" v-model="autoLogin" />
            <span class="checkmark"></span>
            <span>自动登录</span>
          </label>
          <div class="login-links">
            <span class="link" @click="openForgot">忘记密码</span>
            <span class="link" @click="switchLoginMode">{{ loginMode === 'password' ? '验证码登录' : '密码登录' }}</span>
          </div>
        </div>
      </template>

      <!-- 扫码登录 tab（不实现，仅展示占位） -->
      <template v-else>
        <div class="qrcode-box">
          <div class="qrcode-placeholder">
            <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3">
              <rect x="3" y="3" width="7" height="7" rx="1.5"/>
              <rect x="14" y="3" width="7" height="7" rx="1.5"/>
              <rect x="3" y="14" width="7" height="7" rx="1.5"/>
              <line x1="14" y1="14" x2="14" y2="14"/><line x1="17" y1="14" x2="21" y2="14"/>
              <line x1="14" y1="17" x2="17" y2="17"/><line x1="18" y1="18" x2="21" y2="21"/>
            </svg>
          </div>
          <p class="qr-tip">请使用 Mochi 手机端扫码登录</p>
        </div>
      </template>
    </div>

    <!-- 底部：注册账号 + 企业账号 -->
    <div class="login-footer">
      <span class="footer-link" @click="showRegister = true">注册账号</span>
      <span class="footer-link footer-enterprise">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
          <rect x="4" y="8" width="16" height="12" rx="2"/>
          <path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M12 13v3"/>
        </svg>
        企业账号
      </span>
    </div>

    <!-- ─── 服务器设置弹窗 ─── -->
    <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
      <div class="modal">
        <div class="modal-head">服务器设置</div>
        <div class="modal-body">
          <p class="modal-desc">填写连接的服务端地址与端口</p>
          <div class="srv-row">
            <select v-model="srvProtocol" class="srv-select">
              <option value="http">http://</option>
              <option value="https">https://</option>
            </select>
            <input v-model="srvHost" class="srv-input" placeholder="127.0.0.1" />
            <span class="srv-colon">:</span>
            <input v-model="srvPort" class="srv-input srv-port" placeholder="3000" />
          </div>
          <div v-if="srvError" class="login-error">{{ srvError }}</div>
          <p class="srv-preview">连接地址：{{ buildServerUrl() }}</p>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showSettings = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="saveSettings">保存并连接</button>
        </div>
      </div>
    </div>

    <!-- ─── 注册弹窗 ─── -->
    <div v-if="showRegister" class="modal-mask" @click.self="showRegister = false">
      <div class="modal">
        <div class="modal-head">注册账号</div>
        <div class="modal-body">
          <div class="reg-field">
            <input v-model="regAccount" class="srv-input" placeholder="用户名（登录用）" maxlength="64" />
          </div>
          <div class="reg-field">
            <input v-model="regPassword" type="password" class="srv-input" placeholder="密码（至少 6 位）" maxlength="128" />
          </div>
          <div class="reg-field">
            <input v-model="regNick" class="srv-input" placeholder="昵称（可选）" maxlength="64" />
          </div>
          <div class="reg-field">
            <div class="reg-code-row">
              <input v-model="regEmail" class="srv-input" placeholder="邮箱（可选，填写则需验证码验证）" maxlength="128" />
              <button v-if="regEmail.trim()" class="reg-send-btn" :disabled="regCodeSending || regCodeCountdown > 0" @click="sendRegCode">
                {{ regCodeCountdown > 0 ? `${regCodeCountdown}s` : (regCodeSending ? '发送中…' : '发送验证码') }}
              </button>
            </div>
          </div>
          <div v-if="regEmail.trim()" class="reg-field">
            <input v-model="regCode" class="srv-input" placeholder="邮箱验证码" maxlength="6" />
          </div>
          <div class="reg-field reg-avatar-row">
            <button class="dt-btn dt-btn-default" @click="pickRegAvatar"><i class="far fa-image"></i>&nbsp; 上传头像（可选）</button>
            <span v-if="regAvatarName()" class="reg-avatar-name">{{ regAvatarName() }}</span>
            <span v-else class="reg-avatar-hint">不上传则使用默认头像</span>
          </div>
          <div v-if="regError" class="login-error">{{ regError }}</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showRegister = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="regBusy" @click="doRegister">
            {{ regBusy ? '注册中…' : '注册' }}
          </button>
        </div>
      </div>
    </div>

    <!-- ─── 忘记密码弹窗 ─── -->
    <div v-if="showForgot" class="modal-mask" @click.self="showForgot = false">
      <div class="modal">
        <div class="modal-head">忘记密码</div>
        <div class="modal-body">
          <p class="modal-desc">输入已绑定邮箱，验证后我们将发送重置密码邮件到该邮箱。</p>
          <div class="reg-field">
            <div class="reg-code-row">
              <input v-model="forgotEmail" class="srv-input" placeholder="已绑定邮箱" maxlength="128" />
              <button class="reg-send-btn" :disabled="forgotSending || forgotCountdown > 0" @click="sendForgotCode">
                {{ forgotCountdown > 0 ? `${forgotCountdown}s` : (forgotSending ? '发送中…' : '发送验证码') }}
              </button>
            </div>
          </div>
          <div class="reg-field">
            <input v-model="forgotCode" class="srv-input" placeholder="邮箱验证码" maxlength="6" />
          </div>
          <div v-if="forgotError" class="login-error">{{ forgotError }}</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showForgot = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="forgotBusy || forgotEmail.trim().length === 0 || forgotCode.trim().length === 0" @click="doForgot">
            {{ forgotBusy ? '发送中…' : '发送重置邮件' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  position: relative;
  border-radius: 12px; /* 圆角 */
  overflow: hidden;
  --dt-blue: #0089ff;
  --dt-blue-hover: #33a4ff;
}

.login-top {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 22px;
  flex-shrink: 0;
}
.login-tabs {
  display: flex;
  gap: 28px;
  padding-left: 4px;
}
.login-tab {
  font-size: 15px;
  color: #666;
  cursor: pointer;
  padding: 4px 2px;
  border-bottom: 2px solid transparent;
  transition: color 0.15s;
}
.login-tab:hover {
  color: #333;
}
.login-tab.active {
  color: var(--dt-blue);
  font-weight: 600;
  border-bottom-color: var(--dt-blue);
}
.login-top-right {
  display: flex;
  align-items: center;
  gap: 6px;
}
.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #999;
  transition: background 0.15s;
}
.icon-btn:hover {
  background: #f2f3f5;
  color: #333;
}
.win-controls {
  display: flex;
}
.win-btn {
  width: 40px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #999;
  border-radius: 4px;
  transition: background 0.15s;
}
.win-btn:hover {
  background: #f2f3f5;
  color: #333;
}
.win-btn.win-close:hover {
  background: #e81123;
  color: #fff;
}

.login-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-bottom: 30px;
}

.avatar-ring {
  width: 88px;
  height: 88px;
  border-radius: 50%;
  background: linear-gradient(135deg, #0089ff, #5cb6ff);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 6px 18px rgba(0, 137, 255, 0.28);
}
.greeting {
  font-size: 22px;
  font-weight: 600;
  color: #333;
  margin: 16px 0 26px;
}

.form {
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.field {
  position: relative;
  display: flex;
  align-items: center;
  border-bottom: 1px solid #e5e6eb;
  transition: border-color 0.15s;
}
.field:focus-within {
  border-bottom-color: var(--dt-blue);
}
.field-input {
  flex: 1;
  height: 40px;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  color: #333;
}
.field-input::placeholder {
  color: #c0c4cc;
}
.field-icon,
.field-clear {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #999;
  flex-shrink: 0;
}
.field-icon:hover,
.field-clear:hover {
  color: #333;
}

.login-btn {
  width: 320px;
  height: 42px;
  margin-top: 30px;
  border-radius: 6px;
  background: #c9cdd4; /* 灰色：未激活 */
  color: #fff;
  font-size: 15px;
  font-weight: 500;
  transition: background 0.15s;
}
.login-btn.enabled {
  background: var(--dt-blue);
}
.login-btn.enabled:hover {
  background: var(--dt-blue-hover);
}
.login-btn:disabled {
  cursor: not-allowed;
}

.login-msg {
  width: 320px;
  margin-top: 12px;
  font-size: 13px;
  text-align: center;
}
.login-error {
  color: #f53f3f;
}
.login-success {
  color: #00b42a;
}

.login-sub {
  width: 320px;
  margin-top: 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #666;
  cursor: pointer;
}
.checkbox input {
  display: none;
}
.checkmark {
  width: 15px;
  height: 15px;
  border-radius: 3px;
  border: 1px solid #d0d3da;
  position: relative;
  flex-shrink: 0;
}
.checkbox input:checked + .checkmark {
  background: var(--dt-blue);
  border-color: var(--dt-blue);
}
.checkbox input:checked + .checkmark::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 4px;
  height: 8px;
  border: solid #fff;
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.login-links {
  display: flex;
  gap: 16px;
}
.link {
  font-size: 13px;
  color: #999;
  cursor: pointer;
}
.link:hover {
  color: var(--dt-blue);
}

/* 扫码占位 */
.qrcode-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.qrcode-placeholder {
  width: 200px;
  height: 200px;
  border: 1px dashed #d0d3da;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #b0b4bd;
  background: #fafbfc;
}
.qr-tip {
  color: #999;
  font-size: 13px;
}

/* 底部 */
.login-footer {
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 28px;
  flex-shrink: 0;
  border-top: 1px solid #f0f1f3;
}
.footer-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #666;
  font-size: 13px;
  cursor: pointer;
}
.footer-link:hover {
  color: var(--dt-blue);
}

/* 弹窗 */
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 400px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  overflow: hidden;
}
.modal-head {
  padding: 16px 20px;
  font-size: 16px;
  font-weight: 600;
  border-bottom: 1px solid #f0f1f3;
}
.modal-body {
  padding: 20px;
}
.modal-foot {
  padding: 12px 20px;
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  border-top: 1px solid #f0f1f3;
}
.modal-foot .dt-btn-primary {
  background: var(--dt-blue);
}
.modal-foot .dt-btn-primary:hover:not(:disabled) {
  background: var(--dt-blue-hover);
}
.modal-foot .dt-btn-primary:disabled {
  background: #a8d4ff;
}
.modal-desc {
  font-size: 13px;
  color: #999;
  margin-bottom: 16px;
}
.srv-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.srv-select {
  height: 36px;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  padding: 0 8px;
  background: #fff;
  font-size: 13px;
  color: #333;
  outline: none;
}
.srv-input {
  height: 36px;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  padding: 0 12px;
  font-size: 13px;
  color: #333;
  outline: none;
  width: 0;
  flex: 1;
}
.srv-input:focus {
  border-color: var(--dt-blue);
}
.srv-port {
  flex: 0 0 90px;
}
.srv-colon {
  color: #999;
}
.srv-preview {
  margin-top: 14px;
  font-size: 12px;
  color: #999;
}
.reg-field {
  margin-bottom: 12px;
}
.reg-field .srv-input {
  width: 100%;
}
.reg-avatar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.reg-avatar-row .dt-btn {
  height: 34px;
  padding: 0 14px;
  border: 1px solid #e5e6eb;
  border-radius: 6px;
  background: #fff;
  font-size: 13px;
  color: #666;
  cursor: pointer;
}
.reg-avatar-row .dt-btn:hover {
  border-color: var(--dt-blue);
  color: var(--dt-blue);
}
.reg-avatar-name {
  font-size: 13px;
  color: #333;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.reg-avatar-hint {
  font-size: 12px;
  color: #b0b4bd;
}
.code-send-btn {
  flex-shrink: 0;
  width: 92px;
  height: 28px;
  border: none;
  background: transparent;
  color: var(--dt-blue);
  font-size: 12px;
  cursor: pointer;
}
.code-send-btn:disabled {
  color: #b0b4bd;
  cursor: not-allowed;
}
.reg-code-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.reg-send-btn {
  flex-shrink: 0;
  height: 36px;
  padding: 0 12px;
  border: 1px solid var(--dt-blue);
  border-radius: 6px;
  background: #fff;
  color: var(--dt-blue);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.reg-send-btn:disabled {
  border-color: #c9cdd4;
  color: #b0b4bd;
  cursor: not-allowed;
}
</style>
