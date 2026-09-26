<script setup lang="ts">
import { ref, computed } from 'vue'
import { useServerStore } from '../stores/server'
import { useAppStore } from '../stores/app'
import UserAvatar from './UserAvatar.vue'

const server = useServerStore()
const app = useAppStore()

const showSettings = ref(false)
const srvHost = ref('')
const srvPort = ref('')
const srvProtocol = ref<'http' | 'https'>('http')
const srvError = ref('')
const srvPreview = ref('')

const modules = [
  { icon: 'far fa-calendar-alt', name: '日历', desc: '日程安排' },
  { icon: 'far fa-file-alt', name: '文档', desc: '云文档' },
  { icon: 'fas fa-check-circle', name: '审批', desc: '流程审批' },
  { icon: 'fas fa-clock', name: '考勤', desc: '打卡签到' },
  { icon: 'fas fa-tasks', name: '任务', desc: '任务协作' },
  { icon: 'fas fa-video', name: '视频会议', desc: '远程会议' }
]

const me = computed(() => ({
  username: server.state.username || '',
  nick: server.state.username || '',
  avatar: server.state.avatar || ''
}))

function buildUrl(): string {
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
  srvPreview.value = buildUrl()
  srvError.value = ''
  showSettings.value = true
}

async function saveSettings(): Promise<void> {
  const url = buildUrl()
  srvError.value = ''
  try {
    await app.refreshCompanies()
    server.settings.token = ''
    await window.pantry.serverSaveSettings({ token: '' })
    await window.pantry.serverConnect(url, undefined)
    showSettings.value = false
  } catch (e) {
    srvError.value = e instanceof Error ? e.message : String(e)
  }
}

async function doLogout(): Promise<void> {
  await server.logout()
}

// ─── 账号安全：登录有效期 + 登录会话列表（多端） ─────────────
import type { ServerSession } from '@shared/server-types'

const showAccount = ref(false)
const sessions = ref<ServerSession[]>([])
const currentSessionId = ref(0)
const sessionDays = ref<number | null>(null)
const accountError = ref('')
const daysOptions = [
  { label: '使用服务端默认', value: null },
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
  { label: '365 天', value: 365 }
]

async function refreshSessions(): Promise<void> {
  const r = await server.listSessions()
  sessions.value = r.sessions
  currentSessionId.value = r.currentSessionId ?? 0
  sessionDays.value = r.sessionDays ?? null
}

async function openAccount(): Promise<void> {
  accountError.value = ''
  showAccount.value = true
  await refreshSessions()
}

async function doSetDays(): Promise<void> {
  accountError.value = ''
  const r = await server.setSessionDays(sessionDays.value)
  if (!r.ok) accountError.value = r.error || '设置失败'
}

async function doEndSession(id: number): Promise<void> {
  accountError.value = ''
  const r = await server.endSession(id)
  if (!r.ok) accountError.value = r.error || '操作失败'
  await refreshSessions()
}

async function doEndAll(): Promise<void> {
  accountError.value = ''
  const r = await server.endAllSessions()
  if (!r.ok) accountError.value = r.error || '操作失败'
  await refreshSessions()
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function remainDays(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return '已过期'
  const days = Math.floor(ms / 86400000)
  const hours = Math.floor((ms % 86400000) / 3600000)
  return days > 0 ? `剩 ${days} 天` : hours > 0 ? `剩 ${hours} 小时` : '即将过期'
}
</script>

<template>
  <section class="ws-panel">
    <div class="ws-scroll">
      <!-- 我的卡片 -->
      <div class="me-card">
        <UserAvatar :nick="me.nick" :avatar="me.avatar" :size="56" />
        <div class="me-info">
          <div class="me-name">{{ me.nick }}</div>
          <div class="me-id">账号：{{ me.username }}</div>
        </div>
        <div class="me-actions">
          <button class="me-btn" @click="openAccount"><i class="fas fa-shield-alt"></i> 账号安全</button>
          <button class="me-btn" @click="openSettings"><i class="fas fa-server"></i> 服务器设置</button>
          <button class="me-btn danger" @click="doLogout"><i class="fas fa-sign-out-alt"></i> 退出登录</button>
        </div>
      </div>

      <!-- 工作台 -->
      <div class="sec-title">工作台</div>
      <div class="module-grid">
        <div v-for="m in modules" :key="m.name" class="module">
          <div class="module-icon"><i :class="m.icon"></i></div>
          <div class="module-name">{{ m.name }}</div>
          <div class="module-desc">{{ m.desc }}</div>
        </div>
      </div>

      <div class="sec-title">我的公司</div>
      <div class="my-companies">
        <div v-for="c in app.companies" :key="c.company.id" class="company-chip" :class="{ active: c.company.id === app.activeCompanyId }" @click="app.switchCompany(c.company.id)">
          {{ c.company.name }}<span class="chip-role">{{ app.roleLabel(c.role) }}</span>
        </div>
        <div v-if="app.companies.length === 0" class="dept-hint">未加入任何公司，可在「通讯录」中创建或加入</div>
      </div>
    </div>

    <!-- 服务器设置弹窗 -->
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
          <div v-if="srvError" class="srv-error">{{ srvError }}</div>
          <p class="srv-preview">连接地址：{{ buildUrl() }}</p>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showSettings = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="saveSettings">保存并连接</button>
        </div>
      </div>
    </div>

    <!-- 账号安全：登录会话列表和有效期 -->
    <div v-if="showAccount" class="modal-mask" @click.self="showAccount = false">
      <div class="modal account-modal">
        <div class="modal-head">
          账号安全 · 登录会话
          <span class="head-sub">支持多设备同时登录</span>
        </div>
        <div class="modal-body">
          <!-- 登录有效期 -->
          <div class="acc-row">
            <div class="acc-label">登录有效期</div>
            <div class="acc-control">
              <select v-model.number="sessionDays" class="srv-select" @change="doSetDays">
                <option v-for="o in daysOptions" :key="String(o.value)" :value="o.value">{{ o.label }}</option>
              </select>
              <span class="acc-hint">影响之后新建的登录会话</span>
            </div>
          </div>
          <div v-if="accountError" class="srv-error">{{ accountError }}</div>

          <div class="acc-sec-title">
            当前登录设备（{{ sessions.length }}）
            <button v-if="sessions.length > 1" class="me-btn sm" @click="doEndAll"><i class="fas fa-sign-out-alt"></i> 退出其他设备</button>
          </div>

          <div class="session-list">
            <div v-for="s in sessions" :key="s.id" class="session-item" :class="{ current: s.id === currentSessionId, expired: s.expired }">
              <div class="session-ico">
                <i :class="s.id === currentSessionId ? 'fas fa-laptop' : s.expired ? 'fas fa-ban' : 'fas fa-desktop'"></i>
              </div>
              <div class="session-info">
                <div class="session-device">
                  {{ s.device }}
                  <span v-if="s.id === currentSessionId" class="tag-current">当前设备</span>
                  <span v-if="s.expired" class="tag-expired">已过期</span>
                </div>
                <div class="session-meta">
                  <span>IP {{ s.ip }}</span>
                  <span>归属地 {{ s.location || '未知' }}</span>
                  <span>登录 {{ fmtTime(s.createdAt) }}</span>
                  <span>有效 {{ remainDays(s.expiresAt) }}（{{ fmtTime(s.expiresAt) }} 到期）</span>
                </div>
              </div>
              <button v-if="s.id !== currentSessionId" class="me-btn sm danger" @click="doEndSession(s.id)"><i class="fas fa-times"></i> 退出</button>
            </div>
            <div v-if="sessions.length === 0" class="dept-hint">暂无其他登录会话</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showAccount = false">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ws-panel {
  flex: 1;
  min-width: 0;
  background: var(--dt-bg-app);
  position: relative;
}
.ws-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 20px;
}
.me-card {
  display: flex;
  align-items: center;
  gap: 14px;
  background: #fff;
  border-radius: 10px;
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  margin-bottom: 20px;
}
.me-avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: linear-gradient(135deg, #0089ff, #5cb6ff);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  font-weight: 600;
}
.me-info {
  flex: 1;
}
.me-name {
  font-size: 18px;
  font-weight: 600;
}
.me-id {
  font-size: 13px;
  color: var(--dt-text-3);
  margin-top: 2px;
}
.me-actions {
  display: flex;
  gap: 8px;
}
.me-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border-radius: 6px;
  border: 1px solid var(--dt-border);
  font-size: 13px;
  color: var(--dt-text-2);
  background: #fff;
}
.me-btn:hover {
  border-color: var(--dt-primary);
  color: var(--dt-primary);
}
.me-btn.danger:hover {
  border-color: var(--dt-danger);
  color: var(--dt-danger);
}
.sec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dt-text-2);
  margin: 18px 0 10px;
}
.module-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.module {
  background: #fff;
  border-radius: 10px;
  padding: 18px 12px;
  text-align: center;
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.1s;
}
.module:hover {
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
}
.module-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto 10px;
  border-radius: 10px;
  background: linear-gradient(135deg, #0089ff, #5cb6ff);
  color: #fff;
  font-size: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.module-name {
  font-size: 14px;
  font-weight: 500;
}
.module-desc {
  font-size: 12px;
  color: var(--dt-text-3);
  margin-top: 2px;
}
.my-companies {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.company-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  background: #fff;
  border: 1px solid var(--dt-border);
  font-size: 14px;
  cursor: pointer;
}
.company-chip.active {
  border-color: var(--dt-primary);
  color: var(--dt-primary);
  background: var(--dt-active);
}
.chip-role {
  font-size: 11px;
  color: var(--dt-text-3);
}
.dept-hint {
  font-size: 13px;
  color: var(--dt-text-4);
}
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
  width: 400px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}
.modal-head {
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--dt-border-light);
}
.modal-body {
  padding: 18px;
}
.modal-foot {
  padding: 12px 18px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--dt-border-light);
}
.modal-desc {
  font-size: 13px;
  color: var(--dt-text-3);
  margin-bottom: 14px;
}
.srv-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.srv-select {
  height: 36px;
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  padding: 0 8px;
  background: #fff;
  font-size: 13px;
  color: var(--dt-text);
  outline: none;
}
.srv-input {
  height: 36px;
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  padding: 0 12px;
  font-size: 13px;
  color: var(--dt-text);
  outline: none;
  width: 0;
  flex: 1;
}
.srv-input:focus {
  border-color: var(--dt-primary);
}
.srv-port {
  flex: 0 0 90px;
}
.srv-colon {
  color: var(--dt-text-3);
}
.srv-preview {
  margin-top: 14px;
  font-size: 12px;
  color: var(--dt-text-3);
}
.srv-error {
  margin-top: 10px;
  font-size: 13px;
  color: var(--dt-danger);
}
/* 账号安全 */
.account-modal {
  width: 520px;
}
.head-sub {
  font-size: 12px;
  font-weight: 400;
  color: var(--dt-text-3);
  margin-left: 8px;
}
.acc-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 6px;
}
.acc-label {
  font-size: 13px;
  color: var(--dt-text-2);
  flex: 0 0 70px;
}
.acc-control {
  display: flex;
  align-items: center;
  gap: 8px;
}
.acc-hint {
  font-size: 12px;
  color: var(--dt-text-4);
}
.acc-sec-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 600;
  color: var(--dt-text-2);
  margin: 16px 0 8px;
}
.session-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid var(--dt-border-light);
  background: #fff;
}
.session-item.current {
  border-color: var(--dt-primary);
  background: var(--dt-active);
}
.session-item.expired {
  opacity: 0.55;
}
.session-ico {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--dt-bg-hover);
  color: var(--dt-text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  flex: 0 0 34px;
}
.session-info {
  flex: 1;
  min-width: 0;
}
.session-device {
  font-size: 14px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}
.session-meta {
  font-size: 12px;
  color: var(--dt-text-3);
  display: flex;
  gap: 10px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.tag-current {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  color: #fff;
  background: var(--dt-primary);
}
.tag-expired {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  color: #b36d00;
  background: #fff3dc;
}
.me-btn.sm {
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
}
</style>
