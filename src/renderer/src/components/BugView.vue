<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'

const props = defineProps<{ projectId?: number }>()
const app = useAppStore()
const server = useServerStore()

type Bug = { id: number; companyId: number; projectId: number | null; requirementId: number | null; code: string; title: string; description: string; severity: string; priority: string; status: string; handlerId: number | null; creatorId: number; foundVersion: string; createdAt: string; updatedAt: string; handlerName?: string; creatorName?: string }

const STATUS: Record<string, string> = { pending: '待处理', processing: '处理中', verified: '已验证', closed: '已关闭' }
const SEV: Record<string, string> = { minor: '轻微', normal: '一般', major: '严重', critical: '致命' }
const PRIO: Record<string, string> = { low: '低', middle: '中', high: '高' }

const list = ref<Bug[]>([])
const err = ref('')
async function load(): Promise<void> {
  try { list.value = await app.fetchBugs(props.projectId) } catch { err.value = '加载缺陷失败' }
}
watch(() => props.projectId, () => void load())
onMounted(load)

const meId = computed(() => server.state.userId ?? 0)
const isAdmin = computed(() => app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'owner' || app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'admin')
const canManage = (b: Bug): boolean => isAdmin.value || b.handlerId === meId.value
const fmtTime = (s: string): string => { if (!s) return ''; const d = new Date(s); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

const showCreate = ref(false)
const cf = ref({ title: '', description: '', severity: 'normal', priority: 'middle', handlerId: 0, foundVersion: '' })
async function submitCreate(): Promise<void> {
  const f = cf.value
  if (!f.title.trim()) { err.value = '标题不能为空'; return }
  const r = await app.createBug({ projectId: props.projectId, title: f.title.trim(), description: f.description.trim(), severity: f.severity, priority: f.priority, handlerId: f.handlerId || undefined, foundVersion: f.foundVersion.trim() })
  if (!r.ok) { err.value = r.error || '创建失败'; return }
  showCreate.value = false
  cf.value = { title: '', description: '', severity: 'normal', priority: 'middle', handlerId: 0, foundVersion: '' }
  await load()
}

const statusModal = ref<{ id: number; status: string } | null>(null)
async function submitStatus(): Promise<void> {
  const m = statusModal.value
  if (!m) return
  const r = await app.setBugStatus(m.id, m.status as 'pending' | 'processing' | 'verified' | 'closed')
  statusModal.value = null
  if (!r.ok) { err.value = r.error || '流转失败'; return }
  await load()
}
async function onDelete(b: Bug): Promise<void> {
  if (!confirm(`删除缺陷「${b.title}」？`)) return
  const res = await app.deleteBug(b.id)
  if (!res.ok) { err.value = res.error || '删除失败'; return }
  await load()
}
</script>

<template>
  <div class="pm">
    <div class="pm-bar">
      <span class="pm-title"><i class="fas fa-bug"></i> 缺陷</span>
      <button class="dt-btn dt-btn-primary" @click="showCreate = true"><i class="fas fa-plus"></i> 创建缺陷</button>
    </div>
    <div v-if="err" class="pm-err">{{ err }}</div>
    <div class="pm-table-wrap">
      <div v-if="!list.length" class="pm-empty">还没有缺陷，点击「创建缺陷」新建</div>
      <table v-else class="pm-table">
        <thead><tr><th>ID</th><th>标题</th><th>发现版本</th><th>严重程度</th><th>优先级</th><th>状态</th><th>处理人</th><th>创建人</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          <tr v-for="b in list" :key="b.id">
            <td class="pm-code">{{ b.code }}</td>
            <td class="pm-title-cell">{{ b.title }}<span v-if="b.description" class="pm-desc">{{ b.description }}</span></td>
            <td>{{ b.foundVersion || '—' }}</td>
            <td><span class="pm-badge" :class="b.severity">{{ SEV[b.severity] || b.severity }}</span></td>
            <td><span class="pm-badge" :class="b.priority">{{ PRIO[b.priority] || b.priority }}</span></td>
            <td><span class="pm-badge" :class="b.status">{{ STATUS[b.status] || b.status }}</span></td>
            <td>{{ b.handlerName || '—' }}</td>
            <td>{{ b.creatorName || '—' }}</td>
            <td class="pm-time">{{ fmtTime(b.createdAt) }}</td>
            <td class="pm-ops">
              <button v-if="canManage(b) && b.status !== 'closed' && b.status !== 'verified'" class="pm-op" @click="statusModal = { id: b.id, status: b.status === 'pending' ? 'processing' : 'verified' }"><i class="fas fa-play"></i></button>
              <button v-if="canManage(b) && b.status !== 'closed' && b.status !== 'verified'" class="pm-op" @click="statusModal = { id: b.id, status: 'closed' }"><i class="fas fa-check"></i></button>
              <button v-if="isAdmin" class="pm-op danger" @click="onDelete(b)"><i class="fas fa-trash"></i></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal pm-modal">
        <div class="modal-head">创建缺陷</div>
        <div class="modal-body">
          <label class="pm-lab">标题 <i class="req">*</i></label>
          <input v-model="cf.title" class="srv-input" placeholder="缺陷标题" />
          <div class="pm-two">
            <div><label class="pm-lab">严重程度</label><select v-model="cf.severity" class="srv-select"><option value="minor">轻微</option><option value="normal">一般</option><option value="major">严重</option><option value="critical">致命</option></select></div>
            <div><label class="pm-lab">优先级</label><select v-model="cf.priority" class="srv-select"><option value="low">低</option><option value="middle">中</option><option value="high">高</option></select></div>
          </div>
          <label class="pm-lab">发现版本</label>
          <input v-model="cf.foundVersion" class="srv-input" placeholder="如 0.9.4" />
          <label class="pm-lab">处理人</label>
          <select v-model.number="cf.handlerId" class="srv-select"><option :value="0">不指派</option><option v-for="m in app.members" :key="m.userId" :value="m.userId">{{ m.nick || m.username }}</option></select>
          <label class="pm-lab">描述</label>
          <textarea v-model="cf.description" class="srv-input" rows="3" placeholder="缺陷描述"></textarea>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showCreate = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitCreate">创建</button>
        </div>
      </div>
    </div>

    <div v-if="statusModal" class="modal-mask" @click.self="statusModal = null">
      <div class="modal pm-modal">
        <div class="modal-head">变更缺陷状态</div>
        <div class="modal-body">
          <select v-model="statusModal.status" class="srv-select">
            <option value="pending">待处理</option><option value="processing">处理中</option><option value="verified">已验证</option><option value="closed">已关闭</option>
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
.pm-desc { display: block; font-weight: 400; color: var(--dt-text-3); font-size: 12px; }
.pm-time { color: var(--dt-text-4); font-size: 12px; }
.pm-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.pm-badge.nth { background: #f0f0f0; color: #666; }
.pm-badge.low, .pm-badge.minor, .pm-badge.normal, .pm-badge.planning, .pm-badge.pending { background: #f0f0f0; color: #666; }
.pm-badge.middle { background: #e8f3ff; color: var(--dt-primary); }
.pm-badge.high { background: #ffe3e3; color: #d92b3a; }
.pm-badge.critical { background: #d92b3a; color: #fff; }
.pm-badge.major { background: #fff3e0; color: #d46b08; }
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
