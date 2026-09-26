<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import UserAvatar from './UserAvatar.vue'
import type { Department, OrgMember } from '@shared/server-types'

const app = useAppStore()
const srv = useServerStore()
const myId = computed(() => srv.state.userId ?? 0)

const promptMsg = ref('')

// 人员详细信息（点击成员查看）
const detail = ref<OrgMember | null>(null)
function parseEmergency(extra?: string): Array<{ name: string; phone: string }> {
  if (!extra) return []
  try {
    const e = JSON.parse(extra)
    return Array.isArray(e?.emergency) ? e.emergency : []
  } catch {
    return []
  }
}
function openDetail(m: OrgMember): void {
  detail.value = m
}

interface DeptNode extends Department {
  children: DeptNode[]
}
const tree = computed<DeptNode[]>(() => {
  const map = new Map<number, DeptNode>()
  app.departments.forEach((d) => map.set(d.id, { ...d, children: [] }))
  const roots: DeptNode[] = []
  map.forEach((n) => {
    if (n.parentId != null && map.has(n.parentId)) map.get(n.parentId)!.children.push(n)
    else roots.push(n)
  })
  return roots
})

// 部门成员（懒加载）
const openDept = ref<Set<number>>(new Set())
const deptMembers = ref<Record<number, OrgMember[]>>({})
const loadingDept = ref<Record<number, boolean>>({})
async function toggleDept(id: number): Promise<void> {
  const s = new Set(openDept.value)
  if (s.has(id)) s.delete(id)
  else {
    s.add(id)
    if (deptMembers.value[id] === undefined) {
      loadingDept.value[id] = true
      deptMembers.value[id] = await app.loadDepartmentMembers(id)
      loadingDept.value[id] = false
    }
  }
  openDept.value = s
}
function deptMembersOf(id: number): OrgMember[] {
  return deptMembers.value[id] ?? []
}

// 通用确认弹窗
const confirmState = ref<{ title: string; msg: string; fn: () => Promise<void> } | null>(null)
function ask(title: string, msg: string, fn: () => Promise<void>): void {
  confirmState.value = { title, msg, fn }
}
async function doConfirm(): Promise<void> {
  const c = confirmState.value
  if (!c) return
  confirmState.value = null
  await c.fn()
}

// 刷新部门 + 已展开部门的成员
async function reload(): Promise<void> {
  await app.refreshDepartments()
  for (const id of openDept.value) deptMembers.value[id] = await app.loadDepartmentMembers(id)
}

// 添加人员弹窗（按用户名/昵称/ID 搜索候选，点击添加；自己则加入部门）
interface UserCandidate { id: number; username: string; nick?: string; avatar?: string }
const showAdd = ref(false)
const addKeyword = ref('')
const addDept = ref<number | ''>('')
const candidates = ref<UserCandidate[]>([])
const selected = ref<UserCandidate | null>(null)
const searching = ref(false)
const searched = ref(false)
function openAdd(dept?: number): void {
  showAdd.value = true
  addDept.value = dept ?? ''
  addKeyword.value = ''
  candidates.value = []
  selected.value = null
  searched.value = false
  promptMsg.value = ''
}
function confirmAdd(): void {
  if (!selected.value) return
  void addUser(selected.value)
}
async function doSearch(): Promise<void> {
  const k = addKeyword.value.trim()
  if (!k) { promptMsg.value = '请输入关键词'; return }
  searching.value = true
  searched.value = true
  candidates.value = await app.searchUsers(k)
  searching.value = false
}
async function addUser(u: UserCandidate): Promise<void> {
  if (u.id === myId.value) {
    if (addDept.value === '') { promptMsg.value = '请先选择部门，再把自己加入部门'; return }
    const r = await app.assignToDepartment(Number(addDept.value), u.id)
    if (!r.ok) { promptMsg.value = r.error || '加入失败'; return }
    promptMsg.value = '已将自己加入部门'
    showAdd.value = false
    await reload()
    return
  }
  const dept = addDept.value === '' ? undefined : Number(addDept.value)
  const r = await app.addCompanyMember(u.id, dept)
  if (!r.ok) { promptMsg.value = r.error || '添加失败'; return }
  promptMsg.value = '已添加'
  showAdd.value = false
  await reload()
}

// 移动部门弹窗
const moveState = ref<{ userId: number; name: string; fromDept: number } | null>(null)
const moveTo = ref<number | ''>('')
const moveDepts = computed(() => app.departments.filter((x) => x.id !== moveState.value?.fromDept))
function openMove(userId: number, name: string, fromDept: number): void {
  moveState.value = { userId, name, fromDept }
  moveTo.value = ''
}
async function doMove(): Promise<void> {
  const st = moveState.value
  if (!st) return
  const to = moveTo.value === '' ? null : Number(moveTo.value)
  if (to == null) { promptMsg.value = '请选择目标部门'; return }
  const r1 = await app.removeFromDepartment(st.fromDept, st.userId)
  const r2 = await app.assignToDepartment(to, st.userId)
  if (!r1.ok || !r2.ok) { promptMsg.value = r1.error || r2.error || '移动失败'; return }
  moveState.value = null
  promptMsg.value = '已移动'
  await reload()
}

// 移出本部门（确认）
function removeFromDept(userId: number, name: string, deptId: number, deptName: string): void {
  ask('移出部门', `确定将「${name}」移出部门「${deptName}」？`, async () => {
    const r = await app.removeFromDepartment(deptId, userId)
    if (!r.ok) { promptMsg.value = r.error || '操作失败'; return }
    promptMsg.value = '已移出部门'
    await reload()
  })
}
// 移出企业（确认）
function kick(userId: number, name: string): void {
  ask('移出企业', `确定将「${name}」移出企业？此操作不可撤销。`, async () => {
    const r = await app.kickMember(userId)
    if (!r.ok) { promptMsg.value = r.error || '操作失败'; return }
    promptMsg.value = '已移出企业'
    await reload()
  })
}
// 删除部门（确认）
function removeDept(deptId: number, name: string): void {
  ask('删除部门', `确定删除部门「${name}」？该部门下成员将从部门移除（仍留在企业）。`, async () => {
    const r = await app.deleteDepartment(deptId)
    if (!r.ok) { promptMsg.value = r.error || '操作失败'; return }
    promptMsg.value = '部门已删除'
    await reload()
  })
}

// 添加部门弹窗（企业内部操作，不与企业创建同级）
const showCreateDept = ref(false)
const newDeptName = ref('')
const parentDept = ref<number | ''>('')
function openCreateDept(): void {
  showCreateDept.value = true
  newDeptName.value = ''
  parentDept.value = ''
  promptMsg.value = ''
}
async function doCreateDept(): Promise<void> {
  const name = newDeptName.value.trim()
  if (!name) { promptMsg.value = '请输入部门名称'; return }
  const parent = parentDept.value === '' ? undefined : Number(parentDept.value)
  const r = await app.createDepartment(name, parent)
  if (!r.ok) { promptMsg.value = r.error || '创建失败'; return }
  showCreateDept.value = false
  promptMsg.value = '部门已创建'
  await reload()
}
</script>

<template>
  <div class="dept-admin">
    <div class="da-head">
      <span class="da-title"><i class="fas fa-sitemap"></i> 组织架构</span>
      <div class="da-ops">
        <button class="dt-btn" @click="openCreateDept"><i class="fas fa-folder-plus"></i> 添加部门</button>
        <button class="dt-btn dt-btn-primary" @click="openAdd()"><i class="fas fa-user-plus"></i> 添加人员</button>
      </div>
    </div>
    <div v-if="tree.length === 0" class="da-hint">暂无部门，点击右上角「添加部门」创建，或直接添加人员。</div>

    <div class="dept-tree">
      <div v-for="dept in tree" :key="dept.id" class="dept-node">
        <div class="dept-row" @click="toggleDept(dept.id)">
          <i class="fas" :class="openDept.has(dept.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
          <i class="fas fa-folder"></i>
          <span class="dept-name">{{ dept.name }}</span>
          <span class="dept-count">{{ deptMembersOf(dept.id).length }}</span>
          <span class="dept-ops" @click.stop>
            <button class="op-btn" title="添加成员到本部门" @click="openAdd(dept.id)"><i class="fas fa-user-plus"></i></button>
            <button class="op-btn danger" title="删除部门" @click="removeDept(dept.id, dept.name)"><i class="fas fa-trash"></i></button>
          </span>
        </div>
        <div v-if="openDept.has(dept.id)" class="dept-children">
          <div v-if="loadingDept[dept.id]" class="da-hint">加载中…</div>
          <template v-else>
            <div v-for="m in deptMembersOf(dept.id)" :key="m.userId" class="dept-member" @click="openDetail(m)">
              <UserAvatar :nick="m.nick || m.username" :avatar="m.avatar" :size="28" />
              <span class="m-name">{{ m.nick || m.username }}</span>
              <span v-if="m.role === 'owner' || m.role === 'admin'" class="m-tag">{{ m.role === 'owner' ? '创建人' : '管理员' }}</span>
              <span v-if="m.phone" class="m-phone">{{ m.phone }}</span>
              <span v-if="m.location" class="m-loc" title="登录归属地"><i class="fas fa-map-marker-alt"></i> {{ m.location }}</span>
              <span class="dept-ops" @click.stop>
                <button class="op-btn" title="移动部门" @click="openMove(m.userId, m.nick || m.username, dept.id)"><i class="fas fa-arrows-alt"></i></button>
                <button class="op-btn" title="移出本部门" @click="removeFromDept(m.userId, m.nick || m.username, dept.id, dept.name)"><i class="fas fa-user-minus"></i></button>
                <button class="op-btn danger" title="移出企业" @click="kick(m.userId, m.nick || m.username)"><i class="fas fa-user-slash"></i></button>
              </span>
            </div>
            <div v-if="deptMembersOf(dept.id).length === 0" class="da-hint">（空部门）</div>
          </template>
        </div>
      </div>
    </div>

    <!-- 添加部门弹窗 -->
    <div v-if="showCreateDept" class="modal-mask" @click.self="showCreateDept = false">
      <div class="modal">
        <div class="modal-head">添加部门</div>
        <div class="modal-body">
          <div class="fld">
            <label>部门名称</label>
            <input v-model="newDeptName" class="input" placeholder="部门名称" maxlength="64" @keyup.enter="doCreateDept" />
          </div>
          <div class="fld">
            <label>上级部门（可选，不选则为顶级部门）</label>
            <select v-model="parentDept" class="input">
              <option :value="''">— 作为顶级部门 —</option>
              <option v-for="d in app.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showCreateDept = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!newDeptName.trim()" @click="doCreateDept">创建</button>
        </div>
      </div>
    </div>

    <!-- 添加人员弹窗（候选列表） -->
    <div v-if="showAdd" class="modal-mask" @click.self="showAdd = false">
      <div class="modal">
        <div class="modal-head">添加人员</div>
        <div class="modal-body">
          <div class="add-search">
            <input v-model="addKeyword" class="input" placeholder="按用户名 / 昵称 / ID 搜索" maxlength="64" @keyup.enter="doSearch" />
            <button class="dt-btn" :disabled="!addKeyword.trim() || searching" @click="doSearch"><i class="fas fa-search"></i> 搜索</button>
          </div>
          <div class="fld">
            <label>加入部门（可选；把自己加入部门时必选）</label>
            <select v-model="addDept" class="input">
              <option :value="''">不分配部门</option>
              <option v-for="d in app.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </div>
          <div v-if="candidates.length" class="cand-list">
            <div v-for="u in candidates" :key="u.id" class="cand-row" :class="{ 'cand-selected': selected?.id === u.id }" @click="selected = u">
              <UserAvatar :nick="u.nick || u.username" :avatar="u.avatar" :size="30" />
              <span class="cand-name">{{ u.nick || u.username }}</span>
              <span class="cand-id">{{ u.username }} · ID {{ u.id }}</span>
              <span class="cand-add"><i class="fas fa-plus"></i></span>
            </div>
          </div>
          <div v-if="searching" class="da-hint">搜索中…</div>
          <div v-else-if="searched && addKeyword && candidates.length === 0" class="da-hint">未找到匹配用户</div>
          <div v-else-if="!searched" class="da-hint">输入用户名 / 昵称 / ID 后点击搜索，点选候选即可添加</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showAdd = false">关闭</button>
          <button class="dt-btn dt-btn-primary" :disabled="!selected" @click="confirmAdd"><i class="fas fa-check"></i> 确认添加</button>
        </div>
      </div>
    </div>

    <!-- 移动部门弹窗 -->
    <div v-if="moveState" class="modal-mask" @click.self="moveState = null">
      <div class="modal">
        <div class="modal-head">移动部门</div>
        <div class="modal-body">
          <p class="modal-desc">将「{{ moveState.name }}」移动到：</p>
          <select v-model="moveTo" class="input">
            <option :value="''">— 选择目标部门 —</option>
            <option v-for="d in moveDepts" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="moveState = null">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="moveTo === ''" @click="doMove">确认移动</button>
        </div>
      </div>
    </div>

    <!-- 人员详细信息弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal detail-modal">
        <div class="modal-head">人员详细信息</div>
        <div class="modal-body">
          <div class="d-header">
            <UserAvatar :nick="detail.nick || detail.username" :avatar="detail.avatar" :size="64" />
            <div class="d-id">
              <div class="d-name">
                {{ detail.nick || detail.username }}
                <span v-if="detail.role === 'owner' || detail.role === 'admin'" class="m-tag">{{ detail.role === 'owner' ? '创建人' : '管理员' }}</span>
              </div>
              <div class="d-sub">@{{ detail.username }} · ID {{ detail.userId }}</div>
              <div class="d-sub"><i class="fas fa-circle" :class="detail.online ? 'd-on' : 'd-off'"></i>&nbsp;{{ detail.online ? '在线' : '离线' }}</div>
              <div v-if="detail.location" class="d-sub"><i class="fas fa-map-marker-alt"></i>&nbsp;{{ detail.location }}</div>
            </div>
          </div>
          <div class="d-field" v-if="detail.phone">
            <label>手机号</label><span>{{ detail.phone }}</span>
          </div>
          <div class="d-field" v-else>
            <label>手机号</label><span class="d-none">未设置</span>
          </div>
          <div class="d-emg">
            <div class="d-sec"><i class="fas fa-phone-alt"></i>&nbsp;紧急联系人</div>
            <template v-if="parseEmergency(detail.extra).length">
              <div v-for="(e, i) in parseEmergency(detail.extra)" :key="i" class="d-emg-row">
                <span class="d-emg-i">{{ i + 1 }}</span>
                <span class="d-emg-name">{{ e.name || '—' }}</span>
                <span class="d-emg-phone">{{ e.phone || '—' }}</span>
              </div>
            </template>
            <div v-else class="d-sub">未设置</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 通用确认弹窗 -->
    <div v-if="confirmState" class="modal-mask" @click.self="confirmState = null">
      <div class="modal confirm">
        <div class="modal-head">{{ confirmState.title }}</div>
        <div class="modal-body"><p class="modal-desc">{{ confirmState.msg }}</p></div>
        <div class="modal-foot">
          <button class="dt-btn" @click="confirmState = null">取消</button>
          <button class="dt-btn dt-btn-danger" @click="doConfirm">确定</button>
        </div>
      </div>
    </div>

    <div v-if="promptMsg" class="prompt-toast">{{ promptMsg }}</div>
  </div>
</template>

<style scoped>
.dept-admin { margin-top: 12px; background: #fff; border-radius: 10px; padding: 14px 16px; }
.da-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.da-ops { display: inline-flex; gap: 8px; }
.da-title { font-size: 14px; font-weight: 600; color: var(--dt-text); display: flex; align-items: center; gap: 8px; }
.da-hint { font-size: 13px; color: var(--dt-text-4); padding: 6px 0; }
.dept-tree { display: flex; flex-direction: column; gap: 4px; }
.dept-node { border-radius: 8px; }
.dept-row { display: flex; align-items: center; gap: 8px; padding: 8px 8px; border-radius: 8px; cursor: pointer; }
.dept-row:hover { background: var(--dt-hover); }
.dept-name { flex: 1; min-width: 0; font-size: 14px; color: var(--dt-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dept-count { font-size: 11px; color: var(--dt-text-4); background: var(--dt-bg-app, #f5f6f7); border-radius: 8px; padding: 1px 7px; }
.dept-ops { display: inline-flex; gap: 4px; }
.op-btn { width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--dt-border-light); background: #fff; color: var(--dt-text-3); font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.op-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.op-btn.danger:hover { border-color: var(--dt-danger); color: var(--dt-danger); }
.dept-children { margin-left: 22px; padding-left: 10px; border-left: 1px solid var(--dt-border-light); }
.dept-member { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; }
.dept-member:hover { background: var(--dt-hover); }
.m-name { flex: 1; min-width: 0; font-size: 13px; color: var(--dt-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-tag { font-size: 11px; color: #7a5af5; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
.m-phone { font-size: 12px; color: var(--dt-text-3); flex-shrink: 0; }
.m-loc { font-size: 12px; color: var(--dt-text-4); flex-shrink: 0; display: inline-flex; align-items: center; gap: 3px; }
/* 人员详细信息 */
.detail-modal { width: 420px; }
.d-header { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
.d-id { flex: 1; min-width: 0; }
.d-name { font-size: 16px; font-weight: 600; color: var(--dt-text); display: flex; align-items: center; gap: 8px; }
.d-sub { font-size: 13px; color: var(--dt-text-4); margin-top: 4px; }
.d-on { color: var(--dt-success, #34c759); }
.d-off { color: var(--dt-text-4); }
.d-field { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--dt-border-light); }
.d-field label { width: 90px; font-size: 13px; color: var(--dt-text-3); }
.d-field span { font-size: 13px; color: var(--dt-text); }
.d-none { color: var(--dt-text-4) !important; }
.d-emg { margin-top: 14px; }
.d-sec { font-size: 13px; font-weight: 600; color: var(--dt-text); margin-bottom: 8px; }
.d-emg-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.d-emg-i { width: 20px; height: 20px; border-radius: 50%; background: var(--dt-bg-app, #f5f6f7); color: var(--dt-text-3); font-size: 12px; display: inline-flex; align-items: center; justify-content: center; }
.d-emg-name { flex: 1; font-size: 13px; color: var(--dt-text); }
.d-emg-phone { font-size: 13px; color: var(--dt-text-2); }
.modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 150; }
.modal { width: 460px; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18); overflow: hidden; }
.modal-head { padding: 16px 20px; font-size: 15px; font-weight: 600; color: var(--dt-text); border-bottom: 1px solid var(--dt-border-light); }
.modal-body { padding: 18px 20px; }
.modal-desc { font-size: 13px; color: var(--dt-text-3); margin: 0 0 10px; }
.add-search { display: flex; gap: 8px; }
.fld { margin-top: 12px; }
.fld label { display: block; font-size: 12px; color: var(--dt-text-4); margin-bottom: 6px; }
.input { width: 100%; height: 38px; border: 1px solid var(--dt-border); border-radius: 6px; padding: 0 12px; font-size: 14px; color: var(--dt-text); outline: none; background: #fff; }
.input:focus { border-color: var(--dt-primary); }
.cand-list { margin-top: 12px; max-height: 220px; overflow-y: auto; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.cand-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; cursor: pointer; }
.cand-row:hover { background: var(--dt-hover); }
.cand-selected { background: var(--dt-hover); outline: 1px solid var(--dt-primary); }
.cand-name { font-size: 14px; color: var(--dt-text); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cand-id { flex: 1; font-size: 12px; color: var(--dt-text-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cand-add { color: var(--dt-primary); font-size: 14px; }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--dt-border-light); }
.dt-btn { height: 34px; padding: 0 16px; border-radius: 6px; font-size: 13px; border: 1px solid var(--dt-border); background: #fff; color: var(--dt-text-2); cursor: pointer; }
.dt-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.dt-btn-primary { background: var(--dt-primary); color: #fff; border-color: var(--dt-primary); }
.dt-btn-primary:hover { color: #fff; }
.dt-btn-danger { background: var(--dt-danger, #e34d59); color: #fff; border-color: var(--dt-danger, #e34d59); }
.dt-btn-danger:hover { color: #fff; opacity: 0.9; }
.dt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.prompt-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 13px; padding: 8px 16px; border-radius: 6px; z-index: 220; }
</style>
