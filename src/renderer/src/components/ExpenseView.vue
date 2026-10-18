<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import RichTextEditor from './common/RichTextEditor.vue'
import CompanyContactPicker from './CompanyContactPicker.vue'
import { toPlain } from '../utils/plain'
import { fmtHuman } from '../utils/time'
import { expenseDeepLinkId, clearExpenseDeepLink } from '../utils/expense-deeplink'

// ── 类型（与服务端冻结协议对齐）──
type ExpCategory = 'transport' | 'meal' | 'lodging' | 'office' | 'travel' | 'medical' | 'other'
type ExpStatus = 'pending' | 'approved' | 'rejected'
interface ExpenseRequest {
  id: number
  companyId: number
  userId: number
  category: ExpCategory
  amount: number
  reason: string
  evidence: string[]
  status: ExpStatus
  approverIds: number[]
  ccIds: number[]
  approverId: number | null
  approvalNote: string | null
  approvedAt: string | null
  createdAt: string
  nick?: string
  username?: string
  viewed?: boolean
}
// 草稿结构（localStorage；含审批人/抄送人选择与凭证）
interface Draft {
  category: ExpCategory
  amount: number | null
  reason: string
  evidence: string[]
  evidenceNames: string[]
  approverIds: number[]
  ccIds: number[]
}

const app = useAppStore()
const server = useServerStore()
const companyId = computed(() => app.activeCompanyId)
const isAdmin = computed(() => app.isAdmin)
const meId = computed(() => server.state.userId ?? 0)
const myNick = computed(() => app.members.find((m) => m.userId === meId.value)?.nick || server.state.username || '我')

const CATEGORY_LABEL: Record<ExpCategory, string> = {
  transport: '交通', meal: '餐饮', lodging: '住宿', office: '办公', travel: '差旅', medical: '医疗', other: '其他'
}
const CATEGORIES = Object.keys(CATEGORY_LABEL) as ExpCategory[]
const STATUS_LABEL: Record<ExpStatus, string> = { pending: '待审批', approved: '已通过', rejected: '已驳回' }

// ── 顶部标签页：申请 | 历史记录 | 收到审批 | 收到抄送 ──
const topTab = ref<'apply' | 'history' | 'received' | 'cc'>('apply')

// ── 申请表单 ──
const category = ref<ExpCategory>('transport')
const amount = ref<number | null>(null)
const reason = ref('')
const evidence = ref<string[]>([])
const evidenceNames = ref<string[]>([])
const approverIds = ref<number[]>([])
const ccIds = ref<number[]>([])
const sendCard = ref(false) // 创建成功后给审批人发消息卡片
const submitting = ref(false)
const uploading = ref(false)
const err = ref('')
const okMsg = ref('')

// ── 草稿 ──
const DRAFT_KEY = 'mochi:oa:exp:draft'
function currentDraft(): Draft {
  return {
    category: category.value, amount: amount.value, reason: reason.value,
    evidence: [...evidence.value], evidenceNames: [...evidenceNames.value],
    approverIds: [...approverIds.value], ccIds: [...ccIds.value]
  }
}
function applyDraft(d: Draft): void {
  category.value = d.category || 'transport'
  amount.value = d.amount ?? null
  reason.value = d.reason || ''
  evidence.value = d.evidence ?? []
  evidenceNames.value = d.evidenceNames ?? []
  approverIds.value = d.approverIds ?? []
  ccIds.value = d.ccIds ?? []
}
function loadDraft(): void {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) applyDraft(JSON.parse(raw) as Draft)
  } catch (e) { console.error('[报销] 草稿读取失败', e) }
}
function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(currentDraft()))
    okMsg.value = '草稿已保存'
  } catch (e) { console.error('[报销] 草稿保存失败', e); err.value = '草稿保存失败' }
}
function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY) } catch (e) { console.error('[报销] 草稿清除失败', e) }
}

/** 凭证上传：复用聊天同一套分块上传（pickFile + serverUploadChunked），拿 url 入 evidence */
async function addEvidence(): Promise<void> {
  const filePath = await window.pantry.pickFile()
  if (!filePath) return
  uploading.value = true
  err.value = ''
  try {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const up = await window.pantry.serverUploadChunked(filePath, clientId, companyId.value || 0, '')
    if (!up.ok || !up.url) { console.error('[报销] 凭证上传失败', up.error); err.value = up.error || '上传失败'; return }
    evidence.value.push(up.url)
    evidenceNames.value.push(up.fileName || '凭证')
  } catch (e) { console.error('[报销] 凭证上传异常', e); err.value = '上传异常' }
  uploading.value = false
}
function removeEvidence(i: number): void {
  evidence.value.splice(i, 1)
  evidenceNames.value.splice(i, 1)
}

function namesOf(ids: number[]): string {
  if (!ids || !ids.length) return '—'
  return ids.map((id) => app.members.find((m) => m.userId === id)?.nick || app.members.find((m) => m.userId === id)?.username || `#${id}`).join('、')
}

// ── 提交申请 ──
async function submit(): Promise<void> {
  if (!companyId.value) { err.value = '尚未加入公司'; return }
  err.value = ''; okMsg.value = ''
  if (!amount.value || !(amount.value > 0)) { err.value = '请输入大于 0 的金额'; return }
  if (!reason.value.trim()) { err.value = '请填写事由'; return }
  submitting.value = true
  try {
    const ack = await window.pantry.serverCreateExpense({
      companyId: companyId.value,
      category: category.value,
      amount: Number(amount.value),
      reason: reason.value,
      evidence: evidence.value,
      approverIds: approverIds.value,
      ccIds: ccIds.value
    })
    if (!ack.ok) { console.error('[报销] 提交失败', ack.error); err.value = ack.error || '提交失败'; return }
    const req = (ack.data as { request?: ExpenseRequest })?.request
    okMsg.value = '已提交'
    // 勾选「以消息卡片发送」→ 给每个审批人发 expense_card DM
    if (sendCard.value && req?.id != null) {
      const body = `${Number(amount.value).toFixed(2)} 元 · ${CATEGORY_LABEL[category.value]}：${toPlain(reason.value).slice(0, 80)}`
      for (const aid of approverIds.value) {
        try {
          await window.pantry.serverDmSend(aid, JSON.stringify({ requestId: req.id, title: '报销申请', body, byNick: myNick.value }), 'expense_card')
        } catch (e) { console.error('[报销] 卡片消息发送失败', e) }
      }
    }
    clearDraft()
    amount.value = null; reason.value = ''; evidence.value = []; evidenceNames.value = []
    approverIds.value = []; ccIds.value = []; sendCard.value = false
    await loadList()
  } catch (e) { console.error('[报销] 提交异常', e); err.value = '提交异常' }
  submitting.value = false
}

// ── 历史记录（本人，分页）──
const list = ref<ExpenseRequest[]>([])
const histPage = ref(1)
const histTotal = ref(0)
const pageSize = 10
const detail = ref<ExpenseRequest | null>(null)
const rejectNote = ref('')
const hlId = ref<number | null>(null)
async function loadList(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverExpenseList({ companyId: companyId.value, page: histPage.value, pageSize })
    if (!ack.ok) { console.error('[报销] 历史列表失败', ack.error); return }
    const d = (ack.data as { list?: ExpenseRequest[]; total?: number }) ?? {}
    list.value = d.list ?? []
    histTotal.value = d.total ?? 0
  } catch (e) { console.error('[报销] 历史列表异常', e) }
}
const histPages = computed(() => Math.max(1, Math.ceil(histTotal.value / pageSize)))

// 审批操作按钮可见：待审批 且（管理员 或 我在审批人名单里）
function canAct(r: ExpenseRequest): boolean {
  if (r.status !== 'pending') return false
  return isAdmin.value || (r.approverIds ?? []).includes(meId.value)
}
async function approve(r: ExpenseRequest): Promise<void> {
  err.value = ''
  try {
    const ack = await window.pantry.serverExpenseApprove(r.id, rejectNote.value || undefined)
    if (!ack.ok) { console.error('[报销] 通过失败', ack.error); err.value = ack.error || '操作失败'; return }
    detail.value = (ack.data as { request?: ExpenseRequest })?.request ?? detail.value
    await loadList(); await loadReceived()
  } catch (e) { console.error('[报销] 通过异常', e); err.value = '操作异常' }
}
async function reject(r: ExpenseRequest): Promise<void> {
  if (!rejectNote.value.trim()) { err.value = '请填写驳回原因'; return }
  err.value = ''
  try {
    const ack = await window.pantry.serverExpenseReject(r.id, rejectNote.value.trim())
    if (!ack.ok) { console.error('[报销] 驳回失败', ack.error); err.value = ack.error || '操作失败'; return }
    detail.value = (ack.data as { request?: ExpenseRequest })?.request ?? detail.value
    rejectNote.value = ''
    await loadList(); await loadReceived()
  } catch (e) { console.error('[报销] 驳回异常', e); err.value = '操作异常' }
}

// ── 收到审批 / 收到抄送 ──
const receivedPending = ref<ExpenseRequest[]>([])
const receivedDone = ref<ExpenseRequest[]>([])
const ccUnviewed = ref<ExpenseRequest[]>([])
const ccViewed = ref<ExpenseRequest[]>([])
async function loadReceived(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverExpenseReceived(companyId.value)
    if (!ack.ok) { console.error('[报销] 收到审批加载失败', ack.error); return }
    const d = (ack.data as { pending?: ExpenseRequest[]; processed?: ExpenseRequest[] }) ?? {}
    receivedPending.value = d.pending ?? []
    receivedDone.value = d.processed ?? []
  } catch (e) { console.error('[报销] 收到审批加载异常', e) }
}
async function loadCc(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverExpenseCc(companyId.value)
    if (!ack.ok) { console.error('[报销] 收到抄送加载失败', ack.error); return }
    const d = (ack.data as { unviewed?: ExpenseRequest[]; viewed?: ExpenseRequest[] }) ?? {}
    ccUnviewed.value = d.unviewed ?? []
    ccViewed.value = d.viewed ?? []
  } catch (e) { console.error('[报销] 收到抄送加载异常', e) }
}
// 点开抄送：未查看 → 标记已读并刷新分组
async function openCc(r: ExpenseRequest): Promise<void> {
  detail.value = r
  if (!r.viewed) {
    try {
      await window.pantry.serverExpenseCcView(r.id)
      await loadCc()
    } catch (e) { console.error('[报销] 抄送标记查看失败', e) }
  }
}

watch(companyId, async () => { if (companyId.value) await loadList() })

onMounted(async () => {
  loadDraft()
  await loadList()
  // 深链：来自消息卡片 → 切到对应分组并定位高亮
  if (expenseDeepLinkId.value != null) {
    const id = expenseDeepLinkId.value
    clearExpenseDeepLink()
    await Promise.all([loadReceived(), loadCc()])
    let target: 'history' | 'received' | 'cc' | null = null
    if (list.value.some((r) => r.id === id)) target = 'history'
    else if ([...receivedPending.value, ...receivedDone.value].some((r) => r.id === id)) target = 'received'
    else if ([...ccUnviewed.value, ...ccViewed.value].some((r) => r.id === id)) target = 'cc'
    if (target) topTab.value = target
    hlId.value = id
    await nextTick()
    const el = document.querySelector(`[data-req-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
})
</script>

<template>
  <div class="ev">
    <div v-if="err" class="ev-err">{{ err }}</div>
    <div v-if="okMsg" class="ev-ok">{{ okMsg }}</div>

    <!-- 顶部：申请 | 历史记录 | 收到审批 | 收到抄送 -->
    <div class="ev-tabs">
      <button :class="{ on: topTab === 'apply' }" @click="topTab = 'apply'">申请</button>
      <button :class="{ on: topTab === 'history' }" @click="topTab = 'history'">历史记录</button>
      <button :class="{ on: topTab === 'received' }" @click="topTab = 'received'; loadReceived()">收到审批</button>
      <button :class="{ on: topTab === 'cc' }" @click="topTab = 'cc'; loadCc()">收到抄送</button>
    </div>

    <!-- 申请表单 -->
    <div v-show="topTab === 'apply'" class="ev-body ev-form">
      <div class="at-row">
        <div>
          <label class="ev-lab">报销类型 <i class="req">*</i></label>
          <select v-model="category" class="srv-select">
            <option v-for="c in CATEGORIES" :key="c" :value="c">{{ CATEGORY_LABEL[c] }}</option>
          </select>
        </div>
        <div>
          <label class="ev-lab">金额（元） <i class="req">*</i></label>
          <input v-model.number="amount" type="number" min="0.01" step="0.01" class="srv-input" placeholder="0.00" />
        </div>
      </div>

      <label class="ev-lab">事由 <i class="req">*</i></label>
      <RichTextEditor v-model="reason" placeholder="请填写报销事由…（可附图/视频/附件）" />

      <label class="ev-lab">凭证附件</label>
      <div class="ev-ev-row">
        <button class="dt-btn" :disabled="uploading" @click="addEvidence">
          <i :class="uploading ? 'fas fa-spinner fa-spin' : 'fas fa-paperclip'"></i> 上传凭证
        </button>
        <span v-for="(n, i) in evidenceNames" :key="i" class="ev-ev-chip">
          <i class="fas fa-paperclip"></i> {{ n }}
          <i class="fas fa-times ev-ev-x" @click="removeEvidence(i)"></i>
        </span>
      </div>

      <div class="ev-pick-row">
        <div>
          <label class="ev-lab">审批人</label>
          <CompanyContactPicker v-model="approverIds" title="选择审批人" placeholder="选择审批人" />
        </div>
        <div>
          <label class="ev-lab">抄送人</label>
          <CompanyContactPicker v-model="ccIds" title="选择抄送人" placeholder="选择抄送人" />
        </div>
      </div>

      <label class="ev-card"><input type="checkbox" v-model="sendCard" /> 以消息卡片发送给审批人</label>

      <div class="ev-actions">
        <button class="dt-btn" @click="saveDraft"><i class="fas fa-save"></i> 保存草稿</button>
        <button class="dt-btn dt-btn-primary" :disabled="submitting" @click="submit">
          <i class="fas fa-paper-plane"></i> {{ submitting ? '提交中…' : '提交申请' }}
        </button>
      </div>
    </div>

    <!-- 历史记录 -->
    <div v-show="topTab === 'history'" class="ev-body ev-records">
      <div class="ev-table-wrap">
        <div v-if="!list.length" class="ev-empty">暂无报销记录</div>
        <table v-else class="ev-table">
          <thead><tr><th>类型</th><th>金额</th><th>事由</th><th>状态</th><th>时间</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in list" :key="r.id" class="ev-row" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="detail = r; rejectNote = ''">
              <td>{{ CATEGORY_LABEL[r.category] }}</td>
              <td>¥{{ Number(r.amount).toFixed(2) }}</td>
              <td class="ev-reason-cell">{{ toPlain(r.reason).slice(0, 30) || '—' }}</td>
              <td><span class="ev-badge" :class="r.status">{{ STATUS_LABEL[r.status] }}</span></td>
              <td>{{ fmtHuman(r.createdAt) }}</td>
              <td class="ev-ops">
                <button v-if="canAct(r)" class="ev-op ok" @click.stop="approve(r)"><i class="fas fa-check"></i> 通过</button>
                <button v-if="canAct(r)" class="ev-op danger" @click.stop="detail = r; rejectNote = ''"><i class="fas fa-times"></i> 驳回</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="ev-pager">
        <button class="dt-btn" :disabled="histPage <= 1" @click="histPage--; loadList()">上一页</button>
        <span>{{ histPage }} / {{ histPages }}</span>
        <button class="dt-btn" :disabled="histPage >= histPages" @click="histPage++; loadList()">下一页</button>
      </div>
    </div>

    <!-- 收到审批 -->
    <div v-show="topTab === 'received'" class="ev-body">
      <div class="ev-sec-t">未处理（{{ receivedPending.length }}）</div>
      <div v-if="!receivedPending.length" class="ev-empty">无待审批</div>
      <div v-for="r in receivedPending" :key="'p'+r.id" class="ev-rrow" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="detail = r; rejectNote = ''">
        <span class="ev-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
        <span class="ev-ops">
          <button class="ev-op ok" @click.stop="approve(r)">通过</button>
          <button class="ev-op danger" @click.stop="detail = r; rejectNote = ''">驳回</button>
        </span>
      </div>
      <div class="ev-sec-t">已处理（{{ receivedDone.length }}）</div>
      <div v-if="!receivedDone.length" class="ev-empty">无已处理</div>
      <div v-for="r in receivedDone" :key="'d'+r.id" class="ev-rrow" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="detail = r; rejectNote = ''">
        <span class="ev-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
      </div>
    </div>

    <!-- 收到抄送 -->
    <div v-show="topTab === 'cc'" class="ev-body">
      <div class="ev-sec-t">未查看（{{ ccUnviewed.length }}）</div>
      <div v-if="!ccUnviewed.length" class="ev-empty">无未查看抄送</div>
      <div v-for="r in ccUnviewed" :key="'u'+r.id" class="ev-rrow" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="openCc(r)">
        <span class="ev-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
      </div>
      <div class="ev-sec-t">已查看（{{ ccViewed.length }}）</div>
      <div v-if="!ccViewed.length" class="ev-empty">无已查看抄送</div>
      <div v-for="r in ccViewed" :key="'v'+r.id" class="ev-rrow" :data-req-id="r.id" @click="openCc(r)">
        <span class="ev-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal at-modal">
        <div class="modal-head">报销 · {{ CATEGORY_LABEL[detail.category] }} · {{ STATUS_LABEL[detail.status] }}</div>
        <div class="modal-body">
          <div class="ev-meta">提交人：{{ detail.nick || detail.username }}　金额：¥{{ Number(detail.amount).toFixed(2) }}　提交时间：{{ fmtHuman(detail.createdAt) }}</div>
          <div class="ev-meta">审批人：{{ namesOf(detail.approverIds) }}　抄送人：{{ namesOf(detail.ccIds) }}</div>
          <RichTextEditor :model-value="detail.reason" readonly />
          <div v-if="detail.evidence && detail.evidence.length" class="ev-meta">
            凭证：
            <a v-for="(u, i) in detail.evidence" :key="i" :href="u" target="_blank" class="ev-ev-link"><i class="fas fa-paperclip"></i> 凭证 {{ i + 1 }}</a>
          </div>
          <div v-if="detail.status === 'rejected' && detail.approvalNote" class="ev-reject-note">驳回原因：{{ detail.approvalNote }}</div>
          <div v-if="canAct(detail) && detail.status === 'pending'" class="ev-reject-box">
            <label class="ev-lab">驳回原因（驳回必填）</label>
            <input v-model="rejectNote" class="srv-input" placeholder="驳回原因" />
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
.ev { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; }
.ev-tabs { display: flex; gap: 4px; padding: 10px 18px 0; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.ev-tabs button { border: none; background: transparent; padding: 8px 14px; font-size: 14px; cursor: pointer; color: var(--dt-text-3); border-bottom: 2px solid transparent; }
.ev-tabs button.on { color: var(--dt-primary); font-weight: 700; border-bottom-color: var(--dt-primary); }
.ev-err { padding: 6px 18px 0; color: #d92b3a; font-size: 13px; flex-shrink: 0; }
.ev-ok { padding: 6px 18px 0; color: #2fbb6b; font-size: 13px; flex-shrink: 0; }
.ev-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 18px; }
.at-row { display: flex; gap: 12px; margin-bottom: 4px; }
.at-row > div { flex: 1; }
.ev-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.ev-card { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dt-text-2); margin-top: 12px; }
.ev-actions { display: flex; gap: 10px; margin-top: 12px; }
.ev-pick-row { display: flex; gap: 16px; margin-top: 4px; }
.ev-pick-row > div { flex: 1; }
.ev-ev-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.ev-ev-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; background: #f0f4ff; color: var(--dt-primary); padding: 2px 8px; border-radius: 12px; }
.ev-ev-x { cursor: pointer; color: #d92b3a; }
.ev-ev-link { margin-right: 8px; font-size: 12px; color: var(--dt-primary); }
.ev-sec-t { font-size: 13px; font-weight: 700; margin: 10px 0 6px; }
.ev-rrow { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); font-size: 13px; cursor: pointer; }
.ev-rrow:hover { background: var(--dt-bg-hover); }
.ev-rrow.hl, .ev-row.hl { background: #fff7e6 !important; box-shadow: inset 3px 0 0 var(--dt-primary); }
.ev-table-wrap { overflow: auto; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.ev-empty { color: var(--dt-text-4); text-align: center; padding: 24px 0; font-size: 13px; }
.ev-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; }
.ev-table th, .ev-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); white-space: nowrap; }
.ev-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.ev-row { cursor: pointer; }
.ev-row:hover { background: #f6f8fb; }
.ev-reason-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.ev-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.ev-badge.pending { background: #fff3e0; color: #d46b08; }
.ev-badge.approved { background: #e8f9ef; color: #2fbb6b; }
.ev-badge.rejected { background: #ffe3e3; color: #d92b3a; }
.ev-ops { display: flex; gap: 6px; }
.ev-op { border: none; background: transparent; cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; }
.ev-op.ok { color: #2fbb6b; }
.ev-op.danger { color: #d92b3a; }
.ev-pager { display: flex; align-items: center; gap: 10px; margin: 8px 0 16px; font-size: 12px; color: var(--dt-text-3); }
.at-modal { width: 560px; }
.ev-meta { font-size: 12px; color: var(--dt-text-3); margin-bottom: 8px; }
.ev-reject-note { margin-top: 8px; color: #d92b3a; font-size: 13px; }
.ev-reject-box { margin-top: 10px; }
.req { color: #e64545; font-style: normal; }
</style>
