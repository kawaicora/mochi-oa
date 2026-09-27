<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useAppStore } from '../stores/app'
import DateTimeInput from './DateTimeInput.vue'

const props = defineProps<{ projectId?: number }>()
const app = useAppStore()

type Plan = { id: number; companyId: number; projectId: number | null; name: string; description: string; startTime: string; dueTime: string; status: string; creatorId: number; createdAt: string; updatedAt: string }
const STATUS: Record<string, string> = { not_started: '未开始', in_progress: '进行中', done: '已完成', canceled: '已取消' }

const list = ref<Plan[]>([])
const err = ref('')
const view = ref<'list' | 'gantt'>('list')
async function load(): Promise<void> {
  try { list.value = await app.fetchPlans(props.projectId) } catch { err.value = '加载计划失败' }
}
watch(() => props.projectId, () => void load())
let offSync: (() => void) | null = null
function onSync(d: { companyId?: number; projectId?: number | null }): void {
  if (d.companyId && app.activeCompanyId && d.companyId !== app.activeCompanyId) return
  const pid = d.projectId ?? null
  if (props.projectId && pid && props.projectId !== pid) return
  void load()
}
onMounted(() => { void load(); offSync = window.pantry.onPlansUpdated(onSync) })
onUnmounted(() => { offSync?.() })

const isAdmin = computed(() => app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'owner' || app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'admin')
const fmt = (s: string): string => { if (!s) return ''; const d = new Date(s); return `${d.getMonth() + 1}.${d.getDate()}` }

const showCreate = ref(false)
const cf = ref({ name: '', description: '', startTime: '', dueTime: '' })
const plan = 'mochi:oa:plan:create-draft'
// 草稿缓存：输入实时写本地；提交成功后清除
watch(
  cf,
  () => { if (showCreate.value) { try { localStorage.setItem(plan, JSON.stringify(cf.value)) } catch { /* 忽略 */ } } },
  { deep: true }
)
// 打开创建弹窗时恢复上次未提交草稿
watch(showCreate, (v) => {
  if (!v) return
  try {
    const d = JSON.parse(localStorage.getItem(plan) ?? 'null')
    if (d) cf.value = { ...cf.value, ...d }
  } catch { /* 忽略损坏草稿 */ }
})

async function submitCreate(): Promise<void> {
  const f = cf.value
  if (!f.name.trim()) { err.value = '计划名称不能为空'; return }
  if (!f.startTime || !f.dueTime) { err.value = '请填写开始与结束时间'; return }
  const r = await app.createPlan({ projectId: props.projectId, name: f.name.trim(), description: f.description.trim(), startTime: f.startTime, dueTime: f.dueTime })
  if (!r.ok) { err.value = r.error || '创建失败'; return }
  try { localStorage.removeItem(plan) } catch { /* 忽略 */ }
  showCreate.value = false
  cf.value = { name: '', description: '', startTime: '', dueTime: '' }
  await load()
}
async function setStatus(p: Plan, status: string): Promise<void> {
  const r = await app.updatePlan({ id: p.id, status })
  if (!r.ok) { err.value = r.error || '更新失败'; return }
  await load()
}
async function onDelete(p: Plan): Promise<void> {
  if (!confirm(`删除计划「${p.name}」？`)) return
  const res = await app.deletePlan(p.id)
  if (!res.ok) { err.value = res.error || '删除失败'; return }
  await load()
}

// 甘特图
const gantt = computed(() => {
  if (!list.value.length) return null
  let min = Infinity, max = -Infinity
  for (const p of list.value) {
    const s = Date.parse(p.startTime), e = Date.parse(p.dueTime)
    if (Number.isFinite(s) && s < min) min = s
    if (Number.isFinite(e) && e > max) max = e
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  const start = new Date(min); start.setHours(0, 0, 0, 0)
  const cursor = new Date(start); cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7))
  const weeks: Array<{ s: Date; e: Date }> = []
  while (cursor <= new Date(max)) { const ws = new Date(cursor); const we = new Date(cursor); we.setDate(we.getDate() + 6); weeks.push({ s: ws, e: we }); cursor.setDate(cursor.getDate() + 7) }
  if (!weeks.length) return null
  const t0 = weeks[0].s.getTime(), t1 = weeks[weeks.length - 1].e.getTime() + 86400000, total = t1 - t0
  const rows = list.value.map((p) => {
    const s = Math.max(Date.parse(p.startTime), t0), e = Math.min(Date.parse(p.dueTime), t1)
    return { p, left: ((s - t0) / total) * 100, width: Math.max(((e - s) / total) * 100, 2) }
  }).sort((a, b) => Date.parse(a.p.startTime) - Date.parse(b.p.startTime))
  return { weeks, rows }
})
const wl = (w: { s: Date; e: Date }): string => `${w.s.getMonth() + 1}.${w.s.getDate()} - ${w.e.getMonth() + 1}.${w.e.getDate()}`
</script>

<template>
  <div class="pm">
    <div class="pm-bar">
      <span class="pm-title"><i class="fas fa-calendar-check"></i> 计划</span>
      <div class="pm-right">
        <div class="pm-views">
          <button :class="{ on: view === 'list' }" @click="view = 'list'"><i class="fas fa-list"></i> 列表</button>
          <button :class="{ on: view === 'gantt' }" @click="view = 'gantt'"><i class="fas fa-chart-bar"></i> 甘特图</button>
        </div>
        <button v-if="isAdmin" class="dt-btn dt-btn-primary" @click="showCreate = true"><i class="fas fa-plus"></i> 创建计划</button>
      </div>
    </div>
    <div v-if="err" class="pm-err">{{ err }}</div>

    <div v-if="view === 'list'" class="pm-table-wrap">
      <div v-if="!list.length" class="pm-empty">还没有计划，点击「创建计划」新建</div>
      <table v-else class="pm-table">
        <thead><tr><th>名称</th><th>描述</th><th>开始</th><th>结束</th><th>状态</th><th></th></tr></thead>
        <tbody>
          <tr v-for="p in list" :key="p.id">
            <td class="pm-title-cell">{{ p.name }}</td>
            <td class="pm-desc-cell">{{ p.description }}</td>
            <td>{{ fmt(p.startTime) }}</td>
            <td>{{ fmt(p.dueTime) }}</td>
            <td><select class="srv-select pm-status" :value="p.status" @change="setStatus(p, ($event.target as HTMLSelectElement).value)">
              <option value="not_started">未开始</option><option value="in_progress">进行中</option><option value="done">已完成</option><option value="canceled">已取消</option>
            </select></td>
            <td class="pm-ops"><button v-if="isAdmin" class="pm-op danger" @click="onDelete(p)"><i class="fas fa-trash"></i></button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="view === 'gantt'" class="pm-gantt">
      <div v-if="!gantt" class="pm-empty">没有可绘制的时间范围</div>
      <template v-else>
        <div class="pmg-head"><div class="pmg-label"></div><div class="pmg-axis"><div v-for="w in gantt.weeks" :key="w.s.getTime()" class="pmg-week">{{ wl(w) }}</div></div></div>
        <div v-for="r in gantt.rows" :key="r.p.id" class="pmg-row">
          <div class="pmg-label">{{ r.p.name }}</div>
          <div class="pmg-track"><div class="pmg-bar" :class="r.p.status" :style="{ left: r.left + '%', width: r.width + '%' }"></div></div>
        </div>
      </template>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal pm-modal">
        <div class="modal-head">创建计划</div>
        <div class="modal-body">
          <label class="pm-lab">计划名称 <i class="req">*</i></label>
          <input v-model="cf.name" class="srv-input" placeholder="计划名称" />
          <div class="pm-two">
            <div><label class="pm-lab">开始 <i class="req">*</i></label><DateTimeInput v-model="cf.startTime" /></div>
            <div><label class="pm-lab">结束 <i class="req">*</i></label><DateTimeInput v-model="cf.dueTime" /></div>
          </div>
          <label class="pm-lab">描述</label>
          <textarea v-model="cf.description" class="srv-input" rows="3" placeholder="计划描述"></textarea>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showCreate = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitCreate">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pm { height: 100%; display: flex; flex-direction: column; }
.pm-bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.pm-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.pm-right { display: flex; align-items: center; gap: 12px; }
.pm-views { display: flex; border: 1px solid var(--dt-border-light); border-radius: 8px; overflow: hidden; }
.pm-views button { border: none; background: #fff; padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--dt-text-3); }
.pm-views button.on { background: var(--dt-primary); color: #fff; }
.pm-err { padding: 8px 18px; color: #d92b3a; font-size: 13px; }
.pm-table-wrap { flex: 1; overflow: auto; padding: 12px 18px; }
.pm-empty { color: var(--dt-text-4); text-align: center; padding: 40px 0; font-size: 14px; }
.pm-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.pm-table th, .pm-table td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--dt-border-light); white-space: nowrap; }
.pm-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.pm-table tbody tr:hover { background: #f6f8fb; }
.pm-title-cell { font-weight: 600; }
.pm-desc-cell { color: var(--dt-text-3); max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.pm-status { padding: 2px 6px; font-size: 12px; }
.pm-ops { display: flex; gap: 4px; }
.pm-op { border: none; background: transparent; font-size: 12px; cursor: pointer; padding: 3px 6px; border-radius: 6px; }
.pm-op.danger { color: #d92b3a; }
.pm-op.danger:hover { background: #ffe9e9; }
.pm-gantt { flex: 1; overflow: auto; padding: 12px 18px; }
.pmg-head, .pmg-row { display: flex; align-items: center; }
.pmg-label { width: 220px; flex-shrink: 0; }
.pmg-axis { flex: 1; display: flex; border-bottom: 1px solid var(--dt-border-light); }
.pmg-week { flex: 1; min-width: 96px; font-size: 11px; color: var(--dt-text-4); padding: 6px 8px; border-right: 1px solid var(--dt-border-light); white-space: nowrap; }
.pmg-row { border-bottom: 1px solid var(--dt-border-light); }
.pmg-label { width: 220px; flex-shrink: 0; font-size: 13px; font-weight: 600; padding: 10px 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pmg-track { flex: 1; position: relative; height: 40px; }
.pmg-bar { position: absolute; top: 12px; height: 16px; border-radius: 4px; min-width: 4px; }
.pmg-bar.not_started { background: rgba(144, 147, 153, 0.7); }
.pmg-bar.in_progress { background: rgba(56, 132, 255, 0.75); }
.pmg-bar.done { background: rgba(47, 187, 107, 0.75); }
.pmg-bar.canceled { background: rgba(200, 200, 200, 0.6); }
.pm-modal { width: 520px; }
.pm-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.pm-two { display: flex; gap: 10px; }
.pm-two > div { flex: 1; }
.req { color: #e64545; font-style: normal; }
</style>
