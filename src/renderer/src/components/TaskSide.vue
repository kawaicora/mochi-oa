<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'

const app = useAppStore()
const server = useServerStore()

interface Project { id: number; companyId: number; name: string; pmId: number; createdAt: string }
interface Task { id: number; companyId: number; projectId: number | null; title: string; startTime: string; dueTime: string; status: string; isOverdue: boolean; reminderYellow: number; reminderRed: number }

const projects = ref<Project[]>([])
const tasks = ref<Task[]>([])
const meId = computed(() => server.state.userId ?? 0)

const overdueCount = computed(() => tasks.value.filter((t) => t.isOverdue || t.status === 'overdue').length)
const dueSoon = computed(() => {
  const now = Date.now()
  return tasks.value.filter((t) => !t.isOverdue && t.status !== 'completed' && t.status !== 'extended' && Date.parse(t.dueTime) - now < 3 * 86400000).length
})
const inProgress = computed(() => tasks.value.filter((t) => t.status === 'in_progress').length)
function projectCount(id: number): number {
  return tasks.value.filter((t) => t.projectId === id).length
}
function projectName(id: number): string {
  const p = projects.value.find((x) => x.id === id)
  return p ? p.name : ''
}
const fDay = (n: number): string => {
  const d = new Date(n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function projectRange(id: number): string {
  const arr = tasks.value.filter((t) => t.projectId === id)
  if (!arr.length) return ''
  const times = arr.map((t) => Date.parse(t.startTime) || Date.parse(t.dueTime)).filter((n) => Number.isFinite(n))
  if (!times.length) return ''
  return `${fDay(Math.min(...times))} ~ ${fDay(Math.max(...times))}`
}
function projectDone(id: number): number {
  return tasks.value.filter((t) => t.projectId === id && t.status === 'completed').length
}
function projectPct(id: number): number {
  const total = projectCount(id)
  if (!total) return 0
  return Math.round((projectDone(id) / total) * 100)
}

async function load(): Promise<void> {
  projects.value = await app.fetchProjects()
  tasks.value = await app.fetchTasks()
}

const showCreate = ref(false)
const projName = ref('')
const projErr = ref('')
async function submitCreate(): Promise<void> {
  if (!projName.value.trim()) { projErr.value = '项目名称不能为空'; return }
  const r = await app.createProject(projName.value.trim())
  if (!r.ok) { projErr.value = r.error || '创建失败'; return }
  showCreate.value = false
  projName.value = ''
  projErr.value = ''
  await load()
}
async function onDeleteProject(p: Project): Promise<void> {
  if (!confirm(`删除项目「${p.name}」？其下任务将保留为未归属。`)) return
  const r = await app.deleteProject(p.id)
  if (!r.ok) { projErr.value = r.error || '删除失败'; return }
  await load()
}

let offT: (() => void) | null = null
let offP: (() => void) | null = null
onMounted(async () => {
  await load()
  offT = window.pantry.onTasksUpdated(() => void load())
  offP = window.pantry.onProjectsUpdated(() => void load())
})
onUnmounted(() => { offT?.(); offP?.() })
</script>

<template>
  <section class="task-side">
    <div class="ts-head">
      <div class="ts-title"><i class="fas fa-tasks"></i> 任务系统</div>
    </div>

    <div class="ts-stat">
      <div class="ts-stat-item"><b class="red">{{ overdueCount }}</b><span>已超时</span></div>
      <div class="ts-stat-item"><b class="yellow">{{ dueSoon }}</b><span>3天内到期</span></div>
      <div class="ts-stat-item"><b class="blue">{{ inProgress }}</b><span>进行中</span></div>
    </div>

    <div class="ts-section">
      <div class="ts-sec-title"><i class="fas fa-folder"></i> 项目</div>
      <button class="ts-add" @click="showCreate = true"><i class="fas fa-plus"></i> 创建项目</button>
      <div v-if="!projects.length" class="ts-empty">暂无项目</div>
      <div v-for="p in projects" :key="p.id" class="ts-proj">
        <div class="ts-proj-info">
          <div class="ts-proj-name"><i class="fas fa-folder-open"></i> {{ p.name }}</div>
          <div class="ts-proj-meta">{{ projectRange(p.id) }}</div>
          <div class="ts-proj-progress"><div class="ts-proj-bar" :style="{ width: projectPct(p.id) + '%' }"></div></div>
          <div class="ts-proj-meta">{{ projectPct(p.id) }}% · {{ projectDone(p.id) }}/{{ projectCount(p.id) }}</div>
        </div>
        <button class="ts-del" title="删除项目" @click="onDeleteProject(p)"><i class="fas fa-trash"></i></button>
      </div>
    </div>

    <div class="ts-tip"><i class="far fa-lightbulb"></i> 右侧可新建任务、按项目筛选、跟进执行人</div>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal ts-modal">
        <div class="modal-head">创建项目</div>
        <div class="modal-body">
          <input v-model="projName" class="srv-input" placeholder="项目名称" @keydown.enter="submitCreate" />
          <div v-if="projErr" class="ts-err">{{ projErr }}</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showCreate = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitCreate">创建</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-side { width: 240px; flex-shrink: 0; height: 100%; display: flex; flex-direction: column; background: #fff; border-right: 1px solid var(--dt-border-light); overflow-y: auto; }
.ts-head { padding: 16px 14px; border-bottom: 1px solid var(--dt-border-light); }
.ts-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.ts-stat { display: flex; padding: 14px; gap: 8px; border-bottom: 1px solid var(--dt-border-light); }
.ts-stat-item { flex: 1; text-align: center; }
.ts-stat-item b { display: block; font-size: 22px; font-weight: 800; }
.ts-stat-item span { font-size: 11px; color: var(--dt-text-3); }
.ts-stat-item b.red { color: #e64545; }
.ts-stat-item b.yellow { color: #e6a23c; }
.ts-stat-item b.blue { color: var(--dt-primary); }
.ts-section { padding: 14px; border-bottom: 1px solid var(--dt-border-light); }
.ts-sec-title { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.ts-add { width: 100%; padding: 6px 0; border: 1px dashed var(--dt-border-strong); border-radius: 8px; background: #fafafa; color: var(--dt-text-2); font-size: 13px; cursor: pointer; margin-bottom: 8px; }
.ts-add:hover { color: var(--dt-primary); border-color: var(--dt-primary); }
.ts-empty { font-size: 13px; color: var(--dt-text-4); }
.ts-proj { display: flex; align-items: flex-start; justify-content: space-between; padding: 9px 10px; border-radius: 8px; cursor: default; border: 1px solid var(--dt-border-light); margin-bottom: 8px; }
.ts-proj:hover { background: #f6f8fb; border-color: var(--dt-border-strong); }
.ts-proj-progress { height: 6px; background: #eef0f3; border-radius: 3px; margin: 6px 0 4px; overflow: hidden; }
.ts-proj-bar { height: 100%; background: var(--dt-primary); border-radius: 3px; transition: width .3s; }
.ts-proj:hover { background: #f6f8fb; }
.ts-proj-name { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
.ts-proj-meta { font-size: 11px; color: var(--dt-text-4); margin-top: 2px; }
.ts-del { border: none; background: none; color: var(--dt-text-4); cursor: pointer; padding: 2px 5px; border-radius: 6px; }
.ts-del:hover { color: #d92b3a; background: #ffe9e9; }
.ts-tip { padding: 14px; font-size: 12px; color: var(--dt-text-4); display: flex; align-items: center; gap: 6px; }
.ts-err { color: #d92b3a; font-size: 12px; margin-top: 6px; }
.ts-modal { width: 360px; }
</style>
