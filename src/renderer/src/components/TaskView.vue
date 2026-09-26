<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'

const app = useAppStore()
const server = useServerStore()

type TaskStatus = 'created' | 'in_progress' | 'completed' | 'pending_extension' | 'extended' | 'overdue'
interface Project { id: number; companyId: number; name: string; pmId: number; createdAt: string }
interface Assignment { id: number; taskId: number; userId: number; content: string; status: 'created' | 'in_progress' | 'completed'; completedAt: string | null; username?: string; nick?: string; avatar?: string }
interface Comment { id: number; taskId: number; userId: number; content: string; createdAt: string; username?: string; nick?: string }
interface Issue { id: number; taskId: number; userId: number; title: string; content: string; status: 'open' | 'resolved'; createdAt: string; username?: string; nick?: string }
interface Extension { id: number; taskId: number; userId: number; requestedDueTime: string; reason: string; status: 'pending' | 'approved' | 'rejected'; decidedBy: number | null; decidedAt: string | null; createdAt: string; username?: string; nick?: string }
interface Log { id: number; taskId: number; userId: number; fromStatus: string; toStatus: string; note: string; createdAt: string; username?: string; nick?: string }
interface Task { id: number; companyId: number; projectId: number | null; title: string; description: string; startTime: string; dueTime: string; completedTime: string | null; status: TaskStatus; isOverdue: boolean; reminderYellow: number; reminderRed: number; images: string[]; createdBy: number; createdAt: string; updatedAt: string }
interface Detail { task: Task; assignments: Assignment[]; comments: Comment[]; issues: Issue[]; extensions: Extension[]; logs: Log[] }

const projects = ref<Project[]>([])
const tasks = ref<Task[]>([])
const activeProject = ref(0)
const loading = ref(false)
const err = ref('')

// 详情
const detail = ref<Detail | null>(null)
const detailTab = ref<'activity' | 'comments' | 'issues' | 'assign'>('activity')

const meId = computed(() => server.state.userId ?? 0)

// ─── 颜色：绿/黄/红（剩余天数 + 提醒阈值） ───
function colorOf(t: Task): 'green' | 'yellow' | 'red' {
  if (t.isOverdue || t.status === 'overdue') return 'red'
  const due = Date.parse(t.dueTime)
  const now = Date.now()
  const days = (due - now) / 86400000
  if (due <= now) return 'red'
  if (days <= t.reminderRed) return 'red'
  if (days <= t.reminderYellow) return 'yellow'
  return 'green'
}
function remainText(t: Task): string {
  const due = Date.parse(t.dueTime)
  const diff = due - Date.now()
  if (t.isOverdue || t.status === 'overdue' || diff <= 0) {
    const h = Math.ceil(-diff / 3600000)
    return h < 24 ? `已超时 ${h} 小时` : `已超时 ${Math.ceil(h / 24)} 天`
  }
  const d = diff / 86400000
  if (d < 1) return `剩 ${Math.ceil(diff / 3600000)} 小时`
  return `剩 ${Math.ceil(d)} 天`
}
const fmt = (s: string): string => {
  if (!s) return ''
  const d = new Date(s)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const who = (u?: string, n?: string): string => n || u || ''

const STATUS_LABEL: Record<string, string> = {
  created: '已创建', in_progress: '正在进行', completed: '已完成',
  pending_extension: '申请延期', extended: '已延期', overdue: '已超时'
}

// ─── 加载 ───
async function loadProjects(): Promise<void> {
  try { projects.value = await app.fetchProjects() } catch { projects.value = [] }
}
async function loadTasks(): Promise<void> {
  loading.value = true
  try { tasks.value = await app.fetchTasks(activeProject.value || undefined) } catch { err.value = '加载任务失败' }
  loading.value = false
}
async function refresh(): Promise<void> {
  await loadProjects()
  await loadTasks()
  if (detail.value) {
    const dd = await app.fetchTaskDetail(detail.value.task.id)
    if (dd) detail.value = dd
  }
}

// ─── 创建任务 ───
const showCreate = ref(false)
const createForm = ref({ title: '', description: '', projectId: 0 as number, startTime: '', dueTime: '' })
const createImages = ref<string[]>([])
const createAssign = ref<Array<{ userId: number; content: string }>>([{ userId: 0, content: '' }])
const createErr = ref('')
const members = computed(() => app.members ?? [])
function openCreate(): void {
  createErr.value = ''
  createForm.value = { title: '', description: '', projectId: activeProject.value, startTime: '', dueTime: '' }
  createImages.value = []
  createAssign.value = [{ userId: 0, content: '' }]
  showCreate.value = true
}
async function onAddImage(): Promise<void> {
  const path = await window.pantry.pickFile('image')
  if (!path) return
  const clientId = `task-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const up = await window.pantry.serverUploadChunked(path, clientId, app.activeCompanyId ?? 0)
  if (up.ok && up.url) createImages.value.push(up.url)
  else err.value = up.error || '图片上传失败'
}
function removeCreateImage(i: number): void { createImages.value.splice(i, 1) }
function toIso(lt: string): string {
  if (!lt) return ''
  const d = new Date(lt)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}
async function submitCreate(): Promise<void> {
  const f = createForm.value
  if (!f.title.trim()) { createErr.value = '任务名称不能为空'; return }
  const st = toIso(f.startTime), dt = toIso(f.dueTime)
  if (!st || !dt) { createErr.value = '请填写开始与预期结束时间'; return }
  if (Date.parse(dt) < Date.parse(st)) { createErr.value = '结束时间不能早于开始时间'; return }
  const assigns = createAssign.value.filter((a) => a.userId > 0).map((a) => ({ userId: a.userId, content: a.content.trim() }))
  const r = await app.createTask({ projectId: f.projectId || undefined, title: f.title.trim(), description: f.description.trim(), startTime: st, dueTime: dt, images: createImages.value, assignments: assigns })
  if (!r.ok) { createErr.value = r.error || '创建失败'; return }
  showCreate.value = false
  await loadTasks()
}

// ─── 删除任务 ───
async function onDelete(task: Task): Promise<void> {
  if (!confirm(`删除任务「${task.title}」？`)) return
  const r = await app.deleteTask(task.id)
  if (!r.ok) { err.value = r.error || '删除失败'; return }
  if (detail.value?.task.id === task.id) detail.value = null
  await loadTasks()
}

// ─── 详情 ───
async function openTask(task: Task): Promise<void> {
  const dd = await app.fetchTaskDetail(task.id)
  if (dd) { detail.value = dd; detailTab.value = 'activity' }
}
function closeDetail(): void { detail.value = null }

// 状态变更
const statusModal = ref<{ taskId: number; status: TaskStatus; note: string } | null>(null)
function askStatus(t: Task, status: TaskStatus): void { statusModal.value = { taskId: t.id, status, note: '' } }
async function submitStatus(): Promise<void> {
  const m = statusModal.value
  if (!m) return
  if (m.status === 'completed' && !m.note.trim()) { err.value = '完成任务需填写说明'; return }
  const r = await app.setTaskStatus(m.taskId, m.status, m.note.trim())
  statusModal.value = null
  if (!r.ok) { err.value = r.error || '状态变更失败'; return }
  await refresh()
}

// 延期
const extModal = ref<{ taskId: number; requestedDueTime: string; reason: string } | null>(null)
function askExtend(t: Task): void { extModal.value = { taskId: t.id, requestedDueTime: t.dueTime.slice(0, 16), reason: '' } }
async function submitExtend(): Promise<void> {
  const m = extModal.value
  if (!m) return
  const dt = toIso(m.requestedDueTime)
  if (!dt || !m.reason.trim()) { err.value = '请填写新截止时间与原因'; return }
  const r = await app.requestExtension(m.taskId, dt, m.reason.trim())
  extModal.value = null
  if (!r.ok) { err.value = r.error || '申请失败'; return }
  await refresh()
}
async function decideExt(ext: Extension, approved: boolean): Promise<void> {
  const t = detail.value?.task
  if (!t) return
  const r = await app.decideExtension(t.id, ext.id, approved)
  if (!r.ok) { err.value = r.error || '审批失败'; return }
  await refresh()
}

// 提醒
const remindModal = ref<{ taskId: number; reminderYellow: number; reminderRed: number } | null>(null)
function askRemind(t: Task): void { remindModal.value = { taskId: t.id, reminderYellow: t.reminderYellow, reminderRed: t.reminderRed } }
async function submitRemind(): Promise<void> {
  const m = remindModal.value
  if (!m) return
  const r = await app.setTaskReminder(m.taskId, m.reminderYellow, m.reminderRed)
  remindModal.value = null
  if (!r.ok) { err.value = r.error || '设置失败'; return }
  await refresh()
}

// 留言
const commentText = ref('')
async function addComment(): Promise<void> {
  if (!detail.value || !commentText.value.trim()) return
  const r = await app.addTaskComment(detail.value.task.id, commentText.value.trim())
  commentText.value = ''
  if (r.ok) await refresh()
}

// QA
const issueOpen = ref(false)
const issueForm = ref({ title: '', content: '' })
async function addIssue(): Promise<void> {
  if (!detail.value || !issueForm.value.title.trim()) return
  const r = await app.addTaskIssue(detail.value.task.id, issueForm.value.title.trim(), issueForm.value.content.trim())
  issueOpen.value = false
  issueForm.value = { title: '', content: '' }
  if (r.ok) await refresh()
}
async function resolveIssue(it: Issue): Promise<void> {
  const r = await app.resolveTaskIssue(it.id)
  if (r.ok) await refresh()
}

// 分配
const assignOpen = ref(false)
const assignForm = ref({ userId: 0, content: '' })
async function addAssignment(): Promise<void> {
  if (!detail.value || !assignForm.value.userId) return
  const r = await app.addAssignment(detail.value.task.id, assignForm.value.userId, assignForm.value.content.trim())
  assignOpen.value = false
  assignForm.value = { userId: 0, content: '' }
  if (r.ok) await refresh()
}
async function removeAssign(a: Assignment): Promise<void> {
  const r = await app.removeAssignment(a.id)
  if (r.ok) await refresh()
}
async function setAssignStatus(a: Assignment, status: 'created' | 'in_progress' | 'completed'): Promise<void> {
  const r = await app.setAssignmentStatus(a.id, status)
  if (r.ok) await refresh()
}

// 事件订阅 + 提醒
const reminded = new Set<string>()
function checkReminders(): void {
  const now = Date.now()
  for (const t of tasks.value) {
    if (t.status === 'completed' || t.status === 'extended') continue
    const due = Date.parse(t.dueTime)
    let level = ''
    if (t.isOverdue || due <= now) level = 'overdue'
    else {
      const days = (due - now) / 86400000
      if (days <= t.reminderRed) level = 'red'
      else if (days <= t.reminderYellow) level = 'yellow'
    }
    if (!level) continue
    const key = `${t.id}:${level}`
    if (reminded.has(key)) continue
    reminded.add(key)
    const body = level === 'overdue'
      ? `「${t.title}」已超时！${remainText(t)}`
      : `「${t.title}」${level === 'red' ? '红色警告' : '黄色提醒'}，${remainText(t)}`
    void window.pantry.notify({ title: '任务提醒', body, target: undefined })
  }
}
let remindTimer: number | null = null
let offT: (() => void) | null = null
let offP: (() => void) | null = null
onMounted(async () => {
  await refresh()
  checkReminders()
  remindTimer = window.setInterval(() => { void loadTasks(); checkReminders() }, 60000)
  offT = window.pantry.onTasksUpdated(() => void loadTasks())
  offP = window.pantry.onProjectsUpdated(() => void loadProjects())
})
onUnmounted(() => {
  if (remindTimer !== null) window.clearInterval(remindTimer)
  offT?.(); offP?.()
})

const myRole = computed(() => app.companies.find((c) => c.company.id === app.activeCompanyId)?.role)
const isManager = (t: Task): boolean => {
  const role = myRole.value
  return role === 'owner' || role === 'admin' || t.createdBy === meId.value
}
</script>

<template>
  <div class="task-view">
    <div class="tv-head">
      <div class="tv-title"><i class="fas fa-tasks"></i> 任务流程</div>
      <div class="tv-actions">
        <button class="dt-btn dt-btn-primary" @click="openCreate"><i class="fas fa-plus"></i> 新建任务</button>
      </div>
    </div>

    <div v-if="err" class="tv-err">{{ err }}</div>

    <!-- 项目筛选 -->
    <div class="tv-projects">
      <button class="tv-proj" :class="{ on: activeProject === 0 }" @click="activeProject = 0; loadTasks()">全部</button>
      <button v-for="p in projects" :key="p.id" class="tv-proj" :class="{ on: activeProject === p.id }" @click="activeProject = p.id; loadTasks()">
        <i class="fas fa-folder"></i> {{ p.name }}
      </button>
    </div>

    <!-- 任务列表 -->
    <div class="tv-list">
      <div v-if="!tasks.length" class="tv-empty"><i class="far fa-clipboard"></i> 还没有任务，点击「新建任务」创建</div>
      <div v-for="t in tasks" :key="t.id" class="tv-card" :class="`lvl-${colorOf(t)}`" @click="openTask(t)">
        <div class="tv-card-bar"></div>
        <div class="tv-card-main">
          <div class="tv-card-top">
            <span class="tv-card-title">{{ t.title }}</span>
            <span class="tv-badge" :class="t.status">{{ STATUS_LABEL[t.status] }}</span>
          </div>
          <div v-if="t.description" class="tv-card-desc">{{ t.description }}</div>
          <div class="tv-card-meta">
            <span class="tv-remain" :class="colorOf(t)"><i class="far fa-clock"></i> {{ remainText(t) }}</span>
            <span><i class="far fa-calendar-alt"></i> {{ fmt(t.startTime) }} → {{ fmt(t.dueTime) }}</span>
          </div>
          <div class="tv-card-ops">
            <button class="tv-op" @click.stop="askStatus(t, 'in_progress')"><i class="fas fa-play"></i> 开始</button>
            <button class="tv-op" @click.stop="askStatus(t, 'completed')"><i class="fas fa-check"></i> 完成</button>
            <button class="tv-op" @click.stop="askExtend(t)"><i class="fas fa-hourglass-half"></i> 延期</button>
            <button v-if="isManager(t)" class="tv-op danger" @click.stop="onDelete(t)"><i class="fas fa-trash"></i> 删除</button>
          </div>
        </div>
      </div>
    </div>

    <!-- 详情面板 -->
    <div v-if="detail" class="tv-detail">
      <div class="tv-detail-head">
        <div class="tv-detail-title">
          <span class="tv-badge" :class="detail.task.status">{{ STATUS_LABEL[detail.task.status] }}</span>
          {{ detail.task.title }}
        </div>
        <button class="tv-op" @click="closeDetail"><i class="fas fa-times"></i></button>
      </div>
      <div class="tv-detail-body">
        <div class="tv-detail-info">
          <div class="tv-di-row"><span>开始</span><b>{{ fmt(detail.task.startTime) }}</b></div>
          <div class="tv-di-row"><span>预期结束</span><b :class="colorOf(detail.task)">{{ fmt(detail.task.dueTime) }}</b></div>
          <div class="tv-di-row"><span>剩余</span><b :class="colorOf(detail.task)">{{ remainText(detail.task) }}</b></div>
          <div class="tv-di-row"><span>提醒</span><b>黄≤{{ detail.task.reminderYellow }}天 / 红≤{{ detail.task.reminderRed }}天</b></div>
          <div class="tv-di-actions">
            <button class="dt-btn" @click="askStatus(detail.task, 'in_progress')">开始进行</button>
            <button class="dt-btn" @click="askStatus(detail.task, 'completed')">完成</button>
            <button class="dt-btn" @click="askExtend(detail.task)">申请延期</button>
            <button class="dt-btn" @click="askRemind(detail.task)">提醒设置</button>
          </div>
          <div v-if="detail.task.images.length" class="tv-images">
            <a v-for="(im, i) in detail.task.images" :key="i" :href="im" target="_blank"><img :src="im" alt="任务图片" /></a>
          </div>
        </div>

        <div class="tv-tabs">
          <button :class="{ on: detailTab === 'activity' }" @click="detailTab = 'activity'">动态</button>
          <button :class="{ on: detailTab === 'comments' }" @click="detailTab = 'comments'">留言 {{ detail.comments.length }}</button>
          <button :class="{ on: detailTab === 'issues' }" @click="detailTab = 'issues'">问题 {{ detail.issues.length }}</button>
          <button :class="{ on: detailTab === 'assign' }" @click="detailTab = 'assign'">执行人 {{ detail.assignments.length }}</button>
        </div>

        <!-- 动态：状态日志 + 延期 -->
        <div v-if="detailTab === 'activity'" class="tv-tab">
          <div v-for="l in detail.logs" :key="l.id" class="tv-log">
            <span class="tv-log-time">{{ fmt(l.createdAt) }}</span>
            <span class="tv-log-user">{{ who(l.username, l.nick) }}</span>
            <span class="tv-log-status">{{ STATUS_LABEL[l.fromStatus] || '创建' }} → {{ STATUS_LABEL[l.toStatus] }}</span>
            <span v-if="l.note" class="tv-log-note">{{ l.note }}</span>
          </div>
          <div v-if="detail.extensions.length" class="tv-ext-list">
            <div v-for="e in detail.extensions" :key="e.id" class="tv-ext">
              <span class="tv-log-user">{{ who(e.username, e.nick) }}</span> 申请延期至 <b>{{ fmt(e.requestedDueTime) }}</b>：{{ e.reason }}
              <span v-if="e.status === 'pending'" class="tv-ext-pending">
                <button class="tv-op" @click="decideExt(e, true)">通过</button>
                <button class="tv-op" @click="decideExt(e, false)">拒绝</button>
              </span>
              <span v-else class="tv-ext-state" :class="e.status">{{ e.status === 'approved' ? '已通过' : '已拒绝' }}</span>
            </div>
          </div>
        </div>

        <!-- 留言 -->
        <div v-if="detailTab === 'comments'" class="tv-tab">
          <div class="tv-comment-box">
            <textarea v-model="commentText" class="srv-input" rows="2" placeholder="输入留言…" @keydown.ctrl.enter="addComment"></textarea>
            <button class="dt-btn dt-btn-primary" @click="addComment">发送</button>
          </div>
          <div v-for="c in [...detail.comments].reverse()" :key="c.id" class="tv-comment">
            <span class="tv-log-user">{{ who(c.username, c.nick) }}</span>
            <span class="tv-log-time">{{ fmt(c.createdAt) }}</span>
            <div class="tv-comment-text">{{ c.content }}</div>
          </div>
        </div>

        <!-- QA -->
        <div v-if="detailTab === 'issues'" class="tv-tab">
          <button class="dt-btn" @click="issueOpen = !issueOpen"><i class="fas fa-plus"></i> 发布问题</button>
          <div v-if="issueOpen" class="tv-issue-form">
            <input v-model="issueForm.title" class="srv-input" placeholder="问题标题" />
            <textarea v-model="issueForm.content" class="srv-input" rows="2" placeholder="问题描述"></textarea>
            <button class="dt-btn dt-btn-primary" @click="addIssue">发布</button>
          </div>
          <div v-for="it in detail.issues" :key="it.id" class="tv-issue" :class="it.status">
            <div class="tv-issue-head">
              <b>{{ it.title }}</b>
              <span class="tv-badge" :class="it.status">{{ it.status === 'open' ? '待解决' : '已解决' }}</span>
            </div>
            <div v-if="it.content" class="tv-issue-text">{{ it.content }}</div>
            <div class="tv-issue-foot">
              <span class="tv-log-user">{{ who(it.username, it.nick) }}</span>
              <span class="tv-log-time">{{ fmt(it.createdAt) }}</span>
              <button v-if="it.status === 'open'" class="tv-op" @click="resolveIssue(it)">标记已解决</button>
            </div>
          </div>
        </div>

        <!-- 执行人 -->
        <div v-if="detailTab === 'assign'" class="tv-tab">
          <button class="dt-btn" @click="assignOpen = !assignOpen"><i class="fas fa-plus"></i> 添加执行人</button>
          <div v-if="assignOpen" class="tv-issue-form">
            <select v-model.number="assignForm.userId" class="srv-select">
              <option :value="0">选择执行人</option>
              <option v-for="m in members" :key="m.userId" :value="m.userId">{{ m.nick || m.username }}</option>
            </select>
            <input v-model="assignForm.content" class="srv-input" placeholder="要执行的内容" />
            <button class="dt-btn dt-btn-primary" @click="addAssignment">添加</button>
          </div>
          <div v-for="a in detail.assignments" :key="a.id" class="tv-assign">
            <div class="tv-assign-head">
              <b>{{ who(a.username, a.nick) }}</b>
              <span class="tv-badge" :class="a.status">{{ a.status === 'created' ? '未开始' : a.status === 'in_progress' ? '进行中' : '已完成' }}</span>
              <button class="tv-op" @click="removeAssign(a)"><i class="fas fa-trash"></i></button>
            </div>
            <div v-if="a.content" class="tv-assign-text">{{ a.content }}</div>
            <div class="tv-assign-ops">
              <button class="tv-op" @click="setAssignStatus(a, 'in_progress')">进行中</button>
              <button class="tv-op" @click="setAssignStatus(a, 'completed')">完成</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 创建任务 modal -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal tv-create">
        <div class="modal-head">新建任务</div>
        <div class="modal-body">
          <label class="tv-lab">任务名称</label>
          <input v-model="createForm.title" class="srv-input" placeholder="任务名称" />
          <label class="tv-lab">所属项目</label>
          <select v-model.number="createForm.projectId" class="srv-select">
            <option :value="0">不归属项目</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <div class="tv-two">
            <div><label class="tv-lab">开始时间</label><input v-model="createForm.startTime" type="datetime-local" class="srv-input" /></div>
            <div><label class="tv-lab">预期结束时间</label><input v-model="createForm.dueTime" type="datetime-local" class="srv-input" /></div>
          </div>
          <label class="tv-lab">描述</label>
          <textarea v-model="createForm.description" class="srv-input" rows="3" placeholder="任务描述"></textarea>
          <label class="tv-lab">图片</label>
          <div class="tv-create-images">
            <a v-for="(im, i) in createImages" :key="i" class="tv-create-img" @click.prevent="removeCreateImage(i)"><img :src="im" /></a>
            <button class="tv-img-add" @click="onAddImage"><i class="fas fa-plus"></i> 传图</button>
          </div>
          <label class="tv-lab">执行人（每人执行的内容）</label>
          <div v-for="(a, i) in createAssign" :key="i" class="tv-create-assign">
            <select v-model.number="a.userId" class="srv-select">
              <option :value="0">选择执行人</option>
              <option v-for="m in members" :key="m.userId" :value="m.userId">{{ m.nick || m.username }}</option>
            </select>
            <input v-model="a.content" class="srv-input" placeholder="要执行的内容" />
            <button v-if="createAssign.length > 1" class="tv-op" @click="createAssign.splice(i, 1)"><i class="fas fa-minus"></i></button>
          </div>
          <button class="dt-btn" @click="createAssign.push({ userId: 0, content: '' })"><i class="fas fa-plus"></i> 添加执行人</button>
          <div v-if="createErr" class="tv-err">{{ createErr }}</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showCreate = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitCreate">创建</button>
        </div>
      </div>
    </div>

    <!-- 状态变更 modal -->
    <div v-if="statusModal" class="modal-mask" @click.self="statusModal = null">
      <div class="modal tv-create">
        <div class="modal-head">{{ statusModal.status === 'completed' ? '完成任务' : statusModal.status === 'in_progress' ? '开始进行' : '状态变更' }}</div>
        <div class="modal-body">
          <label class="tv-lab">变更说明{{ statusModal.status === 'completed' ? '（必填）' : '' }}</label>
          <textarea v-model="statusModal.note" class="srv-input" rows="3" placeholder="说明变更原因/进展"></textarea>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="statusModal = null">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitStatus">确定</button>
        </div>
      </div>
    </div>

    <!-- 延期 modal -->
    <div v-if="extModal" class="modal-mask" @click.self="extModal = null">
      <div class="modal tv-create">
        <div class="modal-head">申请延期</div>
        <div class="modal-body">
          <label class="tv-lab">新截止时间</label>
          <input v-model="extModal.requestedDueTime" type="datetime-local" class="srv-input" />
          <label class="tv-lab">延期原因（必填）</label>
          <textarea v-model="extModal.reason" class="srv-input" rows="3" placeholder="延期原因"></textarea>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="extModal = null">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitExtend">提交申请</button>
        </div>
      </div>
    </div>

    <!-- 提醒设置 modal -->
    <div v-if="remindModal" class="modal-mask" @click.self="remindModal = null">
      <div class="modal tv-create">
        <div class="modal-head">提醒设置</div>
        <div class="modal-body">
          <div class="tv-two">
            <div><label class="tv-lab">黄色提醒（剩余天≤）</label><input v-model.number="remindModal.reminderYellow" type="number" min="0" class="srv-input" /></div>
            <div><label class="tv-lab">红色提醒（剩余天≤）</label><input v-model.number="remindModal.reminderRed" type="number" min="0" class="srv-input" /></div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="remindModal = null">取消</button>
          <button class="dt-btn dt-btn-primary" @click="submitRemind">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-view { height: 100%; display: flex; flex-direction: column; position: relative; overflow: hidden; }
.tv-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.tv-title { font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.tv-actions { display: flex; gap: 8px; }
.tv-err { padding: 8px 18px; color: #d92b3a; font-size: 13px; }
.tv-projects { display: flex; gap: 8px; padding: 10px 18px; border-bottom: 1px solid var(--dt-border-light); flex-wrap: wrap; flex-shrink: 0; }
.tv-proj { padding: 5px 12px; border-radius: 16px; border: 1px solid var(--dt-border-light); background: #fff; font-size: 13px; cursor: pointer; }
.tv-proj.on { background: var(--dt-primary); color: #fff; border-color: var(--dt-primary); }
.tv-list { flex: 1; overflow-y: auto; padding: 12px 18px; display: flex; flex-direction: column; gap: 10px; }
.tv-empty { color: var(--dt-text-4); text-align: center; padding: 40px 0; font-size: 14px; }
.tv-card { display: flex; border: 1px solid var(--dt-border-light); border-radius: 10px; background: #fff; cursor: pointer; overflow: hidden; }
.tv-card-bar { width: 5px; flex-shrink: 0; }
.tv-card.lvl-green .tv-card-bar { background: #2fbb6b; }
.tv-card.lvl-yellow .tv-card-bar { background: #e6a23c; }
.tv-card.lvl-red .tv-card-bar { background: #e64545; }
.tv-card-main { flex: 1; padding: 11px 14px; }
.tv-card-top { display: flex; align-items: center; gap: 8px; }
.tv-card-title { font-size: 15px; font-weight: 600; }
.tv-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.tv-badge.created { background: #e8f3ff; color: var(--dt-primary); }
.tv-badge.in_progress { background: #e6f7ff; color: #1890ff; }
.tv-badge.completed { background: #e8f9ef; color: #2fbb6b; }
.tv-badge.pending_extension { background: #fff3e0; color: #d46b08; }
.tv-badge.extended { background: #f3e8ff; color: #8a5cf6; }
.tv-badge.overdue { background: #ffe3e3; color: #d92b3a; }
.tv-card-desc { margin-top: 4px; font-size: 13px; color: var(--dt-text-3); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tv-card-meta { display: flex; gap: 14px; margin-top: 8px; font-size: 12px; color: var(--dt-text-3); flex-wrap: wrap; }
.tv-remain { font-weight: 600; }
.tv-remain.green { color: #2fbb6b; }
.tv-remain.yellow { color: #e6a23c; }
.tv-remain.red { color: #e64545; }
.tv-card-ops { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.tv-op { border: none; background: transparent; color: var(--dt-primary); font-size: 12px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
.tv-op:hover { background: #eef4ff; }
.tv-op.danger { color: #d92b3a; }
.tv-op.danger:hover { background: #ffe9e9; }

/* 详情面板 */
.tv-detail { position: absolute; top: 0; right: 0; bottom: 0; width: 400px; background: #fff; border-left: 1px solid var(--dt-border-light); display: flex; flex-direction: column; box-shadow: -4px 0 20px rgba(0,0,0,0.06); z-index: 20; }
.tv-detail-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--dt-border-light); font-size: 15px; font-weight: 700; gap: 8px; }
.tv-detail-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tv-detail-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
.tv-detail-info { display: flex; flex-direction: column; gap: 8px; }
.tv-di-row { display: flex; justify-content: space-between; font-size: 13px; }
.tv-di-row b.green { color: #2fbb6b; }
.tv-di-row b.yellow { color: #e6a23c; }
.tv-di-row b.red { color: #e64545; }
.tv-di-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
.tv-images { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.tv-images img { width: 110px; height: 80px; object-fit: cover; border-radius: 8px; }
.tv-tabs { display: flex; gap: 6px; margin-top: 16px; border-bottom: 1px solid var(--dt-border-light); }
.tv-tabs button { border: none; background: none; padding: 8px 12px; font-size: 13px; cursor: pointer; color: var(--dt-text-3); border-bottom: 2px solid transparent; }
.tv-tabs button.on { color: var(--dt-primary); border-bottom-color: var(--dt-primary); font-weight: 600; }
.tv-tab { padding: 10px 0; }
.tv-log { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 6px 0; border-bottom: 1px dashed var(--dt-border-light); flex-wrap: wrap; }
.tv-log-user { font-weight: 600; color: var(--dt-text-2); }
.tv-log-time { color: var(--dt-text-4); }
.tv-log-status { color: var(--dt-text-2); }
.tv-log-note { color: var(--dt-text-3); width: 100%; }
.tv-ext-list { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.tv-ext { font-size: 12px; color: var(--dt-text-2); padding: 6px 8px; background: #fafafa; border-radius: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tv-ext-pending { margin-left: auto; display: flex; gap: 4px; }
.tv-ext-state.approved { color: #2fbb6b; font-weight: 600; }
.tv-ext-state.rejected { color: #d92b3a; font-weight: 600; }
.tv-comment-box { display: flex; gap: 6px; align-items: flex-end; margin-bottom: 10px; }
.tv-comment-box textarea { flex: 1; resize: none; }
.tv-comment { font-size: 13px; padding: 6px 0; border-bottom: 1px dashed var(--dt-border-light); display: flex; gap: 8px; flex-wrap: wrap; }
.tv-comment-text { width: 100%; color: var(--dt-text-2); }
.tv-issue-form { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
.tv-issue { border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.tv-issue.resolved { opacity: 0.6; }
.tv-issue-head { display: flex; align-items: center; justify-content: space-between; font-size: 14px; }
.tv-issue-text { font-size: 13px; color: var(--dt-text-2); margin-top: 4px; }
.tv-issue-foot { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
.tv-assign { border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.tv-assign-head { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.tv-assign-text { font-size: 13px; color: var(--dt-text-2); margin-top: 4px; }
.tv-assign-ops { display: flex; gap: 6px; margin-top: 6px; }
.tv-badge.in_progress { background: #e6f7ff; color: #1890ff; }

/* 创建 modal */
.tv-create { width: 520px; max-height: 88vh; overflow-y: auto; }
.tv-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.tv-create .modal-body { padding: 6px 18px 16px; }
.tv-two { display: flex; gap: 10px; }
.tv-two > div { flex: 1; }
.tv-create-images { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.tv-create-img { position: relative; }
.tv-create-img img { width: 72px; height: 52px; object-fit: cover; border-radius: 6px; }
.tv-img-add { width: 72px; height: 52px; border: 1px dashed var(--dt-border-strong); border-radius: 6px; background: #fafafa; color: var(--dt-text-3); font-size: 12px; cursor: pointer; }
.tv-create-assign { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
.tv-create-assign select { flex: 0 0 140px; }
</style>
