<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useAppStore } from '../stores/app'
import DateTimeInput from './DateTimeInput.vue'
import { useServerStore } from '../stores/server'

const props = defineProps<{ projectId?: number }>()
const app = useAppStore()
const server = useServerStore()

type Req = { id: number; companyId: number; projectId: number | null; code: string; title: string; description: string; category: string; priority: string; status: string; handlerId: number | null; creatorId: number; startTime: string; dueTime: string; completedTime: string | null; linkedTaskIds: number[]; createdAt: string; updatedAt: string; handlerName?: string; creatorName?: string }

const STATUS: Record<string, string> = { planning: '待规划', in_progress: '进行中', done: '完成', closed: '已关闭' }
const PRIO: Record<string, string> = { nth: 'Nice To Have', middle: 'Middle', high: 'High' }
const CAT: Record<string, string> = { uncategorized: '未分类', product: '产品需求', tech: '技术需求' }

const list = ref<Req[]>([])
const err = ref('')
const loading = ref(false)

async function load(): Promise<void> {
  loading.value = true
  try { list.value = await app.fetchRequirements(props.projectId) } catch { err.value = '加载需求失败' }
  loading.value = false
}
watch(() => props.projectId, () => void load())
let offSync: (() => void) | null = null
function onSync(d: { companyId?: number; projectId?: number | null }): void {
  if (d.companyId && app.activeCompanyId && d.companyId !== app.activeCompanyId) return
  const pid = d.projectId ?? null
  if (props.projectId && pid && props.projectId !== pid) return
  void load()
}
onMounted(() => { void load(); offSync = window.pantry.onRequirementsUpdated(onSync) })
onUnmounted(() => { offSync?.() })

const meId = computed(() => server.state.userId ?? 0)
const isAdmin = computed(() => app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'owner' || app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'admin')
const canManage = (r: Req): boolean => isAdmin.value || r.handlerId === meId.value

const fmt = (s: string): string => { if (!s) return ''; const d = new Date(s); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

// ── 创建 ──
const showCreate = ref(false)
const cf = ref({ title: '', description: '', category: 'uncategorized', priority: 'middle', handlerId: 0, startTime: '', dueTime: '' })
const req = 'mochi:oa:req:create-draft'
// 草稿缓存：输入实时写本地；提交成功后清除
watch(
  cf,
  () => { if (showCreate.value) { try { localStorage.setItem(req, JSON.stringify(cf.value)) } catch { /* 忽略 */ } } },
  { deep: true }
)
// 打开创建弹窗时恢复上次未提交草稿
watch(showCreate, (v) => {
  if (!v) return
  try {
    const d = JSON.parse(localStorage.getItem(req) ?? 'null')
    if (d) cf.value = { ...cf.value, ...d }
  } catch { /* 忽略损坏草稿 */ }
})

async function submitCreate(): Promise<void> {
  const f = cf.value
  if (!f.title.trim()) { err.value = '标题不能为空'; return }
  if (!f.startTime || !f.dueTime) { err.value = '请填写开始与结束时间'; return }
  const r = await app.createRequirement({ projectId: props.projectId, title: f.title.trim(), description: f.description.trim(), category: f.category, priority: f.priority, handlerId: f.handlerId || undefined, startTime: f.startTime, dueTime: f.dueTime })
  if (!r.ok) { err.value = r.error || '创建失败'; return }
  try { localStorage.removeItem(req) } catch { /* 忽略 */ }
  showCreate.value = false
  cf.value = { title: '', description: '', category: 'uncategorized', priority: 'middle', handlerId: 0, startTime: '', dueTime: '' }
  await load()
}

// ── 状态流转 ──
const statusModal = ref<{ id: number; status: string } | null>(null)
async function submitStatus(): Promise<void> {
  const m = statusModal.value
  if (!m) return
  const r = await app.setRequirementStatus(m.id, m.status as 'planning' | 'in_progress' | 'done' | 'closed')
  statusModal.value = null
  if (!r.ok) { err.value = r.error || '流转失败'; return }
  await load()
}
async function onDelete(r: Req): Promise<void> {
  if (!confirm(`删除需求「${r.title}」？`)) return
  const res = await app.deleteRequirement(r.id)
  if (!res.ok) { err.value = res.error || '删除失败'; return }
  await load()
}
</script>

<template>
  <div class="pm">
    <div class="pm-bar">
      <span class="pm-title"><i class="fas fa-bullseye"></i> 需求</span>
      <button class="dt-btn dt-btn-primary" @click="showCreate = true"><i class="fas fa-plus"></i> 创建需求</button>
    </div>
    <div v-if="err" class="pm-err">{{ err }}</div>
    <div class="pm-table-wrap">
      <div v-if="!list.length" class="pm-empty">还没有需求，点击「创建需求」新建</div>
      <table v-else class="pm-table">
        <thead><tr><th>ID</th><th>标题</th><th>分类</th><th>优先级</th><th>状态</th><th>处理人</th><th>预计开始</th><th>预计结束</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in list" :key="r.id">
            <td class="pm-code">{{ r.code }}</td>
            <td class="pm-title-cell">{{ r.title }}<span v-if="r.linkedTaskIds.length" class="pm-link">关联{{ r.linkedTaskIds.length }}</span></td>
            <td><span class="pm-tag">{{ CAT[r.category] || r.category }}</span></td>
            <td><span class="pm-badge" :class="r.priority">{{ PRIO[r.priority] || r.priority }}</span></td>
            <td><span class="pm-badge" :class="r.status">{{ STATUS[r.status] || r.status }}</span></td>
            <td>{{ r.handlerName || '—' }}</td>
            <td>{{ fmt(r.startTime) }}</td>
            <td>{{ fmt(r.dueTime) }}</td>
            <td class="pm-ops">
              <button v-if="canManage(r) && r.status !== 'done' && r.status !== 'closed'" class="pm-op" @click="statusModal = { id: r.id, status: 'in_progress' }"><i class="fas fa-play"></i></button>
              <button v-if="canManage(r) && r.status !== 'done' && r.status !== 'closed'" class="pm-op" @click="statusModal = { id: r.id, status: 'done' }"><i class="fas fa-check"></i></button>
              <button v-if="isAdmin" class="pm-op danger" @click="onDelete(r)"><i class="fas fa-trash"></i></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal pm-modal">
        <div class="modal-head">创建需求</div>
        <div class="modal-body">
          <label class="pm-lab">标题 <i class="req">*</i></label>
          <input v-model="cf.title" class="srv-input" placeholder="需求标题" />
          <div class="pm-two">
            <div><label class="pm-lab">分类</label><select v-model="cf.category" class="srv-select"><option value="uncategorized">未分类</option><option value="product">产品需求</option><option value="tech">技术需求</option></select></div>
            <div><label class="pm-lab">优先级</label><select v-model="cf.priority" class="srv-select"><option value="nth">Nice To Have</option><option value="middle">Middle</option><option value="high">High</option></select></div>
          </div>
          <label class="pm-lab">处理人</label>
          <select v-model.number="cf.handlerId" class="srv-select"><option :value="0">不指派</option><option v-for="m in app.members" :key="m.userId" :value="m.userId">{{ m.nick || m.username }}</option></select>
          <div class="pm-two">
            <div><label class="pm-lab">预计开始 <i class="req">*</i></label><DateTimeInput v-model="cf.startTime" /></div>
            <div><label class="pm-lab">预计结束 <i class="req">*</i></label><DateTimeInput v-model="cf.dueTime" /></div>
          </div>
          <label class="pm-lab">描述</label>
          <textarea v-model="cf.description" class="srv-input" rows="3" placeholder="需求描述"></textarea>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showCreate = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitCreate">创建</button>
        </div>
      </div>
    </div>

    <div v-if="statusModal" class="modal-mask" @click.self="statusModal = null">
      <div class="modal pm-modal">
        <div class="modal-head">变更需求状态</div>
        <div class="modal-body">
          <select v-model="statusModal.status" class="srv-select">
            <option value="planning">待规划</option><option value="in_progress">进行中</option><option value="done">完成</option><option value="closed">已关闭</option>
          </select>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="statusModal = null">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitStatus">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm { height: 100%; display: flex; flex-direction: column; }
.pm-bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.pm-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.pm-err { padding: 8px 18px; color: #d92b3a; font-size: 13px; }
.pm-table-wrap { flex: 1; overflow: auto; padding: 12px 18px; }
.pm-empty { color: var(--dt-text-4); text-align: center; padding: 40px 0; font-size: 14px; }
.pm-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.pm-table th, .pm-table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--dt-border-light); white-space: nowrap; }
.pm-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.pm-table tbody tr:hover { background: #f6f8fb; }
.pm-code { color: var(--dt-text-4); font-size: 12px; }
.pm-title-cell { font-weight: 600; }
.pm-link { margin-left: 6px; font-size: 11px; color: var(--dt-primary); }
.pm-tag { font-size: 12px; color: var(--dt-text-3); }
.pm-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.pm-badge.nth { background: #f0f0f0; color: #666; }
.pm-badge.middle, .pm-badge.low { background: #e8f3ff; color: var(--dt-primary); }
.pm-badge.high, .pm-badge.critical { background: #ffe3e3; color: #d92b3a; }
.pm-badge.major { background: #fff3e0; color: #d46b08; }
.pm-badge.normal, .pm-badge.minor, .pm-badge.planning, .pm-badge.pending { background: #f0f0f0; color: #666; }
.pm-badge.in_progress, .pm-badge.processing { background: #e6f7ff; color: #1890ff; }
.pm-badge.done, .pm-badge.verified, .pm-badge.closed { background: #e8f9ef; color: #2fbb6b; }
.pm-ops { display: flex; gap: 4px; }
.pm-op { border: none; background: transparent; color: var(--dt-primary); font-size: 12px; cursor: pointer; padding: 3px 6px; border-radius: 6px; }
.pm-op:hover { background: #eef4ff; }
.pm-op.danger { color: #d92b3a; }
.pm-op.danger:hover { background: #ffe9e9; }
.pm-modal { width: 520px; }
.pm-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.pm-two { display: flex; gap: 10px; }
.pm-two > div { flex: 1; }
.req { color: #e64545; font-style: normal; }
</style>
