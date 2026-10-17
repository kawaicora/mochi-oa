<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'

// ── 类型（与服务端冻结协议对齐）──
interface JobItem {
  id: number
  companyId: number
  name: string
  description: string | null
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}
interface Binding {
  userId: number
  nick: string
  username: string
  departmentId: number | null
  departmentName: string | null
  positionId: number | null
  positionName: string | null
  positionExtra: string | null
}

const app = useAppStore()
const server = useServerStore()
const companyId = computed(() => app.activeCompanyId)
const isAdmin = computed(() => app.isAdmin)

// ── 子页签：职位管理 | 员工绑定 ──
const subTab = ref<'jobs' | 'bindings'>('jobs')

// ═══════ 职位列表 ═══════
const jobs = ref<JobItem[]>([])
const jobTotal = ref(0)
const jobPage = ref(1)
const jobKeyword = ref('')
const pageSize = 20
const loading = ref(false)

async function loadJobs(): Promise<void> {
  if (!companyId.value) return
  loading.value = true
  try {
    const ack = await window.pantry.serverJobList({
      companyId: companyId.value, keyword: jobKeyword.value, page: jobPage.value, pageSize
    })
    if (!ack.ok) { console.error('[职位] 列表失败', ack.error); return }
    jobs.value = (ack.data as { jobs?: JobItem[] })?.jobs ?? []
    jobTotal.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[职位] 列表异常', e) }
  loading.value = false
}
watch([jobKeyword, jobPage], () => { loadJobs() })

// ── 新增/编辑弹窗 ──
const editing = ref<JobItem | null>(null) // null=关闭；'new' 用字符串标记不便，用 isNew 区分
const isNew = ref(false)
const fName = ref('')
const fDesc = ref('')
const fSort = ref(0)
const fEnabled = ref(true)
const err = ref('')
const okMsg = ref('')

function openNew(): void {
  isNew.value = true
  editing.value = null
  fName.value = ''; fDesc.value = ''; fSort.value = jobs.value.length ? Math.max(...jobs.value.map((j) => j.sortOrder)) + 1 : 1; fEnabled.value = true
  err.value = ''; okMsg.value = ''
}
function openEdit(j: JobItem): void {
  isNew.value = false
  editing.value = j
  fName.value = j.name; fDesc.value = j.description || ''; fSort.value = j.sortOrder; fEnabled.value = j.enabled
  err.value = ''; okMsg.value = ''
}
async function saveJob(): Promise<void> {
  if (!companyId.value) { err.value = '尚未加入公司'; return }
  if (!fName.value.trim()) { err.value = '请填写职位名称'; return }
  err.value = ''
  try {
    const payload: Record<string, unknown> = {
      companyId: companyId.value, name: fName.value.trim(),
      description: fDesc.value.trim(), sortOrder: Number(fSort.value) || 0, enabled: fEnabled.value
    }
    const ack = isNew.value
      ? await window.pantry.serverJobCreate(payload)
      : await window.pantry.serverJobUpdate({ ...payload, id: editing.value!.id })
    if (!ack.ok) { console.error('[职位] 保存失败', ack.error); err.value = ack.error || '保存失败'; return }
    okMsg.value = '已保存'
    editing.value = null
    await loadJobs()
  } catch (e) { console.error('[职位] 保存异常', e); err.value = '保存异常' }
}
async function toggleEnabled(j: JobItem): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverJobUpdate({ companyId: companyId.value, id: j.id, enabled: !j.enabled })
    if (!ack.ok) { console.error('[职位] 启停失败', ack.error); return }
    await loadJobs()
  } catch (e) { console.error('[职位] 启停异常', e) }
}
async function removeJob(j: JobItem): Promise<void> {
  if (!companyId.value) return
  if (!window.confirm(`删除职位「${j.name}」？\n已绑定该职位的员工将一并解绑。`)) return
  try {
    const ack = await window.pantry.serverJobDelete(companyId.value, j.id)
    if (!ack.ok) { console.error('[职位] 删除失败', ack.error); return }
    await loadJobs()
  } catch (e) { console.error('[职位] 删除异常', e) }
}

// ═══════ 员工绑定 ═══════
const bindings = ref<Binding[]>([])
const bindTotal = ref(0)
const bindPage = ref(1)
const bindLoading = ref(false)
// 职位下拉用：仅启用职位
const enabledJobs = computed(() => jobs.value.filter((j) => j.enabled))

async function loadBindings(): Promise<void> {
  if (!companyId.value) return
  bindLoading.value = true
  try {
    const ack = await window.pantry.serverJobBindings({ companyId: companyId.value, page: bindPage.value, pageSize: 50 })
    if (!ack.ok) { console.error('[职位] 员工绑定列表失败', ack.error); return }
    bindings.value = (ack.data as { bindings?: Binding[] })?.bindings ?? []
    bindTotal.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[职位] 员工绑定列表异常', e) }
  bindLoading.value = false
}
watch(bindPage, () => { loadBindings() })

/** 改某员工职位/兼任标记 → job:bind（jobId 空=解绑） */
async function bindJob(b: Binding, jobId: number | null, extra: string): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverJobBind({
      companyId: companyId.value, userId: b.userId, jobId: jobId ?? null, extra: extra || null
    })
    if (!ack.ok) { console.error('[职位] 绑定失败', ack.error); return }
    await Promise.all([loadBindings(), loadJobs()])
  } catch (e) { console.error('[职位] 绑定异常', e) }
}

watch(companyId, async () => {
  if (!companyId.value) return
  await Promise.all([loadJobs(), loadBindings()])
})
onMounted(async () => {
  await Promise.all([loadJobs(), loadBindings()])
})
</script>

<template>
  <div class="job">
    <!-- 顶部子页签 -->
    <div class="job-tabs">
      <button :class="{ on: subTab === 'jobs' }" @click="subTab = 'jobs'"><i class="fas fa-sitemap"></i> 职位列表</button>
      <button :class="{ on: subTab === 'bindings' }" @click="subTab = 'bindings'"><i class="fas fa-users"></i> 员工绑定</button>
    </div>

    <!-- 职位列表 -->
    <div v-show="subTab === 'jobs'" class="job-body">
      <div class="job-toolbar">
        <input v-model="jobKeyword" class="srv-input" placeholder="搜索职位名称…" />
        <button v-if="isAdmin" class="dt-btn dt-btn-primary" @click="openNew"><i class="fas fa-plus"></i> 新增职位</button>
      </div>
      <div v-if="loading" class="job-empty">加载中…</div>
      <div v-else-if="!jobs.length" class="job-empty">暂无职位</div>
      <table v-else class="job-table">
        <thead><tr><th>排序</th><th>名称</th><th>描述</th><th>启用</th><th v-if="isAdmin">操作</th></tr></thead>
        <tbody>
          <tr v-for="j in jobs" :key="j.id">
            <td>{{ j.sortOrder }}</td>
            <td class="job-name">{{ j.name }}</td>
            <td class="job-desc">{{ j.description || '—' }}</td>
            <td>
              <span v-if="!isAdmin" :class="['job-badge', j.enabled ? 'on' : 'off']">{{ j.enabled ? '启用' : '停用' }}</span>
              <label v-else class="job-switch"><input type="checkbox" :checked="j.enabled" @change="toggleEnabled(j)" /><i></i></label>
            </td>
            <td v-if="isAdmin" class="job-ops">
              <button class="dt-btn sm" @click="openEdit(j)"><i class="fas fa-edit"></i> 编辑</button>
              <button class="dt-btn sm danger" @click="removeJob(j)"><i class="fas fa-trash"></i> 删除</button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="job-page">共 {{ jobTotal }} 个职位</div>
    </div>

    <!-- 员工绑定 -->
    <div v-show="subTab === 'bindings'" class="job-body">
      <div v-if="bindLoading" class="job-empty">加载中…</div>
      <div v-else-if="!bindings.length" class="job-empty">暂无成员</div>
      <table v-else class="job-table">
        <thead><tr><th>成员</th><th>部门</th><th>当前职位</th><th v-if="isAdmin">兼任标记</th><th v-if="isAdmin">操作</th></tr></thead>
        <tbody>
          <tr v-for="b in bindings" :key="b.userId">
            <td class="job-name">{{ b.nick || b.username }}</td>
            <td>{{ b.departmentName || '—' }}</td>
            <td>
              <template v-if="!isAdmin">
                <span v-if="b.positionName">{{ b.positionName }}<span v-if="b.positionExtra" class="job-extra">（{{ b.positionExtra }}）</span></span>
                <span v-else class="job-muted">未设置</span>
              </template>
              <select v-else class="srv-input" :value="b.positionId ?? ''" @change="bindJob(b, Number(($event.target as HTMLSelectElement).value) || null, b.positionExtra || '')">
                <option :value="''">未设置</option>
                <option v-for="j in enabledJobs" :key="j.id" :value="j.id">{{ j.name }}</option>
              </select>
            </td>
            <td v-if="isAdmin">{{ b.positionExtra || '—' }}</td>
            <td v-if="isAdmin" class="job-ops">
              <input class="srv-input job-extra-input" :placeholder="b.positionId ? '兼任标记' : '先选职位'" :value="b.positionExtra || ''"
                @change="bindJob(b, b.positionId, ($event.target as HTMLInputElement).value)" />
            </td>
          </tr>
        </tbody>
      </table>
      <div class="job-page">共 {{ bindTotal }} 名成员</div>
    </div>

    <!-- 新增/编辑弹窗 -->
    <div v-if="editing !== null || isNew" class="job-modal-mask" @click.self="editing = null; isNew = false">
      <div class="job-modal">
        <div class="job-modal-title">{{ isNew ? '新增职位' : '编辑职位' }}</div>
        <div class="job-field"><label class="job-lab">名称 <i class="req">*</i></label>
          <input v-model="fName" class="srv-input" placeholder="如：前端工程师" /></div>
        <div class="job-field"><label class="job-lab">描述</label>
          <textarea v-model="fDesc" class="srv-input" rows="2" placeholder="职责描述（可选）"></textarea></div>
        <div class="job-row">
          <div class="job-field"><label class="job-lab">排序号</label>
            <input v-model.number="fSort" type="number" class="srv-input" /></div>
          <div class="job-field"><label class="job-lab">启用</label>
            <label class="job-switch"><input type="checkbox" v-model="fEnabled" /><i></i></label></div>
        </div>
        <div v-if="err" class="job-err">{{ err }}</div>
        <div v-if="okMsg" class="job-ok">{{ okMsg }}</div>
        <div class="job-modal-ops">
          <button class="dt-btn" @click="editing = null; isNew = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="saveJob"><i class="fas fa-check"></i> 保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 根容器 flex 占满父级、内部滚动（与报表/考勤一致，避免半屏） */
.job { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; background: #f8fafc; }
.job-tabs { display: flex; gap: 4px; padding: 10px 16px 0; border-bottom: 1px solid #eef0f3; }
.job-tabs button {
  border: none; background: transparent; padding: 9px 16px; cursor: pointer;
  font-size: 13px; color: #6b7280; border-bottom: 2px solid transparent;
}
.job-tabs button.on { color: var(--dt-primary); font-weight: 700; border-bottom-color: var(--dt-primary); }
.job-body { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
.job-toolbar { display: flex; gap: 10px; margin-bottom: 12px; }
.job-toolbar .srv-input { max-width: 260px; }
.job-empty { color: #9ca3af; padding: 40px 0; text-align: center; }
.job-table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; }
.job-table th, .job-table td { padding: 10px 12px; text-align: left; font-size: 13px; border-bottom: 1px solid #f1f3f6; }
.job-table th { background: #fafbfc; color: #6b7280; font-weight: 600; }
.job-name { font-weight: 600; color: #1f2937; }
.job-desc { color: #6b7280; }
.job-muted { color: #9ca3af; }
.job-extra { color: var(--dt-primary); }
.job-extra-input { max-width: 130px; }
.job-ops { display: flex; gap: 6px; }
.job-page { color: #9ca3af; font-size: 12px; margin-top: 10px; }
.job-badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; }
.job-badge.on { background: #dcfce7; color: #16a34a; }
.job-badge.off { background: #f3f4f6; color: #9ca3af; }

/* 启用开关 */
.job-switch { position: relative; display: inline-block; width: 36px; height: 20px; }
.job-switch input { opacity: 0; width: 0; height: 0; }
.job-switch i { position: absolute; inset: 0; background: #d1d5db; border-radius: 20px; cursor: pointer; transition: 0.2s; }
.job-switch i:before { content: ''; position: absolute; width: 16px; height: 16px; left: 2px; top: 2px; background: #fff; border-radius: 50%; transition: 0.2s; }
.job-switch input:checked + i { background: var(--dt-primary); }
.job-switch input:checked + i:before { transform: translateX(16px); }

/* 弹窗 */
.job-modal-mask { position: fixed; inset: 0; background: rgba(15,23,42,0.4); display: flex; align-items: center; justify-content: center; z-index: 200; }
.job-modal { background: #fff; border-radius: 14px; width: 420px; max-width: 92vw; padding: 20px; box-shadow: 0 20px 60px rgba(15,23,42,0.25); }
.job-modal-title { font-size: 15px; font-weight: 700; margin-bottom: 14px; }
.job-field { margin-bottom: 10px; }
.job-row { display: flex; gap: 12px; }
.job-row > .job-field { flex: 1; }
.job-lab { display: block; font-size: 12px; color: #6b7280; margin-bottom: 4px; }
.req { color: #dc2626; }
.job-err { color: #dc2626; font-size: 12px; margin: 6px 0; }
.job-ok { color: #16a34a; font-size: 12px; margin: 6px 0; }
.job-modal-ops { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
