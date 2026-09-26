<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, computed, watch } from 'vue'
import { useServerStore } from '../stores/server'
import { useAppStore } from '../stores/app'
import ConversationList from './ConversationList.vue'
import ChatWindow from './ChatWindow.vue'
import ContactsNav, { type ContactsScope } from './ContactsNav.vue'
import ContactsContent from './ContactsContent.vue'
import CalendarView from './CalendarView.vue'
import CalendarSide from './CalendarSide.vue'
import AlarmView from './AlarmView.vue'
import { fireDueAlarms, setAlarmActionHandler, snoozeAlarm, stopAlarm, type Alarm } from '../utils/alarms'
import PlaceholderPanel from './PlaceholderPanel.vue'
import PersonalSettings from './PersonalSettings.vue'
import UserAvatar from './UserAvatar.vue'
import type { ServerSession } from '@shared/server-types'

const server = useServerStore()
const app = useAppStore()

type NavTab = 'message' | 'contacts' | 'meeting' | 'calendar' | 'alarm' | 'todo'
const tabMeta: Record<NavTab, { label: string; icon: string }> = {
  message: { label: '消息', icon: 'fas fa-comments' },
  contacts: { label: '通讯录', icon: 'fas fa-address-book' },
  meeting: { label: '会议', icon: 'fas fa-video' },
  calendar: { label: '日历', icon: 'far fa-calendar-alt' },
  alarm: { label: '闹钟', icon: 'fas fa-bell' },
  todo: { label: '待办', icon: 'fas fa-check-square' }
}
const nav = ref<NavTab>('message')

// 打开任意会话（私聊/群）→ 自动切到「消息」标签显示聊天窗口（通讯录里右键/点击成员不再无反应）
watch(
  () => app.selected,
  (s) => { if (s) nav.value = 'message' },
  { deep: false }
)

// 2.1.2 最近使用
interface Recent { tab: NavTab; label: string; icon: string }
const recents = ref<Recent[]>([])
function pushRecent(tab: NavTab): void {
  const m = tabMeta[tab]
  recents.value = [{ tab, label: m.label, icon: m.icon }, ...recents.value.filter((r) => r.tab !== tab)].slice(0, 6)
}

// 通讯录：中栏子标签 + 组织架构选中状态
const cScope = ref<ContactsScope>('org')
const cDept = ref<number | null>(null)

const panelReady = ref(false)
let alarmTimer: number | null = null
onMounted(async () => {
  await app.bootstrap()
  panelReady.value = true
  // 闹钟到点检测（应用运行期间常驻，不随标签切换停止）
  alarmTimer = window.setInterval(() => fireDueAlarms(), 1000)
  // 点击闹钟通知 → 弹出选择窗口（停止/暂停）
  setAlarmActionHandler((a) => { alarmAction.value = a })
})
onBeforeUnmount(() => {
  if (alarmTimer !== null) window.clearInterval(alarmTimer)
  setAlarmActionHandler(null)
})

// 头像菜单 / 账号安全 / 服务器设置（原工作台能力移入标题栏头像）
const showAccountMenu = ref(false)
const showAccount = ref(false)
const showSettings = ref(false)
const showPersonalSettings = ref(false)
const alarmAction = ref<Alarm | null>(null)
const accountError = ref('')
const sessions = ref<ServerSession[]>([])
const currentSessionId = ref(0)
const sessionDays = ref<number | null>(null)
const daysOptions = [
  { label: '使用服务端默认', value: null },
  { label: '7 天', value: 7 },
  { label: '30 天', value: 30 },
  { label: '90 天', value: 90 },
  { label: '365 天', value: 365 }
]

const meNick = computed(() => server.state.nick || server.state.username || '')
const meUser = computed(() => server.state.username || '')
const meAvatar = computed(() => server.state.avatar || '')

// 闹钟到点选择：停止 / 暂停
function doAlarmStop(): void {
  const a = alarmAction.value
  if (a) stopAlarm(a.id)
  alarmAction.value = null
}
function doAlarmSnooze(): void {
  const a = alarmAction.value
  if (a) snoozeAlarm(a.id, a.repeatMinutes || 10)
  alarmAction.value = null
}

async function refreshSessions(): Promise<void> {
  const r = await server.listSessions()
  sessions.value = r.sessions
  currentSessionId.value = r.currentSessionId ?? 0
  sessionDays.value = r.sessionDays ?? null
}
async function openAccount(): Promise<void> {
  showAccountMenu.value = false
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
async function doLogout(): Promise<void> {
  showAccountMenu.value = false
  await server.logout()
}

// 服务器设置
const srvHost = ref('')
const srvPort = ref('')
const srvProtocol = ref<'http' | 'https'>('http')
const srvError = ref('')
const srvPreview = ref('')
const downloadDir = ref('')
function buildUrl(): string {
  const host = srvHost.value.trim() || '127.0.0.1'
  const port = srvPort.value.trim() || '3000'
  return `${srvProtocol.value}://${host}:${port}`
}
async function chooseDownloadDir(): Promise<void> {
  const p = await window.pantry.pickFolder()
  if (p) downloadDir.value = p
}
async function openSettings(): Promise<void> {
  showAccountMenu.value = false
  const cfg = await window.pantry.serverGetSettings()
  downloadDir.value = cfg.downloadDir || ''
  try {
    const u = new URL(cfg.serverUrl)
    srvProtocol.value = u.protocol === 'https:' ? 'https' : 'http'
    srvHost.value = u.hostname
    srvPort.value = u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    srvHost.value = '127.0.0.1'; srvPort.value = '3000'; srvProtocol.value = 'http'
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
    await window.pantry.serverSaveSettings({ token: '', downloadDir: downloadDir.value.trim() || undefined })
    await window.pantry.serverConnect(url, undefined)
    showSettings.value = false
  } catch (e) {
    srvError.value = e instanceof Error ? e.message : String(e)
  }
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

const minWin = () => window.pantry.minimizeWindow()
const toggleWin = () => window.pantry.toggleMaximize()
const closeWin = () => window.pantry.closeWindow()

// 会议：发起 / 加入独立会议窗口
const meetingNo = ref('')
function openCreateVideo(): void {
  void window.pantry.openMeetingWindow({ mode: 'create', kind: 'video' })
}
function openCreateVoice(): void {
  void window.pantry.openMeetingWindow({ mode: 'create', kind: 'voice' })
}
function openJoin(): void {
  const no = meetingNo.value.trim()
  if (!no) return
  void window.pantry.openMeetingWindow({ mode: 'join', meetingNo: no })
}
</script>

<template>
  <div class="main-root">
    <!-- 1. 标题栏：左上角头像 + 拖拽区 + 窗口控制 -->
    <header class="main-top">
      <div class="top-left">
        <button class="avatar" title="我的 / 账号安全 / 设置" @click="showAccountMenu = !showAccountMenu">
          <UserAvatar :nick="meNick" :avatar="meAvatar" :size="28" />
        </button>
        <span class="title-txt">{{ tabMeta[nav].label }}</span>
      </div>
      <div class="drag-region"></div>
      <div class="win-controls no-drag">
        <button class="win-btn" @click="minWin"><i class="fas fa-minus"></i></button>
        <button class="win-btn" @click="toggleWin"><i class="fas fa-square"></i></button>
        <button class="win-btn win-close" @click="closeWin"><i class="fas fa-times"></i></button>
      </div>

      <!-- 头像下拉：账号安全 / 服务器设置 / 退出 -->
      <div v-if="showAccountMenu" class="account-menu" @click.stop>
        <div class="account-head">
          <UserAvatar :nick="meNick || '?'" :avatar="meAvatar" :size="52" />
          <div class="account-name">{{ meNick || '未登录' }}</div>
          <div class="account-id">账号：{{ meUser }}</div>
        </div>
        <button class="menu-item" @click="showPersonalSettings = true"><i class="fas fa-user-edit"></i> 个人信息</button>
        <button class="menu-item" @click="openAccount"><i class="fas fa-shield-alt"></i> 账号安全 · 登录会话</button>
        <button class="menu-item" @click="openSettings"><i class="fas fa-server"></i> 服务器设置</button>
        <div class="menu-divider"></div>
        <button class="menu-item danger" @click="doLogout"><i class="fas fa-sign-out-alt"></i> 退出登录</button>
      </div>
    </header>

    <!-- 2. 内容区：左右结构 -->
    <div class="main-body" @click="showAccountMenu = false">
      <!-- 2.1 左侧容器：切换标签 + 最近使用 -->
      <nav class="rail">
        <div class="rail-tabs">
          <button
            v-for="(m, k) in tabMeta"
            :key="k"
            class="rail-item"
            :class="{ active: nav === k }"
            :title="m.label"
            @click="nav = k; pushRecent(k)"
          >
            <i :class="m.icon"></i>
            <span v-if="k === 'message' && app.unreadTotal > 0" class="rail-badge">{{ app.unreadTotal > 99 ? '99+' : app.unreadTotal }}</span>
          </button>
        </div>
        <!-- 2.1.2 最近使用 -->
        <div class="rail-bottom">
          <div class="rail-sec-title">最近使用</div>
          <button v-for="r in recents" :key="r.tab" class="rail-recent" :class="{ active: nav === r.tab }" :title="r.label" @click="nav = r.tab; pushRecent(r.tab)">
            <i :class="r.icon"></i>
          </button>
          <div v-if="recents.length === 0" class="rail-empty">无</div>
        </div>
      </nav>

      <!-- 2.2 中栏 -->
      <div class="mid">
        <template v-if="nav === 'message'"><ConversationList /></template>
        <template v-else-if="nav === 'contacts'">
          <ContactsNav :scope="cScope" @scope="(s: ContactsScope) => (cScope = s, cDept = null)" @dept="(d: number | null) => cDept = d" />
        </template>
        <template v-else-if="nav === 'meeting'">
          <div class="m-nav">
            <div class="m-nav-title"><i class="fas fa-video"></i> 会议</div>
            <button class="m-nav-btn" @click="openCreateVideo"><i class="fas fa-video"></i> 发起视频会议</button>
            <button class="m-nav-btn" @click="openCreateVoice"><i class="fas fa-phone"></i> 发起语音会议</button>
            <button class="m-nav-btn" @click="openJoin"><i class="fas fa-sign-in-alt"></i> 加入会议</button>
          </div>
        </template>
        <template v-else-if="nav === 'calendar'"><CalendarSide /></template>
        <template v-else-if="nav === 'alarm'"></template>
        <template v-else-if="nav === 'todo'"><PlaceholderPanel mode="nav" title="待办" icon="fas fa-check-square" /></template>
      </div>

      <!-- 2.3 大内容区 -->
      <div class="content">
        <template v-if="nav === 'message'"><ChatWindow /></template>
        <template v-else-if="nav === 'contacts'"><ContactsContent :scope="cScope" :dept-id="cDept" /></template>
        <template v-else-if="nav === 'meeting'">
          <div class="m-content">
            <div class="m-big"><i class="fas fa-video"></i></div>
            <div class="m-title">会议</div>
            <div class="m-desc">发起或加入会议后将在独立窗口中打开</div>
            <div class="m-actions">
              <button class="dt-btn dt-btn-primary" @click="openCreateVideo"><i class="fas fa-video"></i> 发起视频会议</button>
              <button class="dt-btn dt-btn-primary" @click="openCreateVoice"><i class="fas fa-phone"></i> 发起语音会议</button>
            </div>
            <div class="m-join">
              <input v-model="meetingNo" class="srv-input" placeholder="输入会议号加入" @keydown.enter="openJoin" />
              <button class="dt-btn" :disabled="!meetingNo.trim()" @click="openJoin"><i class="fas fa-sign-in-alt"></i> 加入会议</button>
            </div>
          </div>
        </template>
        <template v-else-if="nav === 'calendar'"><CalendarView /></template>
        <template v-else-if="nav === 'alarm'"><AlarmView /></template>
        <template v-else-if="nav === 'todo'"><PlaceholderPanel mode="content" title="待办" icon="fas fa-check-square" /></template>
      </div>
    </div>

    <!-- 加载提示 -->
    <div v-if="!panelReady" class="main-loading"><i class="fas fa-spinner fa-spin"></i>&nbsp; 加载中…</div>

    <!-- 账号安全：登录会话列表和有效期 -->
    <div v-if="showAccount" class="modal-mask" @click.self="showAccount = false">
      <div class="modal account-modal">
        <div class="modal-head">账号安全 · 登录会话 <span class="head-sub">支持多设备同时登录</span></div>
        <div class="modal-body">
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
              <div class="session-ico"><i :class="s.id === currentSessionId ? 'fas fa-laptop' : s.expired ? 'fas fa-ban' : 'fas fa-desktop'"></i></div>
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
        <div class="modal-foot"><button class="dt-btn dt-btn-default" @click="showAccount = false">关闭</button></div>
      </div>
    </div>

    <!-- 服务器设置 -->
    <div v-if="showSettings" class="modal-mask" @click.self="showSettings = false">
      <div class="modal">
        <div class="modal-head">服务器设置</div>
        <div class="modal-body">
          <p class="modal-desc">填写连接的服务端地址与端口</p>
          <div class="srv-row">
            <select v-model="srvProtocol" class="srv-select"><option value="http">http://</option><option value="https">https://</option></select>
            <input v-model="srvHost" class="srv-input" placeholder="127.0.0.1" />
            <span class="srv-colon">:</span>
            <input v-model="srvPort" class="srv-input srv-port" placeholder="3000" />
          </div>
          <div v-if="srvError" class="srv-error">{{ srvError }}</div>
          <p class="srv-preview">连接地址：{{ buildUrl() }}</p>

          <p class="modal-desc dl-desc">文件夹下载目录</p>
          <div class="srv-row">
            <input v-model="downloadDir" class="srv-input" placeholder="例如：Documents/麻薯" />
            <button class="dt-btn" @click="chooseDownloadDir"><i class="far fa-folder-open"></i>&nbsp;浏览</button>
          </div>
          <p class="srv-hint">接收到的文件夹将下载到此目录（按原结构建子目录）</p>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showSettings = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="saveSettings">保存并连接</button>
        </div>
      </div>
    </div>

    <!-- 个人信息设置 -->
    <PersonalSettings v-if="showPersonalSettings" @close="showPersonalSettings = false" />

    <!-- 闹钟到点：点击通知弹出选择（停止 / 暂停） -->
    <div v-if="alarmAction" class="modal-mask" @click.self="alarmAction = null">
      <div class="modal alarm-action-modal">
        <div class="modal-head"><i class="fas fa-bell"></i> 闹钟到点 · {{ alarmAction.name || '闹钟' }} {{ alarmAction.time }}</div>
        <div class="modal-body">
          <p class="alarm-action-hint">选择如何处理本次闹钟？</p>
        </div>
        <div class="modal-foot">
          <button class="alarm-act-btn danger" @click="doAlarmStop"><i class="fas fa-stop"></i> 停止</button>
          <button class="alarm-act-btn" @click="doAlarmSnooze"><i class="fas fa-pause"></i> 暂停 {{ alarmAction.repeatMinutes || 10 }} 分钟</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.main-root { height: 100%; display: flex; flex-direction: column; background: var(--dt-bg-app); position: relative; }

/* 1. 标题栏 */
.main-top { height: 44px; flex-shrink: 0; display: flex; align-items: center; background: #fff; border-bottom: 1px solid var(--dt-border-light); position: relative; }
.top-left { display: flex; align-items: center; gap: 12px; padding: 0 12px; flex: 0 0 auto; -webkit-app-region: drag; }
.avatar {
  width: 32px; height: 32px; border-radius: 50%;
  background: linear-gradient(135deg, #0089ff, #5cb6ff); color: #fff;
  display: flex; align-items: center; justify-content: center; font-size: 15px;
  cursor: pointer; -webkit-app-region: no-drag;
}
.title-txt { font-size: 15px; font-weight: 600; color: var(--dt-text); }
.drag-region { flex: 1; height: 100%; -webkit-app-region: drag; }
.win-controls { display: flex; -webkit-app-region: no-drag; }
.win-btn { width: 38px; height: 32px; display: inline-flex; align-items: center; justify-content: center; color: var(--dt-text-3); font-size: 12px; border-radius: 4px; transition: background 0.15s; }
.win-btn:hover { background: var(--dt-hover); color: var(--dt-text); }
.win-btn.win-close:hover { background: #e81123; color: #fff; }

/* 头像下拉 */
.account-menu {
  position: absolute; top: 46px; left: 12px; width: 240px; background: #fff;
  border: 1px solid var(--dt-border-light); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.14); z-index: 200; padding: 6px;
}
.account-head { display: flex; flex-direction: column; align-items: center; padding: 14px 10px 10px; border-bottom: 1px solid var(--dt-border-light); }
.account-av { width: 48px; height: 48px; border-radius: 50%; background: linear-gradient(135deg, #0089ff, #5cb6ff); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 22px; }
.account-name { font-size: 15px; font-weight: 600; margin-top: 8px; color: var(--dt-text); }
.account-id { font-size: 12px; color: var(--dt-text-3); margin-top: 2px; }
.menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 10px 12px; border-radius: 6px; font-size: 13px; color: var(--dt-text); text-align: left; }
.menu-item i { color: var(--dt-text-3); width: 16px; text-align: center; }
.menu-item:hover { background: var(--dt-hover); }
.menu-item.danger { color: var(--dt-danger); }
.menu-item.danger i { color: var(--dt-danger); }
.menu-divider { height: 1px; background: var(--dt-border-light); margin: 4px 0; }

/* 2. 主体：左右结构 */
.main-body { flex: 1; display: flex; min-height: 0; }

/* 2.1 左侧导航栏 */
.rail { width: 64px; flex-shrink: 0; background: #f6f7f9; border-right: 1px solid var(--dt-border-light); display: flex; flex-direction: column; }
.rail-tabs { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 0; }
.rail-item { width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--dt-text-3); font-size: 20px; position: relative; transition: background 0.15s, color 0.15s; }
.rail-item:hover { background: var(--dt-hover); color: var(--dt-text); }
.rail-item.active { color: #fff; background: var(--dt-primary); }
.rail-badge { position: absolute; top: 2px; right: 2px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 8px; background: var(--dt-danger); color: #fff; font-size: 10px; font-style: normal; line-height: 16px; text-align: center; }
.rail-bottom { border-top: 1px solid var(--dt-border-light); padding: 8px 0 10px; display: flex; flex-direction: column; align-items: center; gap: 6px; }
.rail-sec-title { font-size: 11px; color: var(--dt-text-4); margin-bottom: 2px; }
.rail-recent { width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--dt-text-3); font-size: 16px; }
.rail-recent:hover { background: var(--dt-hover); color: var(--dt-text); }
.rail-recent.active { color: var(--dt-primary); background: var(--dt-active); }
.rail-empty { font-size: 11px; color: var(--dt-text-4); }

/* 中栏 */
.mid { display: flex; min-width: 0; }
.mid > :deep(.c-nav) { width: 240px; flex-shrink: 0; }

/* 大内容区 */
.content { flex: 1; min-width: 0; display: flex; }

.main-loading { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.7); color: var(--dt-text-3); z-index: 50; }

/* 弹窗（复用） */
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { width: 400px; background: #fff; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.15); overflow: hidden; }
.modal-head { padding: 14px 18px; font-size: 15px; font-weight: 600; border-bottom: 1px solid var(--dt-border-light); }
.head-sub { font-size: 12px; font-weight: 400; color: var(--dt-text-3); margin-left: 8px; }
.modal-body { padding: 18px; }
.modal-foot { padding: 12px 18px; display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--dt-border-light); }
.alarm-action-modal { width: 360px; }
.alarm-action-hint { margin: 0; color: var(--dt-text-2); font-size: 13px; }
.alarm-act-btn { height: 34px; padding: 0 18px; border-radius: 8px; font-size: 13px; border: 1px solid var(--dt-border-light); color: var(--dt-text-2); background: #fff; display: inline-flex; align-items: center; gap: 6px; }
.alarm-act-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.alarm-act-btn.danger { color: var(--dt-danger); }
.alarm-act-btn.danger:hover { border-color: var(--dt-danger); color: var(--dt-danger); }
.account-modal { width: 540px; }
.modal-desc { font-size: 13px; color: var(--dt-text-3); margin-bottom: 14px; }
.srv-row { display: flex; align-items: center; gap: 8px; }
.srv-select { height: 36px; border: 1px solid var(--dt-border); border-radius: 6px; padding: 0 8px; background: #fff; font-size: 13px; color: var(--dt-text); outline: none; }
.srv-input { height: 36px; border: 1px solid var(--dt-border); border-radius: 6px; padding: 0 12px; font-size: 13px; color: var(--dt-text); outline: none; width: 0; flex: 1; }
.srv-input:focus { border-color: var(--dt-primary); }
.srv-port { flex: 0 0 90px; }
.srv-colon { color: var(--dt-text-3); }
.srv-preview { margin-top: 14px; font-size: 12px; color: var(--dt-text-3); }
.dl-desc { margin-top: 18px; margin-bottom: 8px; }
.srv-hint { margin-top: 8px; font-size: 12px; color: var(--dt-text-4); }
.srv-error { margin-top: 10px; font-size: 13px; color: var(--dt-danger); }
.dt-btn { height: 36px; padding: 0 16px; border-radius: 6px; font-size: 13px; border: 1px solid var(--dt-border); background: #fff; color: var(--dt-text-2); cursor: pointer; }
.dt-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.dt-btn-primary { background: var(--dt-primary); color: #fff; border-color: var(--dt-primary); }
.dt-btn-primary:hover { color: #fff; }
.me-btn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--dt-border); font-size: 13px; color: var(--dt-text-2); background: #fff; }
.me-btn.sm { height: 28px; padding: 0 8px; font-size: 12px; }
.me-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.me-btn.danger:hover { border-color: var(--dt-danger); color: var(--dt-danger); }
.acc-row { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
.acc-label { font-size: 13px; color: var(--dt-text-2); flex: 0 0 70px; }
.acc-control { display: flex; align-items: center; gap: 8px; }
.acc-hint { font-size: 12px; color: var(--dt-text-4); }
.acc-sec-title { display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 600; color: var(--dt-text-2); margin: 16px 0 8px; }
.session-list { display: flex; flex-direction: column; gap: 8px; max-height: 320px; overflow-y: auto; }
.session-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dt-border-light); background: #fff; }
.session-item.current { border-color: var(--dt-primary); background: var(--dt-active); }
.session-item.expired { opacity: 0.55; }
.session-ico { width: 34px; height: 34px; border-radius: 8px; background: var(--dt-bg-hover); color: var(--dt-text-3); display: flex; align-items: center; justify-content: center; font-size: 16px; flex: 0 0 34px; }
.session-info { flex: 1; min-width: 0; }
.session-device { font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
.session-meta { font-size: 12px; color: var(--dt-text-3); display: flex; gap: 10px; margin-top: 2px; flex-wrap: wrap; }
.tag-current { font-size: 11px; padding: 0 6px; border-radius: 4px; color: #fff; background: var(--dt-primary); }
.tag-expired { font-size: 11px; padding: 0 6px; border-radius: 4px; color: #b36d00; background: #fff3dc; }
.dept-hint { font-size: 13px; color: var(--dt-text-4); }

/* 会议面板 */
.m-nav { width: 230px; height: 100%; flex-shrink: 0; background: #fff; border-right: 1px solid var(--dt-border-light); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.m-nav-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; color: var(--dt-text); margin-bottom: 6px; }
.m-nav-btn { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px; font-size: 13px; color: var(--dt-text-2); border: 1px solid var(--dt-border-light); background: #fff; text-align: left; }
.m-nav-btn i { color: var(--dt-text-3); width: 16px; text-align: center; }
.m-nav-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.m-content { flex: 1; height: 100%; background: var(--dt-bg-app); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--dt-text-4); }
.m-big { width: 64px; height: 64px; border-radius: 16px; background: var(--dt-bg-hover); display: flex; align-items: center; justify-content: center; font-size: 30px; color: var(--dt-primary); }
.m-title { font-size: 18px; font-weight: 600; color: var(--dt-text); }
.m-desc { font-size: 13px; }
.m-actions { display: flex; gap: 12px; margin-top: 12px; }
.m-actions .dt-btn { display: inline-flex; align-items: center; gap: 6px; }
.m-join { display: flex; gap: 8px; margin-top: 8px; align-items: center; }
.m-join .srv-input { width: 220px; }
.m-join .dt-btn { display: inline-flex; align-items: center; gap: 6px; }
.m-join .dt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
