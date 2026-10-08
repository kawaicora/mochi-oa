<script setup lang="ts">
/**
 * 独立任务详情窗口（task.html）。
 * 从 URL 拿 taskId，初始化连接后加载任务完整详情，包含：状态流转、留言（含附图）、问题(QA)、执行人、动态、延期、提醒。
 */
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import DateTimeInput from '../components/DateTimeInput.vue'

const app = useAppStore()
const server = useServerStore()

type TaskStatus = 'created' | 'in_progress' | 'completed' | 'pending_extension' | 'extended' | 'overdue'
interface Task { id: number; companyId: number; projectId: number | null; title: string; description: string; startTime: string; dueTime: string; completedTime: string | null; status: TaskStatus; isOverdue: boolean; reminderYellow: number; reminderRed: number; images: string[]; createdBy: number; createdAt: string; updatedAt: string }
interface Assignment { id: number; taskId: number; userId: number; content: string; status: 'created' | 'in_progress' | 'completed'; completedAt: string | null; username?: string; nick?: string; avatar?: string }
interface Att { kind: 'image' | 'video' | 'audio' | 'folder' | 'file'; url: string; name: string }
interface Comment { id: number; taskId: number; userId: number; content: string; attachments: Att[]; createdAt: string; username?: string; nick?: string }
interface Issue { id: number; taskId: number; userId: number; title: string; content: string; status: 'open' | 'resolved'; createdAt: string; username?: string; nick?: string }
interface Extension { id: number; taskId: number; userId: number; requestedDueTime: string; reason: string; status: 'pending' | 'approved' | 'rejected'; decidedBy: number | null; decidedAt: string | null; createdAt: string; username?: string; nick?: string }
interface Log { id: number; taskId: number; userId: number; fromStatus: string; toStatus: string; note: string; createdAt: string; username?: string; nick?: string }
interface Detail { task: Task; assignments: Assignment[]; comments: Comment[]; issues: Issue[]; extensions: Extension[]; logs: Log[] }

const meId = computed(() => server.state.userId ?? 0)
const members = computed(() => app.members ?? [])

const taskId = ref(Number(new URLSearchParams(window.location.search).get('taskId') ?? 0))
const detail = ref<Detail | null>(null)
const loading = ref(true)
const err = ref('')
const detailTab = ref<'activity' | 'comments' | 'issues' | 'assign'>('activity')

// ─── 辅助 ───
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
const ASSIGN_LABEL: Record<string, string> = { created: '未开始', in_progress: '进行中', completed: '已完成' }
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
function toIso(lt: string): string {
  if (!lt) return ''
  const d = new Date(lt)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

async function refresh(): Promise<void> {
  const dd = await app.fetchTaskDetail(taskId.value)
  if (dd) detail.value = dd
}

// ─── 状态流转 ───
const statusModal = ref<{ status: TaskStatus; note: string } | null>(null)
function askStatus(status: TaskStatus): void { statusModal.value = { status, note: '' } }
async function submitStatus(): Promise<void> {
  const m = statusModal.value
  if (!m || !detail.value) return
  if (!m.note.trim()) { err.value = '流转需填写说明'; return }
  const r = await app.setTaskStatus(detail.value.task.id, m.status, m.note.trim())
  statusModal.value = null
  if (!r.ok) { err.value = r.error || '状态变更失败'; return }
  // 任务开始进行时，把未开始的执行人同步为进行中
  if (m.status === 'in_progress') {
    const cur = detail.value
    for (const a of cur.assignments) {
      if (a.status === 'created') await app.setAssignmentStatus(a.id, 'in_progress')
    }
  }
  await refresh()
}

// ─── 延期 ───
const extModal = ref<{ requestedDueTime: string; reason: string } | null>(null)
function askExtend(): void {
  const t = detail.value?.task
  if (!t) return
  extModal.value = { requestedDueTime: t.dueTime.slice(0, 16), reason: '' }
}
async function submitExtend(): Promise<void> {
  const m = extModal.value
  if (!m || !detail.value) return
  const dt = toIso(m.requestedDueTime)
  if (!dt || !m.reason.trim()) { err.value = '请填写新截止时间与原因'; return }
  const r = await app.requestExtension(detail.value.task.id, dt, m.reason.trim())
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

// ─── 提醒 ───
const remindModal = ref<{ reminderYellow: number; reminderRed: number } | null>(null)
function askRemind(): void {
  const t = detail.value?.task
  if (!t) return
  remindModal.value = { reminderYellow: t.reminderYellow, reminderRed: t.reminderRed }
}
async function submitRemind(): Promise<void> {
  const m = remindModal.value
  if (!m || !detail.value) return
  const r = await app.setTaskReminder(detail.value.task.id, m.reminderYellow, m.reminderRed)
  remindModal.value = null
  if (!r.ok) { err.value = r.error || '设置失败'; return }
  await refresh()
}

// ─── 留言（对话流：文字 + 图片）───
const commentText = ref('')
const commentAtts = ref<Att[]>([])
const baseName = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p
async function uploadPaths(paths: string[], kind: Att['kind']): Promise<void> {
  for (const path of paths) {
    const clientId = `task-att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const up = await window.pantry.serverUploadChunked(path, clientId, app.activeCompanyId ?? 0)
    if (up.ok && up.url) commentAtts.value.push({ kind, url: up.url, name: baseName(path) })
    else err.value = up.error || '上传失败'
  }
}
async function onPickImages(): Promise<void> {
  const paths = await window.pantry.pickFiles('image')
  if (paths && paths.length) await uploadPaths(paths, 'image')
}
async function onPickVideos(): Promise<void> {
  const paths = await window.pantry.pickFiles('video')
  if (paths && paths.length) await uploadPaths(paths, 'video')
}
async function onPickFiles(): Promise<void> {
  const paths = await window.pantry.pickFiles()
  if (paths && paths.length) await uploadPaths(paths, 'file')
}
async function onPickFolder(): Promise<void> {
  const folderPath = await window.pantry.pickFolder()
  if (!folderPath) return
  const files = await window.pantry.serverListFolderFiles(folderPath)
  if (!files.length) return
  const root = folderPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const folderName = root.split('/').pop() ?? '文件夹'
  for (const f of files) {
    const rel = f.replace(/\\/g, '/')
    const relDir = rel.startsWith(root) ? rel.slice(root.length).replace(/^\/+/, '') : ''
    const dirOnly = relDir.split('/').slice(0, -1).join('/')
    const relPath = folderName ? [folderName, dirOnly].filter(Boolean).join('/') : dirOnly
    const clientId = `task-att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const up = await window.pantry.serverUploadChunked(f, clientId, app.activeCompanyId ?? 0, relPath)
    if (up.ok && up.url) commentAtts.value.push({ kind: 'folder', url: up.url, name: folderName })
    else { err.value = up.error || '文件夹上传失败'; break }
  }
}
async function addComment(): Promise<void> {
  if (!detail.value) return
  const text = commentText.value.trim()
  const atts = commentAtts.value
  if (!text && atts.length === 0) return
  try {
    const r = await app.addTaskComment(detail.value.task.id, text, atts)
    commentText.value = ''
    commentAtts.value = []
    if (!r.ok) { err.value = r.error || '留言发送失败'; return }
    await refresh()
  } catch {
    err.value = '留言发送失败'
  }
}

// ─── QA ───
const issueOpen = ref(false)
const issueForm = ref({ title: '', content: '' })
async function addIssue(): Promise<void> {
  if (!detail.value || !issueForm.value.title.trim()) return
  const r = await app.addTaskIssue(detail.value.task.id, issueForm.value.title.trim(), issueForm.value.content.trim())
  issueOpen.value = false
  issueForm.value = { title: '', content: '' }
  if (!r.ok) { err.value = r.error || '发布失败'; return }
  await refresh()
}
async function resolveIssue(it: Issue): Promise<void> {
  const r = await app.resolveTaskIssue(it.id)
  if (!r.ok) { err.value = r.error || '操作失败'; return }
  await refresh()
}

// ─── 执行人 ───
const assignOpen = ref(false)
const assignForm = ref({ userId: 0, content: '' })
async function addAssignment(): Promise<void> {
  if (!detail.value || !assignForm.value.userId) return
  const r = await app.addAssignment(detail.value.task.id, assignForm.value.userId, assignForm.value.content.trim())
  assignOpen.value = false
  assignForm.value = { userId: 0, content: '' }
  if (!r.ok) { err.value = r.error || '添加失败'; return }
  await refresh()
}
async function removeAssign(a: Assignment): Promise<void> {
  const r = await app.removeAssignment(a.id)
  if (!r.ok) { err.value = r.error || '移除失败'; return }
  await refresh()
}
async function setAssignStatus(a: Assignment, status: 'created' | 'in_progress' | 'completed'): Promise<void> {
  const r = await app.setAssignmentStatus(a.id, status)
  if (!r.ok) { err.value = r.error || '更新失败'; return }
  await refresh()
}

function close(): void { window.close() }

onMounted(async () => {
  if (!taskId.value) { err.value = '缺少任务 ID'; loading.value = false; return }
  await server.init()
  await app.bootstrap()
  await refresh()
  loading.value = false
})
</script>

<template>
  <div class="twin">
    <div v-if="loading" class="twin-center">加载中…</div>
    <div v-else-if="err && !detail" class="twin-center">{{ err }}</div>
    <template v-else-if="detail">
      <!-- 头部 -->
      <div class="twin-head">
        <span class="twin-badge" :class="detail.task.status">{{ STATUS_LABEL[detail.task.status] }}</span>
        <span class="twin-title">{{ detail.task.title }}</span>
        <button class="twin-close" @click="close"><i class="fas fa-times"></i></button>
      </div>
      <div v-if="err" class="twin-err">{{ err }}</div>

      <div class="twin-body">
        <!-- 基础信息 -->
        <div class="twin-info">
          <div class="twin-row"><span>开始</span><b>{{ fmt(detail.task.startTime) }}</b></div>
          <div class="twin-row"><span>预期结束</span><b :class="'c-' + colorOf(detail.task)">{{ fmt(detail.task.dueTime) }}</b></div>
          <div class="twin-row"><span>剩余</span><b :class="'c-' + colorOf(detail.task)">{{ remainText(detail.task) }}</b></div>
          <div class="twin-row"><span>提醒</span><b>黄≤{{ detail.task.reminderYellow }}天 / 红≤{{ detail.task.reminderRed }}天</b></div>
          <div v-if="detail.task.description" class="twin-desc">{{ detail.task.description }}</div>
          <div class="twin-actions">
            <button class="dt-btn" @click="askStatus('in_progress')">开始进行</button>
            <button class="dt-btn" @click="askStatus('completed')">完成</button>
            <button class="dt-btn" @click="askExtend">申请延期</button>
            <button class="dt-btn" @click="askRemind">提醒设置</button>
          </div>
          <div v-if="detail.task.images.length" class="twin-images">
            <a v-for="(im, i) in detail.task.images" :key="i" :href="server.absFileUrl(im)" target="_blank"><img :src="server.absFileUrl(im)" alt="任务图片" /></a>
          </div>
        </div>

        <!-- Tabs -->
        <div class="twin-tabs">
          <button :class="{ on: detailTab === 'activity' }" @click="detailTab = 'activity'">动态</button>
          <button :class="{ on: detailTab === 'comments' }" @click="detailTab = 'comments'">留言 {{ detail.comments.length }}</button>
          <button :class="{ on: detailTab === 'issues' }" @click="detailTab = 'issues'">问题 {{ detail.issues.length }}</button>
          <button :class="{ on: detailTab === 'assign' }" @click="detailTab = 'assign'">执行人 {{ detail.assignments.length }}</button>
        </div>

        <!-- 动态 -->
        <div v-if="detailTab === 'activity'" class="twin-tab">
          <div v-for="l in detail.logs" :key="l.id" class="twin-log">
            <span class="twin-log-t">{{ fmt(l.createdAt) }}</span>
            <span class="twin-log-u">{{ who(l.username, l.nick) }}</span>
            <span class="twin-log-n">{{ STATUS_LABEL[l.toStatus] || l.toStatus }}<template v-if="l.note"> — {{ l.note }}</template></span>
          </div>
          <div v-if="!detail.logs.length" class="twin-empty">暂无动态</div>
        </div>

        <!-- 留言 -->
        <div v-if="detailTab === 'comments'" class="twin-tab">
          <div class="twin-comment-box">
            <textarea v-model="commentText" class="srv-input" rows="2" placeholder="输入留言…（可附图）" @keydown.ctrl.enter="addComment"></textarea>
            <div v-if="commentAtts.length" class="twin-pre">
              <div v-for="(at, i) in commentAtts" :key="i" class="twin-pre-item" @click="commentAtts.splice(i, 1)">
                <img v-if="at.kind === 'image'" :src="server.absFileUrl(at.url)" />
                <video v-else-if="at.kind === 'video'" :src="server.absFileUrl(at.url)"></video>
                <i v-else :class="at.kind === 'folder' ? 'fas fa-folder' : 'far fa-file-alt'"></i>
              </div>
            </div>
            <div class="twin-ops">
              <button class="twin-img" title="多选图片" @click="onPickImages"><i class="fas fa-image"></i> 图片</button>
              <button class="twin-img" title="多选视频" @click="onPickVideos"><i class="fas fa-file-video"></i> 视频</button>
              <button class="twin-img" title="多选文件/模型" @click="onPickFiles"><i class="fas fa-paperclip"></i> 文件</button>
              <button class="twin-img" title="发送文件夹" @click="onPickFolder"><i class="fas fa-folder-open"></i> 文件夹</button>
              <button class="dt-btn dt-btn-primary" @click="addComment"><i class="fas fa-paper-plane"></i> 发送</button>
            </div>
          </div>
          <div v-for="c in [...detail.comments].reverse()" :key="c.id" class="twin-comment">
            <span class="twin-log-u">{{ who(c.username, c.nick) }}</span>
            <span class="twin-log-t">{{ fmt(c.createdAt) }}</span>
            <div v-if="c.content" class="twin-c-text">{{ c.content }}</div>
            <div v-if="c.attachments && c.attachments.length" class="twin-imgs">
              <template v-for="(at, i) in c.attachments" :key="i">
                <a v-if="at.kind === 'image'" :href="server.absFileUrl(at.url)" target="_blank"><img :src="server.absFileUrl(at.url)" /></a>
                <video v-else-if="at.kind === 'video'" :src="server.absFileUrl(at.url)" controls></video>
                <a v-else class="twin-att" :href="server.absFileUrl(at.url)" target="_blank"><i :class="at.kind === 'folder' ? 'fas fa-folder' : 'far fa-file-alt'"></i>{{ at.name || at.url }}</a>
              </template>
            </div>
          </div>
          <div v-if="!detail.comments.length" class="twin-empty">还没有留言</div>
        </div>

        <!-- 问题 QA -->
        <div v-if="detailTab === 'issues'" class="twin-tab">
          <button class="dt-btn" @click="issueOpen = !issueOpen"><i class="fas fa-plus"></i> 发布问题</button>
          <div v-if="issueOpen" class="twin-issue-form">
            <input v-model="issueForm.title" class="srv-input" placeholder="问题标题" />
            <textarea v-model="issueForm.content" class="srv-input" rows="2" placeholder="问题描述"></textarea>
            <button class="dt-btn dt-btn-primary" @click="addIssue">发布</button>
          </div>
          <div v-for="it in detail.issues" :key="it.id" class="twin-issue">
            <div class="twin-issue-h">
              <b>{{ it.title }}</b>
              <span class="twin-badge" :class="it.status">{{ it.status === 'resolved' ? '已解决' : '待解决' }}</span>
            </div>
            <div v-if="it.content" class="twin-issue-c">{{ it.content }}</div>
            <div class="twin-issue-meta"><span class="twin-log-u">{{ who(it.username, it.nick) }}</span> · {{ fmt(it.createdAt) }}
              <button v-if="it.status === 'open'" class="twin-link" @click="resolveIssue(it)">标记解决</button>
            </div>
          </div>
          <div v-if="!detail.issues.length" class="twin-empty">没有问题</div>
        </div>

        <!-- 执行人 -->
        <div v-if="detailTab === 'assign'" class="twin-tab">
          <button class="dt-btn" @click="assignOpen = !assignOpen"><i class="fas fa-plus"></i> 添加执行人</button>
          <div v-if="assignOpen" class="twin-issue-form">
            <select v-model.number="assignForm.userId" class="srv-select">
              <option :value="0">选择执行人</option>
              <option v-for="m in members" :key="m.userId" :value="m.userId">{{ m.nick || m.username }}</option>
            </select>
            <input v-model="assignForm.content" class="srv-input" placeholder="要执行的内容" />
            <button class="dt-btn dt-btn-primary" @click="addAssignment">添加</button>
          </div>
          <div v-for="a in detail.assignments" :key="a.id" class="twin-assign">
            <div class="twin-assign-h">
              <b>{{ who(a.username, a.nick) }}</b>
              <span class="twin-badge" :class="a.status">{{ ASSIGN_LABEL[a.status] }}</span>
              <button class="twin-link danger" @click="removeAssign(a)"><i class="fas fa-trash"></i></button>
            </div>
            <div v-if="a.content" class="twin-issue-c">{{ a.content }}</div>
            <div class="twin-ops">
              <button v-if="a.status !== 'completed'" class="twin-link" @click="setAssignStatus(a, 'in_progress')">进行中</button>
              <button v-if="a.status !== 'completed'" class="twin-link" @click="setAssignStatus(a, 'completed')">完成</button>
            </div>
          </div>
          <div v-if="!detail.assignments.length" class="twin-empty">还没有执行人</div>
        </div>
      </div>

      <!-- 状态流转 modal -->
      <div v-if="statusModal" class="modal-mask">
        <div class="modal">
          <div class="modal-head">{{ statusModal.status === 'completed' ? '完成任务' : statusModal.status === 'in_progress' ? '开始进行' : '状态变更' }}</div>
          <div class="modal-body">
            <label class="tv-lab">流转说明（必填）</label>
            <textarea v-model="statusModal.note" class="srv-input" rows="3" placeholder="说明变更原因/进展"></textarea>
          </div>
          <div class="modal-foot">
            <button class="dt-btn" @click="statusModal = null">取消</button>
            <button class="dt-btn dt-btn-primary" @click="submitStatus">确定</button>
          </div>
        </div>
      </div>

      <!-- 延期 modal -->
      <div v-if="extModal" class="modal-mask">
        <div class="modal">
          <div class="modal-head">申请延期</div>
          <div class="modal-body">
            <label class="tv-lab">新截止时间</label>
            <DateTimeInput v-model="extModal.requestedDueTime" />
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
      <div v-if="remindModal" class="modal-mask">
        <div class="modal">
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
    </template>
  </div>
</template>

<style scoped>
html, body, #app, .twin { height: 100%; margin: 0; }
.twin { display: flex; flex-direction: column; background: #fff; color: var(--dt-text); font-size: 14px; }
.twin-center { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--dt-text-3); }
.twin-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.twin-title { font-size: 16px; font-weight: 700; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.twin-close { border: none; background: transparent; cursor: pointer; color: var(--dt-text-3); font-size: 16px; padding: 4px 8px; border-radius: 6px; }
.twin-close:hover { background: var(--dt-active); }
.twin-err { padding: 8px 16px; color: #d92b3a; font-size: 13px; }
.twin-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
.twin-info { display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--dt-border-light); padding-bottom: 12px; }
.twin-row { display: flex; gap: 10px; font-size: 13px; }
.twin-row span { width: 80px; color: var(--dt-text-3); flex-shrink: 0; }
.twin-row b { font-weight: 600; }
.c-green { color: #2fbb6b; } .c-yellow { color: #e6a23c; } .c-red { color: #e64545; }
.twin-desc { color: var(--dt-text-2); padding: 4px 0; white-space: pre-wrap; }
.twin-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.twin-images, .twin-imgs { display: flex; gap: 8px; flex-wrap: wrap; }
.twin-images img, .twin-imgs img { max-width: 200px; max-height: 150px; object-fit: cover; border-radius: 8px; }
.twin-imgs video { max-width: 320px; max-height: 200px; border-radius: 8px; }
.twin-att { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; background: #f6f8fa; border: 1px solid var(--dt-border-light); border-radius: 8px; color: var(--dt-text-2); text-decoration: none; font-size: 12px; }
.twin-att i { font-size: 16px; color: var(--dt-primary); }
.twin-pre-item { width: 56px; height: 56px; border-radius: 6px; overflow: hidden; border: 1px dashed var(--dt-border-strong); cursor: pointer; display: flex; align-items: center; justify-content: center; background: #fafafa; }
.twin-pre-item img { width: 100%; height: 100%; object-fit: cover; }
.twin-pre-item video { width: 100%; height: 100%; object-fit: cover; }
.twin-pre-item i { font-size: 20px; color: var(--dt-text-3); }
.twin-tabs { display: flex; gap: 4px; margin-top: 12px; border-bottom: 1px solid var(--dt-border-light); }
.twin-tabs button { border: none; background: transparent; padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--dt-text-3); border-radius: 6px 6px 0 0; }
.twin-tabs button.on { color: var(--dt-primary); font-weight: 700; box-shadow: inset 0 -2px 0 var(--dt-primary); }
.twin-tab { padding: 10px 0; }
.twin-log { display: flex; align-items: baseline; gap: 8px; font-size: 12px; padding: 6px 0; border-bottom: 1px dashed var(--dt-border-light); flex-wrap: wrap; }
.twin-log-t { color: var(--dt-text-4); }
.twin-log-u { font-weight: 600; color: var(--dt-text-2); }
.twin-log-n { color: var(--dt-text-3); }
.twin-empty { color: var(--dt-text-4); text-align: center; padding: 30px 0; font-size: 13px; }
.twin-comment-box { display: flex; gap: 6px; align-items: flex-end; margin-bottom: 10px; flex-wrap: wrap; }
.twin-comment-box textarea { flex: 1 1 260px; resize: none; min-height: 52px; }
.twin-pre { display: flex; gap: 6px; flex-wrap: wrap; }
.twin-pre a { display: inline-block; }
.twin-pre img { width: 56px; height: 56px; object-fit: cover; border-radius: 6px; }
.twin-ops { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.twin-img { width: auto; padding: 8px 12px; border: 1px dashed var(--dt-border-strong); border-radius: 6px; background: #fafafa; color: var(--dt-text-3); font-size: 12px; cursor: pointer; }
.twin-comment { font-size: 13px; padding: 6px 0; border-bottom: 1px dashed var(--dt-border-light); }
.twin-c-text { margin-top: 4px; color: var(--dt-text-2); white-space: pre-wrap; }
.twin-issue-form { display: flex; flex-direction: column; gap: 8px; padding: 10px 0; border-bottom: 1px dashed var(--dt-border-light); margin-bottom: 8px; }
.twin-issue { padding: 8px 0; border-bottom: 1px dashed var(--dt-border-light); }
.twin-issue-h { display: flex; align-items: center; gap: 8px; }
.twin-issue-c { color: var(--dt-text-2); margin-top: 4px; font-size: 13px; white-space: pre-wrap; }
.twin-issue-meta { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; color: var(--dt-text-4); }
.twin-assign { padding: 8px 0; border-bottom: 1px dashed var(--dt-border-light); }
.twin-assign-h { display: flex; align-items: center; gap: 8px; }
.twin-link { border: none; background: transparent; color: var(--dt-primary); cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 6px; }
.twin-link:hover { background: #eef4ff; }
.twin-link.danger { color: #d92b3a; }
.twin-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; flex-shrink: 0; }
.twin-badge.created { background: #e8f3ff; color: var(--dt-primary); }
.twin-badge.in_progress { background: #e6f7ff; color: #1890ff; }
.twin-badge.completed { background: #e8f9ef; color: #2fbb6b; }
.twin-badge.pending_extension { background: #fff3e0; color: #d46b08; }
.twin-badge.extended { background: #f3e8ff; color: #8a5cf6; }
.twin-badge.overdue { background: #ffe3e3; color: #d92b3a; }
.twin-badge.open { background: #fff3e0; color: #d46b08; }
.twin-badge.resolved { background: #e8f9ef; color: #2fbb6b; }
.tv-two { display: flex; gap: 10px; }
.tv-two > div { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.tv-lab { font-size: 13px; font-weight: 600; color: var(--dt-text-2); }
</style>
