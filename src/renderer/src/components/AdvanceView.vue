<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import RichTextEditor from './common/RichTextEditor.vue'
import CompanyContactPicker from './CompanyContactPicker.vue'
import { toPlain } from '../utils/plain'
import { fmtHuman } from '../utils/time'
import { advanceDeepLinkId, clearAdvanceDeepLink } from '../utils/advance-deeplink'
import { canActApproval } from '../utils/approval'
import { buildApprovalCard } from '../utils/approval-card'

// ── 类型（与服务端冻结协议对齐，数据字段同报销）──
type AdvCategory = 'travel' | 'purchase' | 'daily' | 'project' | 'other'
type AdvStatus = 'pending' | 'approved' | 'rejected'
interface AdvanceRequest {
  id: number
  companyId: number
  userId: number
  category: AdvCategory
  amount: number
  reason: string
  evidence: string[]
  status: AdvStatus
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
interface Draft {
  category: AdvCategory
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

const CATEGORY_LABEL: Record<AdvCategory, string> = {
  travel: '差旅', purchase: '采购', daily: '日常', project: '项目', other: '其他'
}
const CATEGORIES = Object.keys(CATEGORY_LABEL) as AdvCategory[]
const STATUS_LABEL: Record<AdvStatus, string> = { pending: '待审批', approved: '已通过', rejected: '已驳回' }

// ── 顶部标签页：申请 | 历史记录 | 收到审批 | 收到抄送 ──
const topTab = ref<'apply' | 'history' | 'received' | 'cc'>('apply')

// ── 申请表单 ──
const category = ref<AdvCategory>('travel')
const amount = ref<number | null>(null)
const reason = ref('')
const evidence = ref<string[]>([])
const evidenceNames = ref<string[]>([])
const approverIds = ref<number[]>([])
const ccIds = ref<number[]>([])
const sendCard = ref(false)
const submitting = ref(false)
const uploading = ref(false)
const err = ref('')
const okMsg = ref('')

// ── 草稿 ──
const DRAFT_KEY = 'mochi:oa:adv:draft'
function currentDraft(): Draft {
  return {
    category: category.value, amount: amount.value, reason: reason.value,
    evidence: [...evidence.value], evidenceNames: [...evidenceNames.value],
    approverIds: [...approverIds.value], ccIds: [...ccIds.value]
  }
}
function applyDraft(d: Draft): void {
  category.value = d.category || 'travel'
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
  } catch (e) { console.error('[备用金] 草稿读取失败', e) }
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
  } catch (e) { console.error('[备用金] 读取默认抄送失败', e) }
}
function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(currentDraft()))
    okMsg.value = '草稿已保存'
  } catch (e) { console.error('[备用金] 草稿保存失败', e); err.value = '草稿保存失败' }
}
function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY) } catch (e) { console.error('[备用金] 草稿清除失败', e) }
}

/** 凭证上传：复用聊天同一套分块上传 */
async function addEvidence(): Promise<void> {
  const filePath = await window.pantry.pickFile()
  if (!filePath) return
  uploading.value = true
  err.value = ''
  try {
    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const up = await window.pantry.serverUploadChunked(filePath, clientId, companyId.value || 0, '')
    if (!up.ok || !up.url) { console.error('[备用金] 凭证上传失败', up.error); err.value = up.error || '上传失败'; return }
    evidence.value.push(up.url)
    evidenceNames.value.push(up.fileName || '凭证')
  } catch (e) { console.error('[备用金] 凭证上传异常', e); err.value = '上传异常' }
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
  if (!approverIds.value.length) { err.value = '请选择审批人'; return }
  submitting.value = true
  try {
    const ack = await window.pantry.serverAdvanceCreate({
      companyId: companyId.value,
      category: category.value,
      amount: Number(amount.value),
      reason: reason.value,
      evidence: evidence.value,
      approverIds: approverIds.value,
      ccIds: ccIds.value
    })
    if (!ack.ok) { console.error('[备用金] 提交失败', ack.error); err.value = ack.error || '提交失败'; return }
    const req = (ack.data as { request?: AdvanceRequest })?.request
    okMsg.value = '已提交'
    if (sendCard.value && req?.id != null) {
      const body = `${Number(amount.value).toFixed(2)} 元 · ${CATEGORY_LABEL[category.value]}：${toPlain(reason.value).slice(0, 80)}`
      for (const aid of approverIds.value) {
        try {
          await window.pantry.serverDmSend(aid, buildApprovalCard('advance_card', { requestId: req.id, title: '备用金申请', body, byNick: myNick.value }), 'advance_card')
        } catch (e) { console.error('[备用金] 卡片消息发送失败', e) }
      }
    }
    clearDraft()
    amount.value = null; reason.value = ''; evidence.value = []; evidenceNames.value = []
    approverIds.value = []; ccIds.value = []; sendCard.value = false
    // 提交成功后重新带出默认抄送，供下一次发起
    void prefetchDefaultCc()
    await loadList()
  } catch (e) { console.error('[备用金] 提交异常', e); err.value = '提交异常' }
  submitting.value = false
}

// ── 历史记录（本人，分页）──
const list = ref<AdvanceRequest[]>([])
const histPage = ref(1)
const histTotal = ref(0)
const pageSize = 10
const detail = ref<AdvanceRequest | null>(null)
const rejectNote = ref('')
const hlId = ref<number | null>(null)
async function loadList(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverAdvanceList({ companyId: companyId.value, page: histPage.value, pageSize })
    if (!ack.ok) { console.error('[备用金] 历史列表失败', ack.error); return }
    const d = (ack.data as { list?: AdvanceRequest[]; total?: number }) ?? {}
    list.value = d.list ?? []
    histTotal.value = d.total ?? 0
  } catch (e) { console.error('[备用金] 历史列表异常', e) }
}
const histPages = computed(() => Math.max(1, Math.ceil(histTotal.value / pageSize)))

// 审批操作按钮可见（需求 7.2）：pending 且（管理员 或 我在审批人名单里）。纯逻辑见 utils/approval。
function canAct(r: AdvanceRequest): boolean {
  return canActApproval({ status: r.status, meId: meId.value, approverIds: r.approverIds, isAdmin: isAdmin.value })
}
async function approve(r: AdvanceRequest): Promise<void> {
  err.value = ''
  try {
    const ack = await window.pantry.serverAdvanceApprove(r.id, rejectNote.value || undefined)
    if (!ack.ok) { console.error('[备用金] 通过失败', ack.error); err.value = ack.error || '操作失败'; return }
    detail.value = (ack.data as { request?: AdvanceRequest })?.request ?? detail.value
    await loadList(); await loadReceived()
  } catch (e) { console.error('[备用金] 通过异常', e); err.value = '操作异常' }
}
async function reject(r: AdvanceRequest): Promise<void> {
  if (!rejectNote.value.trim()) { err.value = '请填写驳回原因'; return }
  err.value = ''
  try {
    const ack = await window.pantry.serverAdvanceReject(r.id, rejectNote.value.trim())
    if (!ack.ok) { console.error('[备用金] 驳回失败', ack.error); err.value = ack.error || '操作失败'; return }
    detail.value = (ack.data as { request?: AdvanceRequest })?.request ?? detail.value
    rejectNote.value = ''
    await loadList(); await loadReceived()
  } catch (e) { console.error('[备用金] 驳回异常', e); err.value = '操作异常' }
}

// ── 收到审批 / 收到抄送 ──
const receivedPending = ref<AdvanceRequest[]>([])
const receivedDone = ref<AdvanceRequest[]>([])
const ccUnviewed = ref<AdvanceRequest[]>([])
const ccViewed = ref<AdvanceRequest[]>([])
async function loadReceived(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverAdvanceReceived(companyId.value)
    if (!ack.ok) { console.error('[备用金] 收到审批加载失败', ack.error); return }
    const d = (ack.data as { pending?: AdvanceRequest[]; processed?: AdvanceRequest[] }) ?? {}
    receivedPending.value = d.pending ?? []
    receivedDone.value = d.processed ?? []
  } catch (e) { console.error('[备用金] 收到审批加载异常', e) }
}
async function loadCc(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverAdvanceCc(companyId.value)
    if (!ack.ok) { console.error('[备用金] 收到抄送加载失败', ack.error); return }
    const d = (ack.data as { unviewed?: AdvanceRequest[]; viewed?: AdvanceRequest[] }) ?? {}
    ccUnviewed.value = d.unviewed ?? []
    ccViewed.value = d.viewed ?? []
  } catch (e) { console.error('[备用金] 收到抄送加载异常', e) }
}
async function openCc(r: AdvanceRequest): Promise<void> {
  detail.value = r
  if (!r.viewed) {
    try {
      await window.pantry.serverAdvanceCcView(r.id)
      await loadCc()
    } catch (e) { console.error('[备用金] 抄送标记查看失败', e) }
  }
}

watch(companyId, async () => { if (companyId.value) await loadList() })

onMounted(async () => {
  loadDraft()
  await loadList()
  if (advanceDeepLinkId.value != null) {
    const id = advanceDeepLinkId.value
    clearAdvanceDeepLink()
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
  <div class="av">
    <div v-if="err" class="av-err">{{ err }}</div>
    <div v-if="okMsg" class="av-ok">{{ okMsg }}</div>

    <div class="av-tabs">
      <button :class="{ on: topTab === 'apply' }" @click="topTab = 'apply'">申请</button>
      <button :class="{ on: topTab === 'history' }" @click="topTab = 'history'">历史记录</button>
      <button :class="{ on: topTab === 'received' }" @click="topTab = 'received'; loadReceived()">收到审批</button>
      <button :class="{ on: topTab === 'cc' }" @click="topTab = 'cc'; loadCc()">收到抄送</button>
    </div>

    <div v-show="topTab === 'apply'" class="av-body av-form">
      <div class="at-row">
        <div>
          <label class="av-lab">备用金类型 <i class="req">*</i></label>
          <select v-model="category" class="srv-select">
            <option v-for="c in CATEGORIES" :key="c" :value="c">{{ CATEGORY_LABEL[c] }}</option>
          </select>
        </div>
        <div>
          <label class="av-lab">金额（元） <i class="req">*</i></label>
          <input v-model.number="amount" type="number" min="0.01" step="0.01" class="srv-input" placeholder="0.00" />
        </div>
      </div>

      <label class="av-lab">事由 <i class="req">*</i></label>
      <RichTextEditor v-model="reason" placeholder="请填写备用金事由…（可附图/视频/附件）" />

      <label class="av-lab">凭证附件</label>
      <div class="av-ev-row">
        <button class="dt-btn" :disabled="uploading" @click="addEvidence">
          <i :class="uploading ? 'fas fa-spinner fa-spin' : 'fas fa-paperclip'"></i> 上传凭证
        </button>
        <span v-for="(n, i) in evidenceNames" :key="i" class="av-ev-chip">
          <i class="fas fa-paperclip"></i> {{ n }}
          <i class="fas fa-times av-ev-x" @click="removeEvidence(i)"></i>
        </span>
      </div>

      <div class="av-pick-row">
        <div>
          <label class="av-lab">审批人</label>
          <CompanyContactPicker v-model="approverIds" title="选择审批人" placeholder="选择审批人" />
        </div>
        <div>
          <label class="av-lab">抄送人</label>
          <CompanyContactPicker v-model="ccIds" title="选择抄送人" placeholder="选择抄送人" />
        </div>
      </div>

      <label class="av-card"><input type="checkbox" v-model="sendCard" /> 以消息卡片发送给审批人</label>

      <div class="av-actions">
        <button class="dt-btn" @click="saveDraft"><i class="fas fa-save"></i> 保存草稿</button>
        <button class="dt-btn dt-btn-primary" :disabled="submitting" @click="submit">
          <i class="fas fa-paper-plane"></i> {{ submitting ? '提交中…' : '提交申请' }}
        </button>
      </div>
    </div>

    <div v-show="topTab === 'history'" class="av-body av-records">
      <div class="av-table-wrap">
        <div v-if="!list.length" class="av-empty">暂无备用金记录</div>
        <table v-else class="av-table">
          <thead><tr><th>类型</th><th>金额</th><th>事由</th><th>状态</th><th>时间</th></tr></thead>
          <tbody>
            <!-- 需求 7.2：历史记录只读，不直接渲染通过/驳回；点行打开详情卡片后按 canAct 显示操作 -->
            <tr v-for="r in list" :key="r.id" class="av-row" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="detail = r; rejectNote = ''">
              <td>{{ CATEGORY_LABEL[r.category] }}</td>
              <td>¥{{ Number(r.amount).toFixed(2) }}</td>
              <td class="av-reason-cell">{{ toPlain(r.reason).slice(0, 30) || '—' }}</td>
              <td><span class="av-badge" :class="r.status">{{ STATUS_LABEL[r.status] }}</span></td>
              <td>{{ fmtHuman(r.createdAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="av-pager">
        <button class="dt-btn" :disabled="histPage <= 1" @click="histPage--; loadList()">上一页</button>
        <span>{{ histPage }} / {{ histPages }}</span>
        <button class="dt-btn" :disabled="histPage >= histPages" @click="histPage++; loadList()">下一页</button>
      </div>
    </div>

    <div v-show="topTab === 'received'" class="av-body">
      <div class="av-sec-t">未处理（{{ receivedPending.length }}）</div>
      <div v-if="!receivedPending.length" class="av-empty">无待审批</div>
      <!-- 需求 7.2：待审批项不在行内直接显示通过/驳回；点卡片打开详情后，卡片内按 canAct 显示审批信息与按钮 -->
      <div v-for="r in receivedPending" :key="'p'+r.id" class="av-rrow" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="detail = r; rejectNote = ''">
        <span class="av-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
      </div>
      <div class="av-sec-t">已处理（{{ receivedDone.length }}）</div>
      <div v-if="!receivedDone.length" class="av-empty">无已处理</div>
      <div v-for="r in receivedDone" :key="'d'+r.id" class="av-rrow" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="detail = r; rejectNote = ''">
        <span class="av-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
      </div>
    </div>

    <div v-show="topTab === 'cc'" class="av-body">
      <div class="av-sec-t">未查看（{{ ccUnviewed.length }}）</div>
      <div v-if="!ccUnviewed.length" class="av-empty">无未查看抄送</div>
      <div v-for="r in ccUnviewed" :key="'u'+r.id" class="av-rrow" :class="{ hl: hlId === r.id }" :data-req-id="r.id" @click="openCc(r)">
        <span class="av-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
      </div>
      <div class="av-sec-t">已查看（{{ ccViewed.length }}）</div>
      <div v-if="!ccViewed.length" class="av-empty">无已查看抄送</div>
      <div v-for="r in ccViewed" :key="'v'+r.id" class="av-rrow" :data-req-id="r.id" @click="openCc(r)">
        <span class="av-badge" :class="r.status">{{ CATEGORY_LABEL[r.category] }}</span>
        <span>{{ r.nick || r.username }}：¥{{ Number(r.amount).toFixed(2) }} · {{ fmtHuman(r.createdAt) }}</span>
      </div>
    </div>

    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal at-modal">
        <div class="modal-head">备用金 · {{ CATEGORY_LABEL[detail.category] }} · {{ STATUS_LABEL[detail.status] }}</div>
        <div class="modal-body">
          <div class="av-meta">提交人：{{ detail.nick || detail.username }}　金额：¥{{ Number(detail.amount).toFixed(2) }}　提交时间：{{ fmtHuman(detail.createdAt) }}</div>
          <div class="av-meta">审批人：{{ namesOf(detail.approverIds) }}　抄送人：{{ namesOf(detail.ccIds) }}</div>
          <RichTextEditor :model-value="detail.reason" readonly />
          <div v-if="detail.evidence && detail.evidence.length" class="av-meta">
            凭证：
            <a v-for="(u, i) in detail.evidence" :key="i" :href="u" target="_blank" class="av-ev-link"><i class="fas fa-paperclip"></i> 凭证 {{ i + 1 }}</a>
          </div>
          <div v-if="detail.status === 'rejected' && detail.approvalNote" class="av-reject-note">驳回原因：{{ detail.approvalNote }}</div>
          <div v-if="canAct(detail) && detail.status === 'pending'" class="av-reject-box">
            <label class="av-lab">驳回原因（驳回必填）</label>
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
.av { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; }
.av-tabs { display: flex; gap: 4px; padding: 10px 18px 0; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.av-tabs button { border: none; background: transparent; padding: 8px 14px; font-size: 14px; cursor: pointer; color: var(--dt-text-3); border-bottom: 2px solid transparent; }
.av-tabs button.on { color: var(--dt-primary); font-weight: 700; border-bottom-color: var(--dt-primary); }
.av-err { padding: 6px 18px 0; color: #d92b3a; font-size: 13px; flex-shrink: 0; }
.av-ok { padding: 6px 18px 0; color: #2fbb6b; font-size: 13px; flex-shrink: 0; }
.av-body { flex: 1; min-height: 0; overflow: auto; padding: 12px 18px; }
.at-row { display: flex; gap: 12px; margin-bottom: 4px; }
.at-row > div { flex: 1; }
.av-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.av-card { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dt-text-2); margin-top: 12px; }
.av-actions { display: flex; gap: 10px; margin-top: 12px; }
.av-pick-row { display: flex; gap: 16px; margin-top: 4px; }
.av-pick-row > div { flex: 1; }
.av-ev-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.av-ev-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; background: #f0f4ff; color: var(--dt-primary); padding: 2px 8px; border-radius: 12px; }
.av-ev-x { cursor: pointer; color: #d92b3a; }
.av-ev-link { margin-right: 8px; font-size: 12px; color: var(--dt-primary); }
.av-sec-t { font-size: 13px; font-weight: 700; margin: 10px 0 6px; }
.av-rrow { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); font-size: 13px; cursor: pointer; }
.av-rrow:hover { background: var(--dt-bg-hover); }
.av-rrow.hl, .av-row.hl { background: #fff7e6 !important; box-shadow: inset 3px 0 0 var(--dt-primary); }
.av-table-wrap { overflow: auto; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.av-empty { color: var(--dt-text-4); text-align: center; padding: 24px 0; font-size: 13px; }
.av-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; }
.av-table th, .av-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); white-space: nowrap; }
.av-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.av-row { cursor: pointer; }
.av-row:hover { background: #f6f8fb; }
.av-reason-cell { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.av-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.av-badge.pending { background: #fff3e0; color: #d46b08; }
.av-badge.approved { background: #e8f9ef; color: #2fbb6b; }
.av-badge.rejected { background: #ffe3e3; color: #d92b3a; }
.av-ops { display: flex; gap: 6px; }
.av-op { border: none; background: transparent; cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; }
.av-op.ok { color: #2fbb6b; }
.av-op.danger { color: #d92b3a; }
.av-pager { display: flex; align-items: center; gap: 10px; margin: 8px 0 16px; font-size: 12px; color: var(--dt-text-3); }
.at-modal { width: 560px; }
.av-meta { font-size: 12px; color: var(--dt-text-3); margin-bottom: 8px; }
.av-reject-note { margin-top: 8px; color: #d92b3a; font-size: 13px; }
.av-reject-box { margin-top: 10px; }
.req { color: #e64545; font-style: normal; }
</style>
