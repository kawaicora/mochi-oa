<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'
import RichTextEditor from './common/RichTextEditor.vue'
import MemberPicker from './common/MemberPicker.vue'
import { toPlain } from '../utils/plain'

// ── 类型（与服务端冻结协议对齐，content 存 HTML）──
type ReportType = 'daily' | 'weekly'
interface ReportItem {
  id: number
  companyId: number
  userId: number
  type: ReportType
  periodDate: string
  title: string
  content: string
  templateId: number | null
  submitted: boolean
  submittedAt: string | null
  createdAt: string
  updatedAt: string
  nick?: string
  username?: string
  /** 接收人 userId 数组（发给了谁） */
  recipientIds?: number[]
}
interface ReportTemplate {
  id: number
  companyId: number
  name: string
  description: string
  sections: string[]
  createdBy: number
  createdAt: string
  updatedAt: string
}
interface StatMember {
  userId: number
  nick?: string
  username?: string
  submittedDays: number
  missingDays: number
  lastSubmittedAt: string | null
}
interface ReportStats {
  type: string
  periodStart: string
  periodEnd: string
  totalDays: number
  members: StatMember[]
}
interface ReminderEvent {
  companyId?: number
  type?: string
  periodDate?: string
  missingUsers?: Array<{ userId: number; nick?: string; username?: string }>
}

const app = useAppStore()
// 公司隔离：所有接口都带当前公司 id
const companyId = computed(() => app.activeCompanyId)
const isAdmin = computed(() => app.isAdmin)
// 公司门控（与 MainScreen 一致）：发送人控件仍显式 v-if
const hasCompany = computed(() => app.companies.length > 0 && app.activeCompanyId > 0)

// ── 周期工具：本地时区 YYYY-MM-DD ──
function pad(n: number): string { return String(n).padStart(2, '0') }
function toStr(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
function todayStr(): string { return toStr(new Date()) }
/** 本周一（本地） */
function mondayDate(): Date {
  const d = new Date()
  const day = d.getDay() // 0=周日
  const diff = day === 0 ? -6 : 1 - day
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + diff)
}
function mondayStr(): string { return toStr(mondayDate()) }
function sundayStr(): string { const m = mondayDate(); return toStr(new Date(m.getFullYear(), m.getMonth(), m.getDate() + 6)) }
/** 当前周期归属日：日报=今天，周报=本周周一 */
function periodDate(): string { return type.value === 'daily' ? todayStr() : mondayStr() }

// ── 顶部：四个独立标签页 日报/周报/提交历史/我收到的 ──
const type = ref<ReportType>('daily')
const mainTab = ref<'daily' | 'weekly' | 'history' | 'inbox'>('daily')
const histType = ref<'all' | ReportType>('all') // 提交历史 tab 的类型筛选
function setMainTab(t: 'daily' | 'weekly' | 'history' | 'inbox') {
  mainTab.value = t
  if (t === 'daily' || t === 'weekly') type.value = t
  else if (t === 'history') { histPage.value = 1; loadHistory('all') }
  else if (t === 'inbox') loadInbox()
}
const periodLabel = computed(() => (type.value === 'daily' ? `今日 ${todayStr()}` : `本周 ${mondayStr()} ~ ${sundayStr()}`))

// ── 我的报表编辑区 ──
const current = ref<ReportItem | null>(null)
const title = ref('')
const contentHtml = ref('') // 富文本 HTML 字符串
const templateId = ref<number>(0)
const templates = ref<ReportTemplate[]>([])
// 「发送给」接收人多选（提交时作为 recipients 传给服务端）
const recipients = ref<number[]>([])
const saving = ref(false)
const submitting = ref(false)
const err = ref('')
const okMsg = ref('')
const submittedFlash = ref(false)

// ── 草稿缓存（按日报/周报分 key，避免跨类型泄漏）──
const draftKey = (t: ReportType) => `mochi:oa:report:draft:${t}`
watch([title, contentHtml, templateId, type, recipients], () => {
  try {
    localStorage.setItem(draftKey(type.value), JSON.stringify({
      type: type.value,
      title: title.value,
      contentHtml: contentHtml.value,
      templateId: templateId.value,
      recipients: recipients.value
    }))
  } catch (e) { console.error('[报表] 写草稿失败', e) }
}, { deep: true })
function clearDraft(): void { try { localStorage.removeItem(draftKey(type.value)) } catch (e) { console.error('[报表] 清草稿失败', e) } }
function restoreDraft(): void {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(type.value)) ?? 'null') as {
      type?: ReportType; title?: string; contentHtml?: string; templateId?: number; recipients?: number[]
    } | null
    // 跨类型草稿不恢复（type 不匹配直接忽略，避免日报内容漏到周报）
    if (d && d.type === type.value) {
      title.value = d.title ?? ''
      contentHtml.value = d.contentHtml ?? ''
      templateId.value = d.templateId ?? 0
      recipients.value = Array.isArray(d.recipients) ? d.recipients : []
    }
  } catch (e) { console.error('[报表] 读草稿失败', e) }
}

// ── 加载：当前报表 / 模板 ──
async function loadTemplates(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverReportTemplateList(companyId.value)
    if (ack.ok) templates.value = (ack.data as { templates?: ReportTemplate[] })?.templates ?? []
    else console.error('[报表] 模板列表失败', ack.error)
  } catch (e) { console.error('[报表] 模板列表异常', e) }
}
async function loadCurrent(): Promise<void> {
  if (!companyId.value) return
  err.value = ''
  try {
    const ack = await window.pantry.serverReportCurrent(companyId.value, type.value)
    if (!ack.ok) { console.error('[报表] 当前报表失败', ack.error); err.value = ack.error || '加载当前报表失败'; return }
    const rep = (ack.data as { report?: ReportItem | null })?.report ?? null
    current.value = rep
    title.value = rep?.title ?? ''
    templateId.value = rep?.templateId ?? 0
    contentHtml.value = rep?.content ?? ''
    recipients.value = Array.isArray(rep?.recipientIds) ? [...(rep!.recipientIds as number[])] : []
    if (!rep) restoreDraft() // 还没写过 → 恢复上次未提交草稿
    else clearDraft() // 已有服务端记录 → 以服务端为准，清掉草稿
  } catch (e) { console.error('[报表] 当前报表异常', e); err.value = '加载当前报表异常' }
}

// ── 保存（自动区分 create / update）──
async function doSave(): Promise<void> {
  if (!companyId.value) { err.value = '尚未加入公司'; return }
  const content = contentHtml.value
  if (!content.trim() && !title.value.trim()) { err.value = '标题或内容不能为空'; return }
  saving.value = true
  err.value = ''
  okMsg.value = ''
  try {
    let ack
    // 接收人：update 传了则全量替换；create 带上。toPlain 剥掉 Vue Proxy 防 IPC 克隆错误。
    const recipientsPayload = hasCompany.value ? toPlain(recipients.value) : []
    if (current.value && current.value.id > 0) {
      ack = await window.pantry.serverReportUpdate(toPlain({
        companyId: companyId.value, id: current.value.id,
        title: title.value.trim(), content,
        templateId: templateId.value > 0 ? templateId.value : null,
        recipients: recipientsPayload
      }))
    } else {
      ack = await window.pantry.serverReportCreate(toPlain({
        companyId: companyId.value, type: type.value, periodDate: periodDate(),
        title: title.value.trim(), content,
        templateId: templateId.value > 0 ? templateId.value : null,
        recipients: recipientsPayload
      }))
    }
    if (!ack.ok) { console.error('[报表] 保存失败', ack.error); err.value = ack.error || '保存失败'; return }
    current.value = (ack.data as { report?: ReportItem })?.report ?? current.value
    okMsg.value = '已保存'
    clearDraft()
    await loadHistory()
  } catch (e) { console.error('[报表] 保存异常', e); err.value = '保存异常' }
  saving.value = false
}

// ── 新建一篇（清空编辑器，写新草稿）──
function newReport(): void {
  current.value = null
  title.value = ''
  contentHtml.value = ''
  templateId.value = 0
  recipients.value = []
  err.value = ''
  okMsg.value = ''
  // 清空本地草稿，避免恢复旧内容
  clearDraft()
}

// ── 提交 ──
async function doSubmit(): Promise<void> {
  // 没保存过的新内容先自动保存（创建/update），再提交
  if (!current.value || !current.value.id) {
    // 还没 id → 先保存（create）
    await doSave()
    if (!current.value || !current.value.id) { err.value = '保存失败，无法提交'; return }
  }
  submitting.value = true
  err.value = ''
  okMsg.value = ''
  try {
    const ack = await window.pantry.serverReportSubmit(companyId.value, current.value.id)
    if (!ack.ok) { console.error('[报表] 提交失败', ack.error); err.value = ack.error || '提交失败'; return }
    current.value = (ack.data as { report?: ReportItem })?.report ?? current.value
    okMsg.value = current.value?.submitted ? '已提交（可继续编辑后重新提交）' : '已提交'
    submittedFlash.value = true
    setTimeout(() => { submittedFlash.value = false }, 3000)
    await loadHistory()
  } catch (e) { console.error('[报表] 提交异常', e); err.value = '提交异常' }
  submitting.value = false
}

// ── 我的提交（历史）──
const history = ref<ReportItem[]>([])
const histPage = ref(1)
const histTotal = ref(0)
const pageSize = 10
const detail = ref<ReportItem | null>(null)
async function loadHistory(hType: 'all' | ReportType = type.value): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverReportList({
      companyId: companyId.value, type: hType === 'all' ? '' : hType,
      page: histPage.value, pageSize
    })
    if (!ack.ok) { console.error('[报表] 历史列表失败', ack.error); return }
    history.value = (ack.data as { reports?: ReportItem[]; total?: number })?.reports ?? []
    histTotal.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[报表] 历史列表异常', e) }
}
const histPages = computed(() => Math.max(1, Math.ceil(histTotal.value / pageSize)))

// ── 我收到的（别人发给我的）──
const inbox = ref<ReportItem[]>([])
const inboxPage = ref(1)
const inboxTotal = ref(0)
const inboxPages = computed(() => Math.max(1, Math.ceil(inboxTotal.value / pageSize)))
async function loadInbox(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverReportInbox({
      companyId: companyId.value, page: inboxPage.value, pageSize
    })
    if (!ack.ok) { console.error('[报表] 收件箱失败', ack.error); return }
    inbox.value = (ack.data as { reports?: ReportItem[]; total?: number })?.reports ?? []
    inboxTotal.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[报表] 收件箱异常', e) }
}

function fmtDateTime(s: string | null): string {
  if (!s) return '—'
  const d = new Date(s)
  return `${toStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ── 管理区：模板管理 ──
const tplModal = ref<{ id: number | null; name: string; description: string; sectionsText: string } | null>(null)
function openTplCreate(): void {
  tplModal.value = { id: null, name: '', description: '', sectionsText: '' }
}
function openTplEdit(t: ReportTemplate): void {
  tplModal.value = { id: t.id, name: t.name, description: t.description ?? '', sectionsText: (t.sections ?? []).join('\n') }
}
async function submitTpl(): Promise<void> {
  const m = tplModal.value
  if (!m) return
  if (!m.name.trim()) { err.value = '模板名称不能为空'; return }
  // 逗号或换行拆分为 section 数组
  const sections = m.sectionsText.split(/[\n,，]/).map((s) => s.trim()).filter((s) => s.length > 0)
  err.value = ''
  try {
    let ack
    if (m.id) {
      ack = await window.pantry.serverReportTemplateUpdate({ companyId: companyId.value, id: m.id, name: m.name.trim(), description: m.description.trim(), sections })
    } else {
      ack = await window.pantry.serverReportTemplateCreate({ companyId: companyId.value, name: m.name.trim(), description: m.description.trim(), sections })
    }
    if (!ack.ok) { console.error('[报表] 模板保存失败', ack.error); err.value = ack.error || '模板保存失败'; return }
    tplModal.value = null
    await loadTemplates()
  } catch (e) { console.error('[报表] 模板保存异常', e); err.value = '模板保存异常' }
}
async function deleteTpl(t: ReportTemplate): Promise<void> {
  if (!confirm(`删除模板「${t.name}」？`)) return
  try {
    const ack = await window.pantry.serverReportTemplateDelete(companyId.value, t.id)
    if (!ack.ok) { console.error('[报表] 模板删除失败', ack.error); err.value = ack.error || '模板删除失败'; return }
    await loadTemplates()
    if (templateId.value === t.id) templateId.value = 0
  } catch (e) { console.error('[报表] 模板删除异常', e); err.value = '模板删除异常' }
}

// ── 管理区：统计 / 未交 ──
const stats = ref<ReportStats | null>(null)
const statsStart = ref('')
const statsEnd = ref('')
/** 默认范围：日报=最近7天，周报=最近4周 */
function applyDefaultRange(): void {
  if (type.value === 'daily') {
    const end = new Date(); const start = new Date(); start.setDate(end.getDate() - 6)
    statsStart.value = toStr(start); statsEnd.value = toStr(end)
  } else {
    const mon = mondayDate()
    const start = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - 21)
    statsStart.value = toStr(start); statsEnd.value = sundayStr()
  }
}
async function loadStats(): Promise<void> {
  if (!isAdmin.value || !companyId.value) return
  try {
    const ack = await window.pantry.serverReportStats({
      companyId: companyId.value, type: type.value,
      periodStart: statsStart.value, periodEnd: statsEnd.value
    })
    if (!ack.ok) { console.error('[报表] 统计失败', ack.error); return }
    stats.value = (ack.data as { stats?: ReportStats })?.stats ?? null
  } catch (e) { console.error('[报表] 统计异常', e) }
}

// ── 顶部提醒条（report:reminder 推送）──
const reminderBanner = ref<{ n: number; typeLabel: string } | null>(null)
let offReminder: (() => void) | null = null
function onReminder(d: ReminderEvent): void {
  console.log('[报表] 收到到点提醒', d)
  if (d.companyId && d.companyId !== companyId.value) return // 公司不匹配则忽略
  const n = d.missingUsers?.length ?? 0
  const label = d.type === 'weekly' ? '周报' : '日报'
  reminderBanner.value = { n, typeLabel: label }
  if (isAdmin.value) void loadStats()
}

// ── 切换类型 / 公司时整体刷新 ──
watch(type, async () => {
  applyDefaultRange()
  histPage.value = 1
  await Promise.all([loadCurrent(), loadHistory(), loadStats()])
})
watch(companyId, async () => {
  if (!companyId.value) return
  applyDefaultRange()
  histPage.value = 1
  inboxPage.value = 1
  await Promise.all([loadTemplates(), loadCurrent(), loadHistory(), loadStats(), loadInbox()])
})

onMounted(async () => {
  offReminder = window.pantry.onReportReminder(onReminder)
  applyDefaultRange()
  await Promise.all([loadTemplates(), loadCurrent(), loadHistory(), loadStats(), loadInbox()])
})
onUnmounted(() => { offReminder?.() })
</script>

<template>
  <div class="rp">
    <!-- 顶部：四个独立标签页 日报/周报/提交历史/我收到的 -->
    <div class="rp-bar">
      <span class="rp-title"><i class="fas fa-file-alt"></i> 报表</span>
      <div class="rp-seg">
        <button :class="{ on: mainTab === 'daily' }" @click="setMainTab('daily')">日报</button>
        <button :class="{ on: mainTab === 'weekly' }" @click="setMainTab('weekly')">周报</button>
        <button :class="{ on: mainTab === 'history' }" @click="setMainTab('history')">提交历史</button>
        <button :class="{ on: mainTab === 'inbox' }" @click="setMainTab('inbox')">我收到的</button>
      </div>
      <span v-if="mainTab === 'daily' || mainTab === 'weekly'" class="rp-period">{{ periodLabel }}</span>
    </div>

    <!-- 到点提醒条 -->
    <div v-if="reminderBanner" class="rp-remind">
      <i class="fas fa-bell"></i>&nbsp;
      今日还有 {{ reminderBanner.n }} 人未交{{ reminderBanner.typeLabel }}
      <button class="rp-remind-x" @click="reminderBanner = null"><i class="fas fa-times"></i></button>
    </div>

    <div v-if="err" class="rp-err">{{ err }}</div>
    <div v-if="okMsg" class="rp-ok">{{ okMsg }}<i v-if="submittedFlash" class="fas fa-check-circle"></i> 已提交</div>

    <!-- 上：我的编辑区（仅在 日报/周报 标签页显示） -->
    <div v-if="mainTab === 'daily' || mainTab === 'weekly'" class="rp-edit">
      <div class="rp-sec-head">我的{{ type === 'daily' ? '日报' : '周报' }}
        <span v-if="current && current.submitted" class="rp-submitted-badge">已提交</span>
        <span v-else-if="current" class="rp-draft-badge">草稿</span>
      </div>

      <div class="rp-edit-row">
        <div class="rp-tpl-col">
          <label class="rp-lab">模板</label>
          <select v-model.number="templateId" class="srv-select">
            <option :value="0">不使用模板</option>
            <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
          </select>
        </div>
        <div class="rp-title-col">
          <label class="rp-lab">标题</label>
          <input v-model="title" class="srv-input" :placeholder="type === 'daily' ? '日报标题（可留空）' : '周报标题（可留空）'" />
        </div>
      </div>

      <label class="rp-lab">内容</label>
      <RichTextEditor v-model="contentHtml" :placeholder="type === 'daily' ? '今天做了什么 / 遇到什么问题 / 明天计划…' : '本周总结 / 下周计划…'" />

      <!-- 发送给（接收人多选，仅已加入公司显示；通用 MemberPicker） -->
      <div v-if="hasCompany" class="rp-recv">
        <label class="rp-lab">发送给</label>
        <MemberPicker v-model="recipients" placeholder="选择接收人" />
      </div>

      <div class="rp-actions">
        <button class="dt-btn dt-btn-primary" :disabled="saving" @click="doSave">
          <i class="fas fa-save"></i> {{ saving ? '保存中…' : '保存' }}
        </button>
        <button class="dt-btn" :disabled="submitting" @click="doSubmit">
          <i class="fas fa-paper-plane"></i> {{ submitting ? '提交中…' : (current?.submitted ? '重新提交' : '提交') }}
        </button>
        <button class="dt-btn" @click="newReport">
          <i class="fas fa-file-plus"></i> 新一篇
        </button>
      </div>
    </div>

    <!-- 下：记录区（按 4 个标签页独立展示，不挤在一起） -->
    <div class="rp-records">
      <!-- 日报 / 周报 tab：该类型我的提交记录 -->
      <template v-if="mainTab === 'daily' || mainTab === 'weekly'">
        <div class="rp-seg-head">我的{{ type === 'daily' ? '日报' : '周报' }}提交</div>
        <div class="rp-table-wrap">
          <div v-if="!history.length" class="rp-empty">暂无提交记录</div>
          <table v-else class="rp-table">
            <thead><tr><th>周期</th><th>标题</th><th>状态</th><th>提交时间</th></tr></thead>
            <tbody>
              <tr v-for="r in history" :key="r.id" @click="detail = r" class="rp-row">
                <td>{{ r.periodDate }}</td>
                <td class="rp-cell-title">{{ r.title || '（无标题）' }}</td>
                <td>
                  <span v-if="r.submitted" class="rp-badge ok">已提交</span>
                  <span v-else class="rp-badge warn">草稿</span>
                </td>
                <td>{{ fmtDateTime(r.submittedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="rp-pager">
          <button class="dt-btn" :disabled="histPage <= 1" @click="histPage--; loadHistory()">上一页</button>
          <span>{{ histPage }} / {{ histPages }}</span>
          <button class="dt-btn" :disabled="histPage >= histPages" @click="histPage++; loadHistory()">下一页</button>
        </div>
      </template>

      <!-- 提交历史 tab：我的提交（全部 / 按类型筛选） -->
      <template v-else-if="mainTab === 'history'">
        <div class="rp-seg">
          <button :class="{ on: histType === 'all' }" @click="histType = 'all'; histPage = 1; loadHistory('all')">全部</button>
          <button :class="{ on: histType === 'daily' }" @click="histType = 'daily'; histPage = 1; loadHistory('daily')">日报</button>
          <button :class="{ on: histType === 'weekly' }" @click="histType = 'weekly'; histPage = 1; loadHistory('weekly')">周报</button>
        </div>
        <div class="rp-table-wrap">
          <div v-if="!history.length" class="rp-empty">暂无提交记录</div>
          <table v-else class="rp-table">
            <thead><tr><th>类型</th><th>周期</th><th>标题</th><th>状态</th><th>提交时间</th></tr></thead>
            <tbody>
              <tr v-for="r in history" :key="r.id" @click="detail = r" class="rp-row">
                <td>{{ r.type === 'daily' ? '日报' : '周报' }}</td>
                <td>{{ r.periodDate }}</td>
                <td class="rp-cell-title">{{ r.title || '（无标题）' }}</td>
                <td>
                  <span v-if="r.submitted" class="rp-badge ok">已提交</span>
                  <span v-else class="rp-badge warn">草稿</span>
                </td>
                <td>{{ fmtDateTime(r.submittedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="rp-pager">
          <button class="dt-btn" :disabled="histPage <= 1" @click="histPage--; loadHistory(histType === 'all' ? 'all' : histType)">上一页</button>
          <span>{{ histPage }} / {{ histPages }}</span>
          <button class="dt-btn" :disabled="histPage >= histPages" @click="histPage++; loadHistory(histType === 'all' ? 'all' : histType)">下一页</button>
        </div>
      </template>

      <!-- 我收到的 tab -->
      <template v-else>
        <div class="rp-seg-head">我收到的</div>
        <div class="rp-table-wrap">
          <div v-if="!inbox.length" class="rp-empty">还没有收到别人发给你的报表</div>
          <table v-else class="rp-table">
            <thead><tr><th>发送人</th><th>周期</th><th>标题</th><th>提交时间</th></tr></thead>
            <tbody>
              <tr v-for="r in inbox" :key="r.id" @click="detail = r" class="rp-row">
                <td>{{ r.nick || r.username }}</td>
                <td>{{ r.periodDate }}</td>
                <td class="rp-cell-title">{{ r.title || '（无标题）' }}</td>
                <td>{{ fmtDateTime(r.submittedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="rp-pager">
          <button class="dt-btn" :disabled="inboxPage <= 1" @click="inboxPage--; loadInbox()">上一页</button>
          <span>{{ inboxPage }} / {{ inboxPages }}</span>
          <button class="dt-btn" :disabled="inboxPage >= inboxPages" @click="inboxPage++; loadInbox()">下一页</button>
        </div>
      </template>

      <!-- 管理区（仅 owner/admin） -->
      <template v-if="isAdmin">
        <div class="rp-sec-head admin">模板管理
          <button class="dt-btn sm" @click="openTplCreate"><i class="fas fa-plus"></i> 新建模板</button>
        </div>
        <div class="rp-tpl-list">
          <div v-for="t in templates" :key="t.id" class="rp-tpl-item">
            <div class="rp-tpl-name">{{ t.name }}<span v-if="t.description" class="rp-tpl-desc"> — {{ t.description }}</span></div>
            <div class="rp-tpl-sections">{{ (t.sections ?? []).join(' / ') || '无分节' }}</div>
            <div class="rp-tpl-ops">
              <button class="rp-op" @click="openTplEdit(t)"><i class="fas fa-edit"></i> 编辑</button>
              <button class="rp-op danger" @click="deleteTpl(t)"><i class="fas fa-trash"></i> 删除</button>
            </div>
          </div>
          <div v-if="!templates.length" class="rp-empty">还没有模板</div>
        </div>

        <div class="rp-sec-head admin">未交统计
          <div class="rp-range">
            <input type="date" v-model="statsStart" class="srv-input sm" />
            <span>~</span>
            <input type="date" v-model="statsEnd" class="srv-input sm" />
            <button class="dt-btn sm" @click="loadStats()"><i class="fas fa-search"></i> 查询</button>
          </div>
        </div>
        <div class="rp-table-wrap">
          <div v-if="!stats || !stats.members.length" class="rp-empty">暂无统计数据</div>
          <table v-else class="rp-table">
            <thead><tr><th>成员</th><th>已交天数</th><th>未交天数</th><th>最近提交</th></tr></thead>
            <tbody>
              <tr v-for="m in stats.members" :key="m.userId" :class="{ 'rp-miss': m.missingDays > 0 }">
                <td>{{ m.nick || m.username }}</td>
                <td>{{ m.submittedDays }}</td>
                <td>{{ m.missingDays }}</td>
                <td>{{ fmtDateTime(m.lastSubmittedAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- 详情弹窗（HTML 渲染） -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal rp-modal">
        <div class="modal-head">{{ detail.title || `${detail.type === 'daily' ? '日报' : '周报'} · ${detail.periodDate}` }}</div>
        <div class="modal-body">
          <div class="rp-meta">
            周期：{{ detail.periodDate }}　提交时间：{{ fmtDateTime(detail.submittedAt) }}
            <span v-if="detail.nick || detail.username">　发送人：{{ detail.nick || detail.username }}</span>
          </div>
          <RichTextEditor :model-value="detail.content" readonly />
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 模板新建/编辑弹窗 -->
    <div v-if="tplModal" class="modal-mask" @click.self="tplModal = null">
      <div class="modal rp-modal">
        <div class="modal-head">{{ tplModal.id ? '编辑模板' : '新建模板' }}</div>
        <div class="modal-body">
          <label class="rp-lab">名称 <i class="req">*</i></label>
          <input v-model="tplModal.name" class="srv-input" placeholder="模板名称" />
          <label class="rp-lab">描述</label>
          <input v-model="tplModal.description" class="srv-input" placeholder="模板描述（可选）" />
          <label class="rp-lab">分节（每行一个，或用逗号分隔）</label>
          <textarea v-model="tplModal.sectionsText" class="srv-input rp-area" rows="5" placeholder="今日工作&#10;遇到的问题&#10;明日计划"></textarea>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="tplModal = null">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitTpl">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rp { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; }
.rp-bar { display: flex; align-items: center; gap: 14px; padding: 12px 18px; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.rp-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.rp-seg { display: inline-flex; background: #f0f2f5; border-radius: 8px; padding: 2px; }
.rp-seg button { border: none; background: transparent; padding: 4px 14px; font-size: 13px; cursor: pointer; border-radius: 6px; color: var(--dt-text-3); }
.rp-seg button.on { background: #fff; color: var(--dt-primary); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
.rp-period { font-size: 13px; color: var(--dt-text-3); }
.rp-remind { margin: 8px 18px 0; padding: 8px 12px; background: #fff7e6; border: 1px solid #ffd591; color: #d46b08; border-radius: 8px; font-size: 13px; display: flex; align-items: center; }
.rp-remind-x { margin-left: auto; border: none; background: transparent; cursor: pointer; color: #d46b08; }
.rp-err { padding: 8px 18px; color: #d92b3a; font-size: 13px; }
.rp-ok { padding: 8px 18px; color: #2fbb6b; font-size: 13px; }

/* 上：编辑区（flex 占满剩余，固定行压缩，RichTextEditor 填中间） */
.rp-edit { padding: 8px 18px; border-bottom: 1px solid var(--dt-border-light); flex: 1 1 auto; min-height: 280px; display: flex; flex-direction: column; overflow: hidden; }
.rp-sec-head { font-size: 13px; font-weight: 700; margin: 0 0 6px; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.rp-sec-head.admin { margin-top: 12px; }
.rp-edit-row { display: flex; gap: 12px; flex-shrink: 0; align-items: flex-end; }
.rp-tpl-col { width: 180px; }
.rp-title-col { flex: 1; }
.rp-lab { display: block; font-size: 11px; color: var(--dt-text-3); margin: 6px 0 2px; font-weight: 600; flex-shrink: 0; }
.rp-actions { display: flex; gap: 10px; margin-top: 8px; flex-shrink: 0; }
.rp-submitted-badge { font-size: 11px; background: #e8f9ef; color: #2fbb6b; padding: 2px 8px; border-radius: 20px; }
.rp-draft-badge { font-size: 11px; background: #fff3e0; color: #d46b08; padding: 2px 8px; border-radius: 20px; }

/* 发送给：接收人多选下拉 */
.rp-recv { margin-top: 4px; flex-shrink: 0; }
.rp-recv-box { position: relative; display: inline-block; }
.rp-recv-panel { position: absolute; z-index: 20; top: calc(100% + 4px); left: 0; min-width: 200px; max-height: 220px; overflow: auto; background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.12); padding: 6px; }
.rp-recv-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 13px; cursor: pointer; border-radius: 6px; }
.rp-recv-item:hover { background: #f6f8fb; }
.rp-recv-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.rp-tag { font-size: 12px; background: #eef4ff; color: var(--dt-primary); padding: 2px 8px; border-radius: 20px; }

/* 下：记录区（固定 ~220px 高，内部滚动，不抢编辑区空间） */
.rp-records { flex: 0 0 190px; min-height: 150px; overflow: auto; padding: 8px 18px; }
.rp-table-wrap { overflow: auto; border: 1px solid var(--dt-border-light); border-radius: 8px; margin-top: 8px; }
.rp-empty { color: var(--dt-text-4); text-align: center; padding: 24px 0; font-size: 13px; }
.rp-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; }
.rp-table th, .rp-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); white-space: nowrap; }
.rp-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.rp-row { cursor: pointer; }
.rp-row:hover { background: #f6f8fb; }
.rp-cell-title { font-weight: 600; }
.rp-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.rp-badge.ok { background: #e8f9ef; color: #2fbb6b; }
.rp-badge.warn { background: #f0f0f0; color: #888; }
.rp-table tbody tr.rp-miss { background: #fff1f0; }
.rp-table tbody tr.rp-miss td { color: #d92b3a; }
.rp-pager { display: flex; align-items: center; gap: 10px; margin: 8px 0 16px; font-size: 12px; color: var(--dt-text-3); }
.rp-tpl-list { margin-bottom: 8px; }
.rp-tpl-item { border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 8px 12px; margin-bottom: 8px; background: #fff; }
.rp-tpl-name { font-weight: 600; font-size: 13px; }
.rp-tpl-desc { font-weight: 400; color: var(--dt-text-4); }
.rp-tpl-sections { font-size: 12px; color: var(--dt-text-3); margin: 4px 0; }
.rp-tpl-ops { display: flex; gap: 8px; }
.rp-op { border: none; background: transparent; color: var(--dt-primary); font-size: 12px; cursor: pointer; padding: 2px 4px; }
.rp-op.danger { color: #d92b3a; }
.rp-range { display: flex; align-items: center; gap: 6px; font-weight: 400; }
.rp-modal { width: 560px; }
.rp-meta { font-size: 12px; color: var(--dt-text-3); margin-bottom: 8px; }
/* 富文本详情渲染 */
.rp-content { font-size: 13px; line-height: 1.6; word-break: break-word; }
.rp-content :deep(img) { max-width: 100%; border-radius: 6px; }
.rp-content :deep(video) { max-width: 100%; border-radius: 6px; }
.rp-content :deep(ul), .rp-content :deep(ol) { padding-left: 22px; }
.req { color: #e64545; font-style: normal; }
.rp-area { width: 100%; box-sizing: border-box; resize: vertical; }
.dt-btn.sm { padding: 3px 10px; font-size: 12px; }
.srv-input.sm { padding: 3px 6px; font-size: 12px; width: 130px; }
</style>
