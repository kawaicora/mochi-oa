<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import DateTimeInput from './common/DateTimePicker.vue'
import RichTextEditor from './common/RichTextEditor.vue'
import CompanyContactPicker from './CompanyContactPicker.vue'
import { toPlain } from '../utils/plain'
import { addPending, removePending } from '../utils/reminder'

// ── 类型（与服务端冻结协议对齐）──
type AttType = 'make_up' | 'leave' | 'comp_time' | 'overtime'
type AttStatus = 'pending' | 'approved' | 'rejected'
interface AttendanceRequest {
  id: number
  companyId: number
  userId: number
  type: AttType
  status: AttStatus
  punchTime: string | null
  leaveType: string | null
  compType: string | null
  startTime: string | null
  endTime: string | null
  durationHours: number | null
  reason: string
  approverIds: number[]
  ccIds: number[]
  approverId: number | null
  approvalNote: string | null
  approvedAt: string | null
  createdAt: string
  updatedAt: string
  nick?: string
  username?: string
  notifyStopped?: boolean // 服务端：该条循环提醒已被停止（审批处理自动停止或用户主动停止）
}
// 草稿结构（按类型存 localStorage；含审批人/抄送人选择）
interface Draft {
  punchTime: string
  leaveType: string
  compType: string
  startTime: string
  endTime: string
  durationHours: number | null
  reason: string
  approverIds: number[]
  ccIds: number[]
}

const app = useAppStore()
const server = useServerStore()
const companyId = computed(() => app.activeCompanyId)
const isAdmin = computed(() => app.isAdmin)
const meId = computed(() => server.state.userId ?? 0)

const TYPE_LABEL: Record<AttType, string> = { make_up: '补卡', leave: '请假', comp_time: '调休', overtime: '加班' }
const STATUS_LABEL: Record<AttStatus, string> = { pending: '待审批', approved: '已通过', rejected: '已驳回' }
const LEAVE_TYPES = ['事假', '病假', '年假', '婚假', '产假', '其他']
const COMP_TYPES = ['加班调休', '其他']

// ── 顶部标签页：申请 | 历史记录 ──
const topTab = ref<'apply' | 'history' | 'received' | 'cc'>('apply')
// 申请类型（补卡/请假/调休）
const tab = ref<AttType>('make_up')

// ── 表单 ──
const punchTime = ref('')
// 从打卡页进入的补卡锁定「被补日期」（YYYY-MM-DD）：落库/槽位以它为准，
// 允许补卡时刻跨天到次日凌晨（下班区间 = 当天下班 ~ 次日 4 点，补 10-27 下班卡可选 10-28 02:00）。
const makeupDate = ref('')
// 补卡槽位：work(补上班)|off(补下班)；打卡页进入时确定，服务端据此落槽位（补下班跨天也算下班）。
const makeupSlot = ref<'work' | 'off' | ''>('')
// 标记本次 tab 切换是否由打卡页预填触发（是则保留 makeupDate/makeupSlot，否则手动切 tab 清空防残留）。
let prefilled = false
const leaveType = ref(LEAVE_TYPES[0])
const compType = ref(COMP_TYPES[0])
const startTime = ref('')
const endTime = ref('')
const durationHours = ref<number | null>(null)
const reason = ref('')
// 发起时动态选择的审批人/抄送人（不再走预设审批流程配置）
const approverIds = ref<number[]>([])
const ccIds = ref<number[]>([])
const submitting = ref(false)
const err = ref('')
const okMsg = ref('')

// 草稿 localStorage key（按类型分 key）
const draftKey = (t: AttType) => `mochi:oa:att:draft:${t}`
function currentDraft(): Draft {
  return {
    punchTime: punchTime.value, leaveType: leaveType.value, compType: compType.value,
    startTime: startTime.value, endTime: endTime.value, durationHours: durationHours.value, reason: reason.value,
    approverIds: [...approverIds.value], ccIds: [...ccIds.value]
  }
}
function applyDraft(d: Draft): void {
  punchTime.value = d.punchTime || ''
  leaveType.value = d.leaveType || LEAVE_TYPES[0]
  compType.value = d.compType || COMP_TYPES[0]
  startTime.value = d.startTime || ''
  endTime.value = d.endTime || ''
  durationHours.value = d.durationHours ?? null
  reason.value = d.reason || ''
  approverIds.value = d.approverIds ?? []
  ccIds.value = d.ccIds ?? []
}
// 切类型 → 载入该类型草稿
function loadDraft(t: AttType): void {
  try {
    const raw = localStorage.getItem(draftKey(t))
    const d = raw ? (JSON.parse(raw) as Draft) : null
    const base = d ?? { punchTime: '', leaveType: LEAVE_TYPES[0], compType: COMP_TYPES[0], startTime: '', endTime: '', durationHours: null, reason: '', approverIds: [], ccIds: [] }
    // 从打卡页预填进入（makeupDate 非空）：保留已预填的补卡时间，避免被草稿覆盖丢失。
    if (makeupDate.value) base.punchTime = punchTime.value
    applyDraft(base)
  } catch (e) { console.error('[考勤] 草稿读取失败', e) }
  // 新发起/未选抄送时预填公司默认审批抄送人（可替换/清空，非强制）
  void prefetchDefaultCc()
}
// 发起审批时默认带出公司默认抄送人（仅当用户尚未选择抄送时预填；可替换/清空，非强制）
async function prefetchDefaultCc(): Promise<void> {
  if (ccIds.value.length) return
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverApprovalSettingsGet(companyId.value)
    const ids = (ack.data as { userIds?: number[] })?.userIds
    if (ack.ok && Array.isArray(ids) && ids.length && !ccIds.value.length) ccIds.value = ids
  } catch (e) { console.error('[考勤] 读取默认抄送失败', e) }
}
// 手动保存草稿（含审批人/抄送人选择）
function saveDraft(): void {
  try {
    localStorage.setItem(draftKey(tab.value), JSON.stringify(currentDraft()))
    okMsg.value = '草稿已保存'
  } catch (e) { console.error('[考勤] 草稿保存失败', e); err.value = '草稿保存失败' }
}
function clearDraft(t: AttType): void {
  try { localStorage.removeItem(draftKey(t)) } catch (e) { console.error('[考勤] 草稿清除失败', e) }
}

// 选完开始/结束时间后自动算时长（小时）
watch([startTime, endTime], () => {
  if (startTime.value && endTime.value) {
    const s = new Date(startTime.value).getTime()
    const e = new Date(endTime.value).getTime()
    if (e > s) durationHours.value = Math.round(((e - s) / 3600000) * 10) / 10
  }
})

// ── 审批人/抄送人由申请人发起时动态选择（不再有预设流程配置）──

/** userId 数组 → 名字 */
function namesOf(ids: number[]): string {
  if (!ids || !ids.length) return '—'
  return ids.map((id) => app.members.find((m) => m.userId === id)?.nick || app.members.find((m) => m.userId === id)?.username || `#${id}`).join('、')
}

// ── 提交申请 ──
async function submit(): Promise<void> {
  if (!companyId.value) { err.value = '尚未加入公司'; return }
  err.value = ''
  okMsg.value = ''
  if (tab.value === 'make_up' && !punchTime.value) { err.value = '请选择补卡时间'; return }
  if (tab.value !== 'make_up' && (!startTime.value || !endTime.value)) { err.value = '请选择开始与结束时间'; return }
  if (!approverIds.value.length) { err.value = '请选择审批人'; return }
  if (!reason.value.trim()) { err.value = '请填写事由'; return }
  submitting.value = true
  try {
    const payload: Record<string, unknown> = {
      companyId: companyId.value, type: tab.value, reason: reason.value,
      approverIds: approverIds.value, ccIds: ccIds.value
    }
    if (tab.value === 'make_up') {
      // PunchTime 为实际打卡时刻（允许跨天到次日凌晨补下班卡，如补 10-27 卡选 10-28 02:00）。
      payload.punchTime = punchTime.value
      // 目标日期 + 槽位由打卡页预填携带：服务端据此落库（checkDate=被补那天，槽位=补上班/补下班），
      // 而非按 PunchTime 字面日期/时刻邻近判定——从而跨天补下班卡也能正确落到被补那天。
      if (makeupDate.value) payload.makeupDate = makeupDate.value
      if (makeupSlot.value) payload.makeupSlot = makeupSlot.value
    }
    else {
      payload.startTime = startTime.value
      payload.endTime = endTime.value
      payload.durationHours = durationHours.value
      if (tab.value === 'leave') payload.leaveType = leaveType.value
      else if (tab.value === 'comp_time') payload.compType = compType.value
      // overtime：只传时间段，时长由服务端计算；不设请假/调休类型
    }
    const ack = await window.pantry.serverAttendanceCreate(toPlain(payload))
    if (!ack.ok) { console.error('[考勤] 提交失败', ack.error); err.value = ack.error || '提交失败'; return }
    okMsg.value = '已提交'
    // 提交成功 → 清空该类型草稿并重置表单
    clearDraft(tab.value)
    punchTime.value = ''; startTime.value = ''; endTime.value = ''; durationHours.value = null; reason.value = ''
    approverIds.value = []; ccIds.value = []; makeupDate.value = ''; makeupSlot.value = ''
    await loadList()
  } catch (e) { console.error('[考勤] 提交异常', e); err.value = '提交异常' }
  submitting.value = false
}

// ── 历史记录（按类型 tab）──
const historyType = ref<AttType>('make_up')
const list = ref<AttendanceRequest[]>([])
const histPage = ref(1)
const histTotal = ref(0)
const pageSize = 10
const detail = ref<AttendanceRequest | null>(null)
const rejectNote = ref('')
async function loadList(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverAttendanceList({
      companyId: companyId.value, type: historyType.value, page: histPage.value, pageSize
    })
    if (!ack.ok) { console.error('[考勤] 历史列表失败', ack.error); return }
    list.value = (ack.data as { requests?: AttendanceRequest[]; total?: number })?.requests ?? []
    histTotal.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[考勤] 历史列表异常', e) }
}
const histPages = computed(() => Math.max(1, Math.ceil(histTotal.value / pageSize)))

// 审批操作按钮可见：待审批 且（管理员 或 我在审批人名单里）
function canAct(r: AttendanceRequest): boolean {
  if (r.status !== 'pending') return false
  return isAdmin.value || (r.approverIds ?? []).includes(meId.value)
}
async function approve(r: AttendanceRequest): Promise<void> {
  try {
    const ack = await window.pantry.serverAttendanceApprove(companyId.value, r.id)
    if (!ack.ok) { console.error('[考勤] 通过失败', ack.error); err.value = ack.error || '操作失败'; return }
    detail.value = (ack.data as { request?: AttendanceRequest })?.request ?? detail.value
    await loadList()
    await loadReceived()
    removePending('att:' + r.id)
    // 审批结果落库后通知打卡页刷新（补卡/请假/调休通过 → 状态点黄→紫）。
    window.dispatchEvent(new CustomEvent('mochi:checkin:refresh'))
  } catch (e) { console.error('[考勤] 通过异常', e); err.value = '操作异常' }
}
async function reject(r: AttendanceRequest): Promise<void> {
  try {
    const ack = await window.pantry.serverAttendanceReject(companyId.value, r.id, rejectNote.value)
    if (!ack.ok) { console.error('[考勤] 驳回失败', ack.error); err.value = ack.error || '操作失败'; return }
    detail.value = (ack.data as { request?: AttendanceRequest })?.request ?? detail.value
    rejectNote.value = ''
    await loadList()
    await loadReceived()
    removePending('att:' + r.id)
    // 驳回也可能影响状态点（如驳回后异常未处理仍为黄），同步刷新打卡页。
    window.dispatchEvent(new CustomEvent('mochi:checkin:refresh'))
  } catch (e) { console.error('[考勤] 驳回异常', e); err.value = '操作异常' }
}

function fmt(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ── 收到审批 / 收到抄送 ──
const receivedPending = ref<AttendanceRequest[]>([])
const receivedDone = ref<AttendanceRequest[]>([])
const ccList = ref<AttendanceRequest[]>([])
async function loadReceived(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverAttendanceReceived(toPlain({ companyId: companyId.value }))
    if (!ack.ok) { console.error('[考勤] 收到审批加载失败', ack.error); return }
    const d = (ack.data as { pending?: AttendanceRequest[]; processed?: AttendanceRequest[] }) ?? {}
    receivedPending.value = d.pending ?? []
    receivedDone.value = d.processed ?? []
    // 注册待审进 1h 循环提醒；服务端已标记 notifyStopped 的条不重新注册（用户/审批已停止）
    const stopped = new Set(stoppedIds.value)
    receivedPending.value.forEach((r) => {
      if (r.notifyStopped) stopped.add(r.id)
      if (isStopped(r)) removePending('att:' + r.id)
      else addPending('att:' + r.id)
    })
    stoppedIds.value = stopped
    receivedDone.value.forEach((r) => removePending('att:' + r.id))
  } catch (e) { console.error('[考勤] 收到审批加载异常', e) }
}
async function loadCc(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverAttendanceCc(toPlain({ companyId: companyId.value }))
    if (!ack.ok) { console.error('[考勤] 收到抄送加载失败', ack.error); return }
    ccList.value = (ack.data as { list?: AttendanceRequest[] })?.list ?? []
  } catch (e) { console.error('[考勤] 收到抄送加载异常', e) }
}
async function openReceived(r: AttendanceRequest): Promise<void> {
  detail.value = r
  try {
    await window.pantry.serverAttendanceCcView(toPlain({ companyId: companyId.value, requestId: r.id }))
  } catch (e) { console.error('[考勤] 抄送标记查看失败', e) }
}
// 显式"停止提醒"：调服务端 attendance:request:notification:stop + 本地 removePending
// 本地记录已停止的条（Set 重新赋值以触发响应式）；服务端若返回 notifyStopped 同样展示"已停止"
const stoppedIds = ref<Set<number>>(new Set())
function isStopped(r: AttendanceRequest): boolean {
  return !!r.notifyStopped || stoppedIds.value.has(r.id)
}
async function snoozeRemind(r: AttendanceRequest): Promise<void> {
  err.value = ''
  try {
    const ack = await window.pantry.serverAttendanceNotifyStop(toPlain({ companyId: companyId.value, id: r.id }))
    if (!ack.ok) { console.error('[考勤] 停止提醒失败', ack.error); err.value = '停止提醒失败：' + (ack.error || ''); return }
    removePending('att:' + r.id)
    stoppedIds.value = new Set(stoppedIds.value).add(r.id)
    okMsg.value = '已停止对该条的循环提醒'
  } catch (e) { console.error('[考勤] 停止提醒异常', e); err.value = '停止提醒异常' }
}

watch(tab, () => { okMsg.value = ''; err.value = '' })
// 切申请类型 → 载入该类型草稿
watch(tab, (t) => {
  // 手动切 tab（非打卡页预填）：清空补卡锁定，防残留误传。
  if (!prefilled) { makeupDate.value = ''; makeupSlot.value = '' }
  prefilled = false
  loadDraft(t)
})
// 切历史类型 → 重置分页并加载
watch(historyType, () => { histPage.value = 1; loadList() })
watch(companyId, async () => {
  if (!companyId.value) return
  await loadList()
})
onMounted(async () => {
  loadDraft('make_up')
  await loadList()
  // 打卡页异常日期 → 补卡/请假：接收待预填参数（date/time）并填充表单。
  window.addEventListener('mochi:attendance:openApply', onOpenApply)
})
onBeforeUnmount(() => window.removeEventListener('mochi:attendance:openApply', onOpenApply))

// 打卡页点「补卡/请假」后的跨页预填。p = {type:'make_up'|'leave', date, slot?, time?}。
function onOpenApply(e: Event): void {
  const p = (e as CustomEvent).detail as { type?: AttType; date?: string; slot?: 'work' | 'off'; time?: string } | undefined
  if (!p || (p.type !== 'make_up' && p.type !== 'leave')) return
  topTab.value = 'apply'
  tab.value = p.type
  prefilled = true // 本次 tab 切换由打卡页预填触发，不清空补卡锁定
  if (p.type === 'make_up') {
    // 补卡：预填该日期 + 正常上下班时间
    const t = p.time && /^\d{2}:\d{2}$/.test(p.time) ? p.time : '09:00'
    makeupDate.value = p.date || ''
    makeupSlot.value = p.slot === 'off' ? 'off' : 'work'
    punchTime.value = `${p.date}T${t}`
    okMsg.value = '已按该日期预填补卡时间，请补充事由并选择审批人'
  } else if (p.type === 'leave') {
    // 请假：预填该日期区间
    makeupDate.value = ''
    makeupSlot.value = ''
    startTime.value = p.date || ''
    endTime.value = p.date || ''
    okMsg.value = '已按该日期预填请假区间，请选择类型并补充事由'
  }
  err.value = ''
  ;(window as any).__pendingAttendanceApply = null
}
</script>

<template>
  <div class="at">
    <div v-if="err" class="at-err">{{ err }}</div>
    <div v-if="okMsg" class="at-ok">{{ okMsg }}</div>

    <!-- 顶部：申请 | 历史记录 | 收到审批 | 收到抄送 标签页 -->
    <div class="at-tabs">
      <button :class="{ on: topTab === 'apply' }" @click="topTab = 'apply'">申请</button>
      <button :class="{ on: topTab === 'history' }" @click="topTab = 'history'">历史记录</button>
      <button :class="{ on: topTab === 'received' }" @click="topTab = 'received'; loadReceived()">收到审批</button>
      <button :class="{ on: topTab === 'cc' }" @click="topTab = 'cc'; loadCc()">收到抄送</button>
    </div>

    <!-- 上：申请表单 -->
    <div v-show="topTab === 'apply'" class="at-body at-form">
      <div class="at-seg">
        <button :class="{ on: tab === 'make_up' }" @click="tab = 'make_up'">补卡</button>
        <button :class="{ on: tab === 'leave' }" @click="tab = 'leave'">请假</button>
        <button :class="{ on: tab === 'comp_time' }" @click="tab = 'comp_time'">调休</button>
        <button :class="{ on: tab === 'overtime' }" @click="tab = 'overtime'">加班</button>
      </div>

      <!-- 补卡 -->
      <template v-if="tab === 'make_up'">
        <label class="at-lab">补卡时间 <i class="req">*</i></label>
        <DateTimeInput v-model="punchTime" time placeholder="选择补卡时间" />
      </template>
      <!-- 请假 / 调休 / 加班（共用时间段表单） -->
      <template v-else>
        <div class="at-row">
          <div v-if="tab === 'leave'">
            <label class="at-lab">请假类型 <i class="req">*</i></label>
            <select v-model="leaveType" class="srv-select">
              <option v-for="t in LEAVE_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <div v-else-if="tab === 'comp_time'">
            <label class="at-lab">调休类型 <i class="req">*</i></label>
            <select v-model="compType" class="srv-select">
              <option v-for="t in COMP_TYPES" :key="t" :value="t">{{ t }}</option>
            </select>
          </div>
          <!-- 加班：只选时间段，不设类型 -->
        </div>
        <div class="at-row">
          <div><label class="at-lab">开始时间 <i class="req">*</i></label><DateTimeInput v-model="startTime" time /></div>
          <div><label class="at-lab">结束时间 <i class="req">*</i></label><DateTimeInput v-model="endTime" time /></div>
          <div v-if="tab !== 'overtime'"><label class="at-lab">时长（小时）</label><input v-model.number="durationHours" type="number" step="0.5" class="srv-input" /></div>
        </div>
      </template>

      <label class="at-lab">事由 <i class="req">*</i></label>
      <RichTextEditor v-model="reason" placeholder="请填写事由…（可附图/视频/附件）" />

      <!-- 发起时动态选择审批人/抄送人（统一 CompanyContactPicker，随草稿保存） -->
      <div class="at-pick-row">
        <div>
          <label class="at-lab">审批人</label>
          <CompanyContactPicker v-model="approverIds" title="选择审批人" placeholder="选择审批人" />
        </div>
        <div>
          <label class="at-lab">抄送人</label>
          <CompanyContactPicker v-model="ccIds" title="选择抄送人" placeholder="选择抄送人" />
        </div>
      </div>

      <div class="at-actions">
        <button class="dt-btn" @click="saveDraft"><i class="fas fa-save"></i> 保存草稿</button>
        <button class="dt-btn dt-btn-primary" :disabled="submitting" @click="submit">
          <i class="fas fa-paper-plane"></i> {{ submitting ? '提交中…' : '提交申请' }}
        </button>
      </div>
    </div>

    <!-- 下：历史记录 -->
    <div v-show="topTab === 'history'" class="at-body at-records">
      <div class="at-rec-head">
        <div class="at-seg">
          <button :class="{ on: historyType === 'make_up' }" @click="historyType = 'make_up'">补卡</button>
          <button :class="{ on: historyType === 'leave' }" @click="historyType = 'leave'">请假</button>
          <button :class="{ on: historyType === 'comp_time' }" @click="historyType = 'comp_time'">调休</button>
          <button :class="{ on: historyType === 'overtime' }" @click="historyType = 'overtime'">加班</button>
        </div>
      </div>
      <div class="at-table-wrap">
        <div v-if="!list.length" class="at-empty">暂无{{ TYPE_LABEL[historyType] }}记录</div>
        <table v-else class="at-table">
          <thead><tr><th>类型</th><th>时间/时长</th><th>状态</th><th>提交时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in list" :key="r.id" class="at-row" @click="detail = r; rejectNote = ''">
              <td>{{ TYPE_LABEL[r.type] }}</td>
              <td>
                <span v-if="r.type === 'make_up'">{{ r.punchTime ? fmt(r.punchTime) : '—' }}</span>
                <span v-else>{{ r.startTime ? fmt(r.startTime) : '—' }} ~ {{ r.endTime ? fmt(r.endTime) : '—' }}（{{ r.durationHours ?? '—' }}h）</span>
              </td>
              <td><span class="at-badge" :class="r.status">{{ STATUS_LABEL[r.status] }}</span></td>
              <td>{{ fmt(r.createdAt) }}</td>
              <td class="at-ops">
                <button v-if="canAct(r)" class="at-op ok" @click.stop="approve(r)"><i class="fas fa-check"></i> 通过</button>
                <button v-if="canAct(r)" class="at-op danger" @click.stop="detail = r; rejectNote = ''"><i class="fas fa-times"></i> 驳回</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="at-pager">
        <button class="dt-btn" :disabled="histPage <= 1" @click="histPage--; loadList()">上一页</button>
        <span>{{ histPage }} / {{ histPages }}</span>
        <button class="dt-btn" :disabled="histPage >= histPages" @click="histPage++; loadList()">下一页</button>
      </div>
    </div>

    <!-- 收到审批 -->
    <div v-show="topTab === 'received'" class="at-body">
      <div class="at-sec-t">未处理（{{ receivedPending.length }}）</div>
      <div v-if="!receivedPending.length" class="at-empty">无待审批</div>
      <div v-for="r in receivedPending" :key="'p'+r.id" class="at-rrow" @click="openReceived(r)">
        <span class="at-badge" :class="r.status">{{ TYPE_LABEL[r.type] }}</span>
        <span v-if="isStopped(r)" class="at-stopped-badge"><i class="fas fa-bell-slash"></i> 已停止提醒</span>
        <span>{{ r.nick || r.username }}：{{ r.startTime ? fmt(r.startTime) : fmt(r.createdAt) }}</span>
        <span class="at-ops">
          <button class="at-op ok" @click.stop="approve(r)">通过</button>
          <button class="at-op danger" @click.stop="detail = r; rejectNote = ''">驳回</button>
          <button v-if="!isStopped(r)" class="at-op mute" title="不再循环提醒本条" @click.stop="snoozeRemind(r)"><i class="fas fa-bell-slash"></i> 停止提醒</button>
        </span>
      </div>
      <div class="at-sec-t">已处理（{{ receivedDone.length }}）</div>
      <div v-if="!receivedDone.length" class="at-empty">无已处理</div>
      <div v-for="r in receivedDone" :key="'d'+r.id" class="at-rrow" @click="openReceived(r)">
        <span class="at-badge" :class="r.status">{{ TYPE_LABEL[r.type] }}</span>
        <span>{{ r.nick || r.username }}：{{ fmt(r.createdAt) }}</span>
      </div>
    </div>

    <!-- 收到抄送 -->
    <div v-show="topTab === 'cc'" class="at-body">
      <div v-if="!ccList.length" class="at-empty">无抄送</div>
      <div v-for="r in ccList" :key="'c'+r.id" class="at-rrow" @click="openReceived(r)">
        <span class="at-badge" :class="r.status">{{ TYPE_LABEL[r.type] }}</span>
        <span>{{ r.nick || r.username }}：{{ fmt(r.createdAt) }}</span>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal at-modal">
        <div class="modal-head">{{ TYPE_LABEL[detail.type] }} · {{ STATUS_LABEL[detail.status] }}</div>
        <div class="modal-body">
          <div class="at-meta">
            提交人：{{ detail.nick || detail.username }}　提交时间：{{ fmt(detail.createdAt) }}
          </div>
          <div class="at-meta">
            <span v-if="detail.type !== 'make_up'">时长：{{ detail.durationHours ?? '—' }} 小时　</span>
            审批人：{{ namesOf(detail.approverIds) }}　抄送人：{{ namesOf(detail.ccIds) }}
          </div>
          <RichTextEditor :model-value="detail.reason" readonly />
          <div v-if="detail.status === 'rejected' && detail.approvalNote" class="at-reject-note">驳回原因：{{ detail.approvalNote }}</div>
          <div v-if="canAct(detail) && detail.status === 'pending'" class="at-reject-box">
            <label class="at-lab">驳回原因</label>
            <input v-model="rejectNote" class="srv-input" placeholder="驳回原因（可选）" />
          </div>
        </div>
        <div class="modal-foot">
          <button v-if="canAct(detail)" class="dt-btn" @click="approve(detail)"><i class="fas fa-check"></i> 通过</button>
          <button v-if="canAct(detail)" class="dt-btn danger" @click="reject(detail)"><i class="fas fa-times"></i> 驳回</button>
          <button class="dt-btn" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.at { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; }
.at-tabs { display: flex; gap: 4px; padding: 10px 18px 0; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.at-tabs button { border: none; background: transparent; padding: 8px 14px; font-size: 14px; cursor: pointer; color: var(--dt-text-3); border-bottom: 2px solid transparent; }
.at-tabs button.on { color: var(--dt-primary); font-weight: 700; border-bottom-color: var(--dt-primary); }
.at-err { padding: 6px 18px 0; color: #d92b3a; font-size: 13px; flex-shrink: 0; }
.at-ok { padding: 6px 18px 0; color: #2fbb6b; font-size: 13px; flex-shrink: 0; }
.at-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 18px; }
.at-seg { display: inline-flex; background: #f0f2f5; border-radius: 8px; padding: 2px; margin-bottom: 8px; }
.at-seg button { border: none; background: transparent; padding: 4px 14px; font-size: 13px; cursor: pointer; border-radius: 6px; color: var(--dt-text-3); }
.at-seg button.on { background: #fff; color: var(--dt-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.at-row { display: flex; gap: 12px; margin-bottom: 4px; }
.at-row > div { flex: 1; }
.at-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.at-flow-hint { margin-top: 10px; font-size: 12px; color: var(--dt-text-3); background: #f6f8fb; padding: 6px 10px; border-radius: 6px; }
.at-actions { display: flex; gap: 10px; margin-top: 12px; }
.at-pick-row { display: flex; gap: 16px; margin-top: 4px; }
.at-pick-row > div { flex: 1; }
.at-rec-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.at-sec-title { font-size: 14px; font-weight: 700; }
.at-sec-title.admin { margin-top: 18px; }
.at-table-wrap { overflow: auto; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.at-empty { color: var(--dt-text-4); text-align: center; padding: 24px 0; font-size: 13px; }
.at-sec-t { font-size: 13px; font-weight: 700; margin: 10px 0 6px; }
.at-rrow { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); font-size: 13px; cursor: pointer; }
.at-rrow:hover { background: var(--dt-bg-hover); }
.at-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; }
.at-table th, .at-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); white-space: nowrap; }
.at-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.at-row { cursor: pointer; }
.at-row:hover { background: #f6f8fb; }
.at-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.at-badge.pending { background: #fff3e0; color: #d46b08; }
.at-badge.approved { background: #e8f9ef; color: #2fbb6b; }
.at-badge.rejected { background: #ffe3e3; color: #d92b3a; }
.at-ops { display: flex; gap: 6px; }
.at-op { border: none; background: transparent; cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; }
.at-op.ok { color: #2fbb6b; }
.at-op.danger { color: #d92b3a; }
.at-op.mute { color: #8a94a6; }
.at-stopped-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; background: #f3f4f6; color: #9ca3af; }
.at-pager { display: flex; align-items: center; gap: 10px; margin: 8px 0 16px; font-size: 12px; color: var(--dt-text-3); }
.at-flow-cfg { border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 10px; margin-top: 6px; }
.at-flow-row { display: flex; align-items: flex-end; gap: 12px; padding: 8px 0; border-bottom: 1px dashed var(--dt-border-light); }
.at-flow-row:last-child { border-bottom: none; }
.at-flow-type { width: 50px; font-weight: 700; font-size: 13px; }
.at-flow-field { flex: 1; }
.at-modal { width: 560px; }
.at-meta { font-size: 12px; color: var(--dt-text-3); margin-bottom: 8px; }
.at-reject-note { margin-top: 8px; color: #d92b3a; font-size: 13px; }
.at-reject-box { margin-top: 10px; }
.req { color: #e64545; font-style: normal; }
.dt-btn.sm { padding: 3px 10px; font-size: 12px; }
</style>
