<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'

// ── 类型（与服务端冻结协议对齐）──
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

// ── 顶部：日报/周报切换 ──
const type = ref<ReportType>('daily')
const periodLabel = computed(() => (type.value === 'daily' ? `今日 ${todayStr()}` : `本周 ${mondayStr()} ~ ${sundayStr()}`))

// ── 我的报表编辑区 ──
const current = ref<ReportItem | null>(null)
const title = ref('')
const contentTextarea = ref('')
const templateId = ref<number>(0)
const templates = ref<ReportTemplate[]>([])
const sectionContents = ref<string[]>([])
const saving = ref(false)
const submitting = ref(false)
const err = ref('')
const okMsg = ref('')
const submittedFlash = ref(false)

const activeTemplate = computed<ReportTemplate | null>(() => templates.value.find((t) => t.id === templateId.value) ?? null)
/** 是否按模板分块渲染多输入框 */
const useSections = computed(() => !!(activeTemplate.value && activeTemplate.value.sections && activeTemplate.value.sections.length))
/** 供模板 v-for 使用的分节列表（避免模板里写 activeTemplate!.sections） */
const sectionList = computed<string[]>(() => (useSections.value ? activeTemplate.value!.sections : []))

// 模板切换：初始化分块内容数组
watch(templateId, () => {
  const t = activeTemplate.value
  if (t && t.sections && t.sections.length) {
    sectionContents.value = t.sections.map((_, i) => sectionContents.value[i] ?? '')
  }
})

/** 保存时把分块内容组装成单字符串（标签 + 正文，用空行分隔） */
function assembleContent(): string {
  const t = activeTemplate.value
  if (t && t.sections && t.sections.length) {
    return t.sections.map((s, i) => `${s}\n${sectionContents.value[i] ?? ''}`).join('\n\n')
  }
  return contentTextarea.value
}
/** 加载已有报表时：按模板分块回填，否则整体填入普通输入框 */
function applyContentToSections(content: string): void {
  const t = activeTemplate.value
  if (!t || !t.sections || !t.sections.length) { contentTextarea.value = content; return }
  const arr = t.sections.map(() => '')
  if (content) {
    let cursor = 0
    t.sections.forEach((s, i) => {
      const marker = `${s}\n`
      const at = content.indexOf(marker, cursor)
      if (at >= 0) {
        const start = at + marker.length
        let next = content.length
        for (let j = i + 1; j < t.sections.length; j++) {
          const na = content.indexOf(`${t.sections[j]}\n`, start)
          if (na >= 0) { next = na; break }
        }
        arr[i] = content.slice(start, next).trim()
        cursor = next
      }
    })
  }
  sectionContents.value = arr
}

// ── 草稿缓存（照 ReqView 的 localStorage 写法）──
const DRAFT_KEY = 'mochi:oa:report:draft'
watch([title, contentTextarea, sectionContents, templateId, type], () => {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      type: type.value,
      title: title.value,
      contentTextarea: contentTextarea.value,
      sectionContents: sectionContents.value,
      templateId: templateId.value
    }))
  } catch (e) { console.error('[报表] 写草稿失败', e) }
}, { deep: true })
function clearDraft(): void { try { localStorage.removeItem(DRAFT_KEY) } catch (e) { console.error('[报表] 清草稿失败', e) } }
function restoreDraft(): void {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as {
      type?: ReportType; title?: string; contentTextarea?: string; sectionContents?: string[]; templateId?: number
    } | null
    if (d) {
      title.value = d.title ?? ''
      contentTextarea.value = d.contentTextarea ?? ''
      sectionContents.value = Array.isArray(d.sectionContents) ? d.sectionContents : []
      templateId.value = d.templateId ?? 0
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
    sectionContents.value = []
    // 等模板列表就绪后再按块回填
    applyContentToSections(rep?.content ?? '')
    if (!rep) restoreDraft() // 还没写过 → 恢复上次未提交草稿
    else clearDraft() // 已有服务端记录 → 以服务端为准，清掉草稿
  } catch (e) { console.error('[报表] 当前报表异常', e); err.value = '加载当前报表异常' }
}

// ── 保存（自动区分 create / update）──
async function doSave(): Promise<void> {
  if (!companyId.value) { err.value = '尚未加入公司'; return }
  const content = assembleContent()
  if (!content.trim() && !title.value.trim()) { err.value = '标题或内容不能为空'; return }
  saving.value = true
  err.value = ''
  okMsg.value = ''
  try {
    let ack
    if (current.value && current.value.id > 0) {
      ack = await window.pantry.serverReportUpdate({
        companyId: companyId.value, id: current.value.id,
        title: title.value.trim(), content,
        templateId: templateId.value > 0 ? templateId.value : null
      })
    } else {
      ack = await window.pantry.serverReportCreate({
        companyId: companyId.value, type: type.value, periodDate: periodDate(),
        title: title.value.trim(), content,
        templateId: templateId.value > 0 ? templateId.value : null
      })
    }
    if (!ack.ok) { console.error('[报表] 保存失败', ack.error); err.value = ack.error || '保存失败'; return }
    current.value = (ack.data as { report?: ReportItem })?.report ?? current.value
    okMsg.value = '已保存'
    clearDraft()
    await loadHistory()
  } catch (e) { console.error('[报表] 保存异常', e); err.value = '保存异常' }
  saving.value = false
}

// ── 提交 ──
async function doSubmit(): Promise<void> {
  if (!current.value || !current.value.id) { err.value = '请先保存再提交'; return }
  submitting.value = true
  err.value = ''
  okMsg.value = ''
  try {
    const ack = await window.pantry.serverReportSubmit(companyId.value, current.value.id)
    if (!ack.ok) { console.error('[报表] 提交失败', ack.error); err.value = ack.error || '提交失败'; return }
    current.value = (ack.data as { report?: ReportItem })?.report ?? current.value
    okMsg.value = '已提交'
    submittedFlash.value = true
    setTimeout(() => { submittedFlash.value = false }, 3000)
    await loadHistory()
  } catch (e) { console.error('[报表] 提交异常', e); err.value = '提交异常' }
  submitting.value = false
}

// ── 历史列表（我的提交，按类型筛选 + 分页）──
const history = ref<ReportItem[]>([])
const histPage = ref(1)
const histTotal = ref(0)
const pageSize = 10
const detail = ref<ReportItem | null>(null)
async function loadHistory(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverReportList({
      companyId: companyId.value, type: type.value,
      page: histPage.value, pageSize
    })
    if (!ack.ok) { console.error('[报表] 历史列表失败', ack.error); return }
    history.value = (ack.data as { reports?: ReportItem[]; total?: number })?.reports ?? []
    histTotal.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[报表] 历史列表异常', e) }
}
const histPages = computed(() => Math.max(1, Math.ceil(histTotal.value / pageSize)))
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
    // 若当前正用着被删模板，清掉选择
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
  await Promise.all([loadTemplates(), loadCurrent(), loadHistory(), loadStats()])
})

onMounted(async () => {
  offReminder = window.pantry.onReportReminder(onReminder)
  applyDefaultRange()
  await Promise.all([loadTemplates(), loadCurrent(), loadHistory(), loadStats()])
})
onUnmounted(() => { offReminder?.() })
</script>

<template>
  <div class="rp">
    <!-- 顶部：标题 + 日报/周报切换 + 周期 -->
    <div class="rp-bar">
      <span class="rp-title"><i class="fas fa-file-alt"></i> 报表</span>
      <div class="rp-seg">
        <button :class="{ on: type === 'daily' }" @click="type = 'daily'">日报</button>
        <button :class="{ on: type === 'weekly' }" @click="type = 'weekly'">周报</button>
      </div>
      <span class="rp-period">{{ periodLabel }}</span>
    </div>

    <!-- 到点提醒条 -->
    <div v-if="reminderBanner" class="rp-remind">
      <i class="fas fa-bell"></i>&nbsp;
      今日还有 {{ reminderBanner.n }} 人未交{{ reminderBanner.typeLabel }}
      <button class="rp-remind-x" @click="reminderBanner = null"><i class="fas fa-times"></i></button>
    </div>

    <div v-if="err" class="rp-err">{{ err }}</div>
    <div v-if="okMsg" class="rp-ok">{{ okMsg }}<i v-if="submittedFlash" class="fas fa-check-circle"></i> 已提交</div>

    <div class="rp-body">
      <!-- 左列：我的报表编辑 -->
      <div class="rp-edit">
        <div class="rp-sec-head">我的{{ type === 'daily' ? '日报' : '周报' }}
          <span v-if="current && current.submitted" class="rp-submitted-badge">已提交</span>
          <span v-else-if="current" class="rp-draft-badge">草稿</span>
        </div>

        <label class="rp-lab">模板</label>
        <select v-model.number="templateId" class="srv-select">
          <option :value="0">不使用模板</option>
          <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
        </select>

        <label class="rp-lab">标题</label>
        <input v-model="title" class="srv-input" :placeholder="type === 'daily' ? '日报标题（可留空）' : '周报标题（可留空）'" />

        <!-- 有模板分块 → 多个 textarea；否则单框 -->
        <template v-if="useSections">
          <div v-for="(sec, i) in sectionList" :key="i">
            <label class="rp-lab">{{ sec }}</label>
            <textarea v-model="sectionContents[i]" class="srv-input rp-area" rows="3" :placeholder="`${sec}内容`"></textarea>
          </div>
        </template>
        <template v-else>
          <label class="rp-lab">内容</label>
          <textarea v-model="contentTextarea" class="srv-input rp-area" rows="8" :placeholder="type === 'daily' ? '今天做了什么 / 遇到什么问题 / 明天计划…' : '本周总结 / 下周计划…'"></textarea>
        </template>

        <div class="rp-actions">
          <button class="dt-btn dt-btn-primary" :disabled="saving" @click="doSave">
            <i class="fas fa-save"></i> {{ saving ? '保存中…' : '保存' }}
          </button>
          <button class="dt-btn" :disabled="submitting || !current || current.submitted" @click="doSubmit">
            <i class="fas fa-paper-plane"></i> {{ submitting ? '提交中…' : '提交' }}
          </button>
        </div>
      </div>

      <!-- 右列：历史列表 + 管理区 -->
      <div class="rp-side">
        <!-- 历史 -->
        <div class="rp-sec-head">历史提交</div>
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

        <!-- 管理区（仅 owner/admin） -->
        <template v-if="isAdmin">
          <div class="rp-sec-head">模板管理
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

          <div class="rp-sec-head">未交统计
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
    </div>

    <!-- 详情弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal rp-modal">
        <div class="modal-head">{{ detail.title || `${detail.type === 'daily' ? '日报' : '周报'} · ${detail.periodDate}` }}</div>
        <div class="modal-body">
          <div class="rp-meta">周期：{{ detail.periodDate }}　提交时间：{{ fmtDateTime(detail.submittedAt) }}</div>
          <pre class="rp-content">{{ detail.content }}</pre>
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
.rp { height: 100%; display: flex; flex-direction: column; }
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
.rp-body { flex: 1; display: flex; gap: 16px; overflow: hidden; padding: 12px 18px; }
.rp-edit { width: 42%; overflow: auto; padding-right: 4px; }
.rp-side { flex: 1; overflow: auto; }
.rp-sec-head { font-size: 14px; font-weight: 700; margin: 6px 0 10px; display: flex; align-items: center; gap: 10px; }
.rp-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.rp-area { width: 100%; box-sizing: border-box; resize: vertical; }
.rp-actions { display: flex; gap: 10px; margin-top: 14px; }
.rp-submitted-badge { font-size: 11px; background: #e8f9ef; color: #2fbb6b; padding: 2px 8px; border-radius: 20px; }
.rp-draft-badge { font-size: 11px; background: #fff3e0; color: #d46b08; padding: 2px 8px; border-radius: 20px; }
.rp-table-wrap { overflow: auto; border: 1px solid var(--dt-border-light); border-radius: 8px; }
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
.rp-tpl-list { margin-bottom: 16px; }
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
.rp-content { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 13px; line-height: 1.6; background: #fafbfc; padding: 10px; border-radius: 8px; margin: 0; }
.req { color: #e64545; font-style: normal; }
.dt-btn.sm { padding: 3px 10px; font-size: 12px; }
.srv-input.sm { padding: 3px 6px; font-size: 12px; width: 130px; }
</style>
