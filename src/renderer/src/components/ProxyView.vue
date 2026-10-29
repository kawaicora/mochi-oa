<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import CompanyContactPicker from './CompanyContactPicker.vue'
import { toPlain } from '../utils/plain'
import { fmtHuman } from '../utils/time'
import { proxyDeepLinkId, clearProxyDeepLink } from '../utils/proxy-deeplink'
import { removePending, addPending } from '../utils/reminder'
import { canActApproval } from '../utils/approval'
import { buildApprovalCard } from '../utils/approval-card'

// 显式"停止提醒"：调服务端 proxy:request:notification:stop + 本地 removePending
// 本地记录已停止的条（Set 重新赋值以触发响应式）；服务端若返回 notifyStopped 同样展示"已停止"
const stoppedIds = ref<Set<number>>(new Set())
function isStopped(r: ProxyReq): boolean {
  return !!r.notifyStopped || stoppedIds.value.has(r.id)
}
async function snoozeRemind(r: ProxyReq): Promise<void> {
  err.value = ''; okMsg.value = ''
  try {
    const ack = await window.pantry.serverProxyNotifyStop(toPlain({ companyId: companyId.value, id: r.id }))
    if (!ack.ok) { console.error('[代理] 停止提醒失败', ack.error); err.value = '停止提醒失败：' + (ack.error || ''); return }
    removePending('proxy:' + r.id)
    stoppedIds.value = new Set(stoppedIds.value).add(r.id)
    okMsg.value = '已停止对该条的循环提醒'
  } catch (e) { console.error('[代理] 停止提醒异常', e); err.value = '停止提醒异常' }
}

/**
 * 网络申请（代理）：员工申请 + admin 审批。
 * 审批通过后显示账号信息，可一键设置/断开系统代理。
 */
interface ProxyReq {
  id: number
  companyId: number
  userId: number
  reason: string
  durationDays: number
  status: 'pending' | 'approved' | 'rejected'
  approverId: number | null
  rejectReason?: string
  createdAt: string
  approvedAt?: string
  nick?: string
  username?: string
  account?: { host: string; port: number; username: string; password: string } | null
  notifyStopped?: boolean // 服务端：该条循环提醒已被停止（审批处理自动停止或用户主动停止）
}

// 代理服务器（服务端 proxy:server:list 下发；self=true 为服务端自身出网代理）
interface ProxyServer {
  name: string
  host: string
  port: number
  type: string
  self?: boolean
  auth: boolean
  user: string
}
const app = useAppStore()
const server = useServerStore()
const companyId = computed(() => app.activeCompanyId)
const meId = computed(() => server.state.userId ?? 0)
// 卡片 byNick：当前用户昵称（失败兜底用 username）
const myNick = computed(() => app.members.find((m) => m.userId === meId.value)?.nick || server.state.username || '我')

// 表单
const reason = ref('')
const durationDays = ref(7)
const approverIds = ref<number[]>([])
const approverOpen = ref(false)
const card = ref(false) // 以消息发送
const err = ref('')
const okMsg = ref('')

// 列表
const list = ref<ProxyReq[]>([])
const myTab = ref<'mine' | 'todo'>('mine')
// 需求 7.2：待审批项不再在行内直接渲染通过/拒绝；点卡片打开详情弹窗，弹窗内按 canAct 显示审批信息与按钮。
const selected = ref<ProxyReq | null>(null)
// 审批操作可见性（纯逻辑见 utils/approval）：pending 且（管理员 或 我是单人审批人 approverId）
function canAct(r: ProxyReq): boolean {
  return canActApproval({ status: r.status, meId: meId.value, approverId: r.approverId, isAdmin: app.isAdmin })
}
function openDetail(r: ProxyReq): void { selected.value = r }
const proxyOn = ref(false)
const proxyMode = ref<'proxy' | 'tun'>('proxy') // 1 纯代理 / 2 TUN(sing-box)
const lastProxy = ref<{ host: string; port: number } | null>(null)

async function load(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverProxyList(toPlain({ companyId: companyId.value, mine: myTab.value === 'mine' }))
    if (ack.ok) {
      list.value = (ack.data as { requests?: ProxyReq[] })?.requests ?? []
      // 待审批项注册进 1h 循环提醒集合；服务端已标记 notifyStopped 或本地已停止的不重新注册
      const stopped = new Set(stoppedIds.value)
      for (const r of list.value) {
        if (r.notifyStopped) stopped.add(r.id)
        if (r.status !== 'pending' || isStopped(r)) removePending('proxy:' + r.id)
        else addPending('proxy:' + r.id)
      }
      stoppedIds.value = stopped
    }
    else console.error('[代理] 列表加载失败', ack.error)
  } catch (e) { console.error('[代理] 列表加载异常', e) }
}

async function submit(): Promise<void> {
  err.value = ''; okMsg.value = ''
  if (!companyId.value) return
  if (!reason.value.trim()) { err.value = '请填写申请理由'; return }
  if (!approverIds.value.length) { err.value = '请选择审批人'; return }
  try {
    const ack = await window.pantry.serverProxyCreate(toPlain({
      companyId: companyId.value,
      reason: reason.value.trim(),
      durationDays: Number(durationDays.value) || 7,
      approverIds: approverIds.value,
      sendCard: card.value
    }))
    if (!ack.ok) { err.value = ack.error || '申请失败'; return }
    okMsg.value = '申请已提交'
    // 需求 7.3：勾选「以消息卡片发送」→ 给每个审批人发 proxy_card 私聊卡片（与考勤/报销/备用金同一链路）
    const reqId = Number((ack.data as { request?: { id?: number } })?.request?.id)
    if (card.value && Number.isFinite(reqId)) {
      const body = `${reason.value.trim()} · 时长 ${Number(durationDays.value) || 7} 天`
      for (const aid of approverIds.value) {
        try {
          await window.pantry.serverDmSend(aid, buildApprovalCard('proxy_card', { requestId: reqId, title: '上网申请', body, byNick: myNick.value }), 'proxy_card')
        } catch (e) { console.error('[上网] 申请卡片发送失败', e) }
      }
    }
    reason.value = ''; approverIds.value = []; card.value = false
    await load()
  } catch (e) { console.error('[代理] 提交异常', e); err.value = '提交异常' }
}

async function approve(r: ProxyReq): Promise<void> {
  try {
    const ack = await window.pantry.serverProxyApprove(toPlain({ companyId: companyId.value, id: r.id }))
    if (ack.ok) { removePending('proxy:' + r.id); selected.value = null; await load(); } else console.error('[代理] 审批失败', ack.error)
  } catch (e) { console.error('[代理] 审批异常', e) }
}
async function reject(r: ProxyReq): Promise<void> {
  try {
    const ack = await window.pantry.serverProxyReject(toPlain({ companyId: companyId.value, id: r.id }))
    if (ack.ok) { removePending('proxy:' + r.id); selected.value = null; await load(); } else console.error('[代理] 拒绝失败', ack.error)
  } catch (e) { console.error('[代理] 拒绝异常', e) }
}

async function setProxy(r: ProxyReq): Promise<void> {
  if (!r.account) return
  const mode = proxyMode.value
  try {
    const target = { host: r.account.host, port: r.account.port, username: r.account.username, password: r.account.password }
    const ack = mode === 'tun'
      ? await window.pantry.tunProxySet(toPlain(target))
      : await window.pantry.systemProxySet(toPlain(target))
    if (ack.ok) {
      proxyOn.value = true
      lastProxy.value = { host: r.account.host, port: r.account.port }
      // 持久化代理信息（含 expiresAt 与模式），供启动检查/到期自动断开
      try { localStorage.setItem('mochi:proxyActive', JSON.stringify({ mode, host: r.account.host, port: r.account.port, username: r.account.username, password: r.account.password, expiresAt: (r.account as any).expiresAt || '' })) } catch { console.warn("设置代理配置到本地存储失败") }
      // TUN 是全局接管，纯代理走系统代理——提示当前模式
      console.log('[代理] 已开启', mode === 'tun' ? 'TUN(sing-box) 全局代理' : '系统纯代理', r.account.host + ':' + r.account.port)
    } else alert('设置' + (mode === 'tun' ? 'TUN' : '代理') + '失败：' + (ack.error || ''))
  } catch (e) { console.error('[代理] 设置失败', e); alert('设置代理异常') }
}
async function clearProxy(): Promise<void> {
  const mode = proxyMode.value
  try {
    const ack = mode === 'tun'
      ? await window.pantry.tunProxyClear()
      : await window.pantry.systemProxyClear(toPlain({ host: lastProxy.value?.host, port: lastProxy.value?.port }))
    if (ack.ok) { proxyOn.value = false; try { localStorage.removeItem('mochi:proxyActive') } catch { /* ignore */ } } else alert('断开失败：' + (ack.error || ''))
  } catch (e) { console.error('[代理] 断开异常', e) }
}

// ===== 代理服务器下拉（服务端 proxy:server:list：第一项=服务端自身代理，其余=PROXY_SERVERS） =====
const servers = ref<ProxyServer[]>([])
const selServer = ref<ProxyServer | null>(null)
const srvUser = ref('')
const srvPass = ref('')
const srvOn = ref(false)

async function loadServers(): Promise<void> {
  try {
    const ack = await window.pantry.serverProxyServerList()
    if (ack.ok) servers.value = (ack.data as { servers?: ProxyServer[] })?.servers ?? []
    else console.error('[代理] 服务器列表加载失败', ack.error)
  } catch (e) { console.error('[代理] 服务器列表异常', e) }
}
/** 连接选中的代理服务器（走系统代理：本地无鉴权转发 + 认证在本地转发层完成） */
async function connectServer(): Promise<void> {
  err.value = ''; okMsg.value = ''
  const s = selServer.value
  if (!s) { err.value = '请先选择代理服务器'; return }
  if (!s.host || !s.port) { err.value = '代理服务器地址不完整'; return }
  try {
    const target = { host: s.host, port: Number(s.port), username: srvUser.value.trim() || s.user || '', password: srvPass.value }
    const ack = await window.pantry.systemProxySet(toPlain(target))
    if (ack.ok) {
      srvOn.value = true
      okMsg.value = '已连接代理：' + s.name + '（' + s.host + ':' + s.port + '）'
      // 持久化，供启动检查/到期自动断开
      try { localStorage.setItem('mochi:proxyActive', JSON.stringify({ mode: 'proxy', host: s.host, port: s.port, username: target.username, password: target.password, expiresAt: '' })) } catch { /* ignore */ }
    } else alert('连接代理失败：' + (ack.error || ''))
  } catch (e) { console.error('[代理] 连接服务器异常', e); alert('连接代理异常') }
}
async function disconnectServer(): Promise<void> {
  err.value = ''; okMsg.value = ''
  try {
    const ack = await window.pantry.systemProxyClear(toPlain({ host: selServer.value?.host, port: selServer.value?.port }))
    if (ack.ok) { srvOn.value = false; okMsg.value = '已断开代理'; try { localStorage.removeItem('mochi:proxyActive') } catch { /* ignore */ } } else alert('断开代理失败：' + (ack.error || ''))
  } catch (e) { console.error('[代理] 断开服务器异常', e) }
}

const statusLabel: Record<string, string> = { pending: '待审批', approved: '已通过', rejected: '已拒绝' }

onMounted(async () => {
  await load()
  await loadServers()
  // 深链：若来自消息卡片，切到对应 tab 并高亮
  if (proxyDeepLinkId.value) {
    const id = proxyDeepLinkId.value
    clearProxyDeepLink()
    myTab.value = 'mine'
    await load()
    const el = document.querySelector(`[data-req-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})
</script>

<template>
  <div class="pv">
    <div class="pv-tabs">
      <button :class="{ on: myTab === 'mine' }" @click="myTab = 'mine'; load()">我的申请</button>
      <button v-if="app.isAdmin" :class="{ on: myTab === 'todo' }" @click="myTab = 'todo'; load()">待审批</button>
    </div>

    <!-- 代理服务器连接（服务端 proxy:server:list 下拉） -->
    <div v-if="myTab === 'mine'" class="pv-form">
      <div class="pv-t">代理服务器连接</div>
      <div class="pv-row"><label>服务器</label>
        <select v-model="selServer" class="pv-select">
          <option :value="null" disabled>选择代理服务器</option>
          <option v-for="s in servers" :key="s.host + ':' + s.port" :value="s">{{ s.name }}（{{ s.host }}:{{ s.port }}）</option>
        </select>
      </div>
      <div v-if="selServer" class="pv-row"><label>账号</label><input v-model="srvUser" :placeholder="selServer.user || '代理账号'" /></div>
      <div v-if="selServer" class="pv-row"><label>密码</label><input v-model="srvPass" type="password" placeholder="代理密码" /></div>
      <div v-if="srvOn" class="pv-on">代理已连接　<button @click="disconnectServer">断开代理</button></div>
      <div class="pv-row" v-else><button class="pv-submit" @click="connectServer">连接代理</button></div>
    </div>

    <!-- 申请表单（员工） -->
    <div v-if="myTab === 'mine'" class="pv-form">
      <div class="pv-t">申请网络代理</div>
      <div class="pv-row"><label>理由</label><textarea v-model="reason" rows="2" placeholder="申请代理的用途"></textarea></div>
      <div class="pv-row"><label>时长（天）</label><input type="number" v-model.number="durationDays" min="1" /></div>
      <div class="pv-row"><label>审批人</label>
        <button class="pv-pick" @click="approverOpen = true">{{ approverIds.length ? `已选 ${approverIds.length} 人` : '选择审批人' }}</button>
      </div>
      <div class="pv-row"><label><input type="checkbox" v-model="card" /> 以消息卡片发送给审批人</label></div>
      <div v-if="err" class="pv-err">{{ err }}</div>
      <div v-if="okMsg" class="pv-ok">{{ okMsg }}</div>
      <div class="pv-row"><button class="pv-submit" @click="submit">提交申请</button></div>
      <div v-if="proxyOn" class="pv-on">系统代理已开启　<button @click="clearProxy">断开代理</button></div>
    </div>

    <CompanyContactPicker v-model="approverIds" :open="approverOpen" @update:open="approverOpen = $event" controlled title="选择审批人" />

    <!-- 列表 -->
    <div class="pv-list">
      <!-- 需求 7.2：待审批(todo)项不再在行内直接渲染通过/拒绝；点卡片打开详情弹窗，弹窗内显示审批信息与按钮 -->
      <div v-for="r in list" :key="r.id" class="pv-item" :class="[r.status, { 'pv-clickable': myTab === 'todo' }]" :data-req-id="r.id" @click="myTab === 'todo' && openDetail(r)">
        <div class="pv-item-head">
          <span>#{{ r.id }} {{ r.nick || r.username }}</span>
          <span>
            <span v-if="isStopped(r)" class="pv-stopped-badge"><i class="fas fa-bell-slash"></i> 已停止提醒</span>
            <span class="pv-status">{{ statusLabel[r.status] }}</span>
          </span>
        </div>
        <div class="pv-reason">{{ r.reason }}</div>
        <div class="pv-meta">{{ fmtHuman(r.createdAt) }}　时长 {{ r.durationDays }} 天</div>
        <div v-if="r.account" class="pv-acc">
          <div>服务器地址：{{ r.account.host }}:{{ r.account.port }}　账号：{{ r.account.username }} / {{ r.account.password }}</div>
          <div class="pv-mode">
            <span class="pv-mode-t">连接模式：</span>
            <label><input type="radio" :value="'proxy'" v-model="proxyMode" :disabled="proxyOn" /> 纯代理</label>
            <label><input type="radio" :value="'tun'" v-model="proxyMode" :disabled="proxyOn" /> TUN（sing-box 全局，含 UDP）</label>
            <span v-if="proxyOn" class="pv-mode-on">当前：{{ proxyMode === 'tun' ? 'TUN 全局' : '系统纯代理' }}</span>
          </div>
          <div class="pv-acc-btns">
            <button v-if="!proxyOn" @click="setProxy(r)">设置代理</button>
            <button v-else @click="clearProxy">断开代理</button>
          </div>
        </div>
      </div>
      <div v-if="!list.length" class="pv-empty">暂无申请</div>
    </div>

    <!-- 需求 7.2：审批详情弹窗（点击待审批卡片后打开；内含审批信息 + 通过/拒绝按钮） -->
    <div v-if="selected" class="modal-mask" @click.self="selected = null">
      <div class="modal" style="width:460px">
        <div class="modal-head">上网申请 · {{ selected.nick || selected.username }} · {{ statusLabel[selected.status] }}</div>
        <div class="modal-body">
          <div class="pv-meta">申请人：{{ selected.nick || selected.username }}　提交时间：{{ fmtHuman(selected.createdAt) }}　时长：{{ selected.durationDays }} 天</div>
          <div class="pv-reason">{{ selected.reason }}</div>
          <div v-if="selected.status === 'rejected' && selected.rejectReason" class="pv-reject-note">拒绝原因：{{ selected.rejectReason }}</div>
        </div>
        <div class="modal-foot">
          <button v-if="canAct(selected)" class="dt-btn" @click="approve(selected)"><i class="fas fa-check"></i> 通过</button>
          <button v-if="canAct(selected)" class="dt-btn danger" @click="reject(selected)"><i class="fas fa-times"></i> 拒绝</button>
          <button v-if="canAct(selected) && !isStopped(selected)" class="dt-btn" title="不再循环提醒本条" @click="snoozeRemind(selected)"><i class="fas fa-bell-slash"></i> 停止提醒</button>
          <button class="dt-btn" @click="selected = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pv { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px 18px; overflow: auto; }
.pv-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dt-border-light); margin-bottom: 10px; }
.pv-tabs button { border: none; background: transparent; padding: 8px 14px; cursor: pointer; color: var(--dt-text-3); border-bottom: 2px solid transparent; }
.pv-tabs button.on { color: var(--dt-primary); font-weight: 700; border-bottom-color: var(--dt-primary); }
.pv-form { background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 14px; margin-bottom: 12px; }
.pv-t { font-size: 14px; font-weight: 700; margin-bottom: 10px; }
.pv-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
.pv-row label { min-width: 90px; color: var(--dt-text-3); }
.pv-row textarea, .pv-row input, .pv-select { flex: 1; border: 1px solid var(--dt-border); border-radius: 4px; padding: 6px; font-size: 13px; }
.pv-select { background: #fff; }
.pv-pick { border: 1px solid var(--dt-border); background: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.pv-err { color: #d92b3a; font-size: 13px; margin: 6px 0; }
.pv-ok { color: #2fbb6b; font-size: 13px; margin: 6px 0; }
.pv-submit { background: var(--dt-primary); color: #fff; border: none; padding: 8px 20px; border-radius: 4px; cursor: pointer; }
.pv-on { margin-top: 8px; color: #2fbb6b; font-size: 13px; }
.pv-list { display: flex; flex-direction: column; gap: 8px; }
.pv-item { background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 10px 14px; }
.pv-item.pv-clickable { cursor: pointer; }
.pv-item.pv-clickable:hover { background: #f6f8fb; }
.pv-reject-note { margin-top: 8px; color: #d92b3a; font-size: 13px; }
.pv-item.approved { border-color: #2fbb6b; }
.pv-item.rejected { border-color: #d92b3a; }
.pv-item-head { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; }
.pv-status { font-size: 12px; color: var(--dt-text-3); }
.pv-stopped-badge { margin-right: 6px; padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; background: #f3f4f6; color: #9ca3af; }
.pv-reason { font-size: 13px; margin: 6px 0; }
.pv-meta { font-size: 12px; color: var(--dt-text-3); }
.pv-acc { margin-top: 8px; padding: 8px; background: #f6f8fb; border-radius: 4px; font-size: 13px; }
.pv-mode { margin-top: 6px; display: flex; align-items: center; gap: 12px; font-size: 13px; flex-wrap: wrap; }
.pv-mode-t { color: var(--dt-text-3); }
.pv-mode label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.pv-mode input { margin: 0; }
.pv-mode-on { color: #2fbb6b; font-weight: 600; }
.pv-acc-btns { margin-top: 6px; }
.pv-acc-btns button, .pv-acts button { margin-right: 8px; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
.pv-approve { background: #2fbb6b; color: #fff; border: none; }
.pv-reject { background: #d92b3a; color: #fff; border: none; }
.pv-mute { background: #fff; color: #8a94a6; border: 1px solid #d1d5db; }
.pv-acts { margin-top: 8px; }
.pv-empty { color: var(--dt-text-4); text-align: center; padding: 20px; font-size: 13px; }
</style>
