<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import CompanyContactPicker from './CompanyContactPicker.vue'
import { toPlain } from '../utils/plain'
import { fmtHuman } from '../utils/time'
import { proxyDeepLinkId, clearProxyDeepLink } from '../utils/proxy-deeplink'
import { removePending, addPending } from '../utils/reminder'

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
const app = useAppStore()
const companyId = computed(() => app.activeCompanyId)

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
const proxyOn = ref(false)
const lastProxy = ref<{ host: string; port: number } | null>(null)

async function load(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverProxyList(toPlain({ companyId: companyId.value, mine: myTab.value === 'mine' }))
    if (ack.ok) {
      list.value = (ack.data as { requests?: ProxyReq[] })?.requests ?? []
      // 待审批项注册进 1h 循环提醒集合
      for (const r of list.value) {
        if (r.status === 'pending') addPending('proxy:' + r.id)
        else removePending('proxy:' + r.id)
      }
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
    reason.value = ''; approverIds.value = []; card.value = false
    await load()
  } catch (e) { console.error('[代理] 提交异常', e); err.value = '提交异常' }
}

async function approve(r: ProxyReq): Promise<void> {
  try {
    const ack = await window.pantry.serverProxyApprove(toPlain({ companyId: companyId.value, id: r.id }))
    if (ack.ok) { removePending('proxy:' + r.id); await load(); } else console.error('[代理] 审批失败', ack.error)
  } catch (e) { console.error('[代理] 审批异常', e) }
}
async function reject(r: ProxyReq): Promise<void> {
  try {
    const ack = await window.pantry.serverProxyReject(toPlain({ companyId: companyId.value, id: r.id }))
    if (ack.ok) { removePending('proxy:' + r.id); await load(); } else console.error('[代理] 拒绝失败', ack.error)
  } catch (e) { console.error('[代理] 拒绝异常', e) }
}

async function setProxy(r: ProxyReq): Promise<void> {
  if (!r.account) return
  try {
    const ack = await window.pantry.systemProxySet(toPlain({ host: r.account.host, port: r.account.port, username: r.account.username, password: r.account.password }))
    if (ack.ok) {
      proxyOn.value = true
      lastProxy.value = { host: r.account.host, port: r.account.port }
      // 持久化代理信息（含 expiresAt），供启动检查/到期自动断开
      try { localStorage.setItem('mochi:proxyActive', JSON.stringify({ host: r.account.host, port: r.account.port, username: r.account.username, password: r.account.password, expiresAt: (r.account as any).expiresAt || '' })) } catch { /* ignore */ }
    } else alert('设置代理失败：' + (ack.error || ''))
  } catch (e) { console.error('[代理] 设置失败', e); alert('设置代理异常') }
}
async function clearProxy(): Promise<void> {
  try {
    const ack = await window.pantry.systemProxyClear(toPlain({ host: lastProxy.value?.host, port: lastProxy.value?.port }))
    if (ack.ok) { proxyOn.value = false; try { localStorage.removeItem('mochi:proxyActive') } catch { /* ignore */ } } else alert('断开失败：' + (ack.error || ''))
  } catch (e) { console.error('[代理] 断开异常', e) }
}

const statusLabel: Record<string, string> = { pending: '待审批', approved: '已通过', rejected: '已拒绝' }

onMounted(async () => {
  await load()
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
      <div v-for="r in list" :key="r.id" class="pv-item" :class="r.status" :data-req-id="r.id">
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
          <div class="pv-acc-btns">
            <button v-if="!proxyOn" @click="setProxy(r)">设置系统代理</button>
            <button v-else @click="clearProxy">断开代理</button>
          </div>
        </div>
        <div v-if="myTab === 'todo' && r.status === 'pending'" class="pv-acts">
          <button class="pv-approve" @click="approve(r)">通过</button>
          <button class="pv-reject" @click="reject(r)">拒绝</button>
          <button v-if="!isStopped(r)" class="pv-mute" title="不再循环提醒本条" @click="snoozeRemind(r)"><i class="fas fa-bell-slash"></i> 停止提醒</button>
        </div>
      </div>
      <div v-if="!list.length" class="pv-empty">暂无申请</div>
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
.pv-row textarea, .pv-row input { flex: 1; border: 1px solid var(--dt-border); border-radius: 4px; padding: 6px; font-size: 13px; }
.pv-pick { border: 1px solid var(--dt-border); background: #fff; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.pv-err { color: #d92b3a; font-size: 13px; margin: 6px 0; }
.pv-ok { color: #2fbb6b; font-size: 13px; margin: 6px 0; }
.pv-submit { background: var(--dt-primary); color: #fff; border: none; padding: 8px 20px; border-radius: 4px; cursor: pointer; }
.pv-on { margin-top: 8px; color: #2fbb6b; font-size: 13px; }
.pv-list { display: flex; flex-direction: column; gap: 8px; }
.pv-item { background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 10px 14px; }
.pv-item.approved { border-color: #2fbb6b; }
.pv-item.rejected { border-color: #d92b3a; }
.pv-item-head { display: flex; justify-content: space-between; font-size: 13px; font-weight: 600; }
.pv-status { font-size: 12px; color: var(--dt-text-3); }
.pv-stopped-badge { margin-right: 6px; padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; background: #f3f4f6; color: #9ca3af; }
.pv-reason { font-size: 13px; margin: 6px 0; }
.pv-meta { font-size: 12px; color: var(--dt-text-3); }
.pv-acc { margin-top: 8px; padding: 8px; background: #f6f8fb; border-radius: 4px; font-size: 13px; }
.pv-acc-btns { margin-top: 6px; }
.pv-acc-btns button, .pv-acts button { margin-right: 8px; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
.pv-approve { background: #2fbb6b; color: #fff; border: none; }
.pv-reject { background: #d92b3a; color: #fff; border: none; }
.pv-mute { background: #fff; color: #8a94a6; border: 1px solid #d1d5db; }
.pv-acts { margin-top: 8px; }
.pv-empty { color: var(--dt-text-4); text-align: center; padding: 20px; font-size: 13px; }
</style>
