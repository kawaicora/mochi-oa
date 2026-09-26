<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import UserAvatar from './UserAvatar.vue'
import type { Department, Group, OrgMember, FriendItem } from '@shared/server-types'

const app = useAppStore()
const srv = useServerStore()
const myId = computed(() => srv.state.userId)

// 公司切换
const companyMenu = ref(false)
const showJoinCode = ref(false)
function isMainGroup(g: Group): boolean {
  return typeof g.name === 'string' && g.name.endsWith('总群')
}

// 部门树
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
const openDept = ref<Set<number>>(new Set())
function toggleDept(id: number): void {
  const s = new Set(openDept.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  openDept.value = s
}

// 弹窗状态
const showCreateCompany = ref(false)
const showJoinCompany = ref(false)
const showCreateDept = ref(false)
const showCreateGroup = ref(false)
const showJoinGroup = ref(false)
const showAddFriend = ref(false)
const memberMenu = ref<{ user: OrgMember; x: number; y: number } | null>(null)
const groupMenu = ref<{ group: Group; x: number; y: number } | null>(null)

// 表单
const newCompanyName = ref('')
const joinCompanyCode = ref('')
const newDeptName = ref('')
const newGroupName = ref('')
const joinGroupCode = ref('')
const friendKeyword = ref('')
const friendResults = ref<Array<{ id: number; username: string; nick?: string; avatar?: string }>>([])
const friendSearching = ref(false)
const promptMsg = ref('')

async function run(fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  promptMsg.value = ''
  const r = await fn()
  if (!r.ok) promptMsg.value = r.error || '操作失败'
}

async function doCreateCompany(): Promise<void> {
  if (!newCompanyName.value.trim()) return
  await run(() => app.createCompany(newCompanyName.value.trim()))
  if (!promptMsg.value) {
    showCreateCompany.value = false
    newCompanyName.value = ''
  }
}
async function doJoinCompany(): Promise<void> {
  if (!joinCompanyCode.value.trim()) return
  await run(() => app.joinCompany(joinCompanyCode.value.trim()))
  if (!promptMsg.value) {
    showJoinCompany.value = false
    joinCompanyCode.value = ''
  }
}
async function doCreateDept(): Promise<void> {
  if (!newDeptName.value.trim()) return
  await run(() => app.createDepartment(newDeptName.value.trim()))
  if (!promptMsg.value) {
    showCreateDept.value = false
    newDeptName.value = ''
  }
}
async function doCreateGroup(): Promise<void> {
  if (!newGroupName.value.trim()) return
  await run(() => app.createGroup(newGroupName.value.trim()))
  if (!promptMsg.value) {
    showCreateGroup.value = false
    newGroupName.value = ''
  }
}
async function doJoinGroup(): Promise<void> {
  if (!joinGroupCode.value.trim()) return
  await run(() => app.joinGroup(joinGroupCode.value.trim()))
  if (!promptMsg.value) {
    showJoinGroup.value = false
    joinGroupCode.value = ''
  }
}
async function doSearchFriend(): Promise<void> {
  const k = friendKeyword.value.trim()
  if (!k) {
    friendResults.value = []
    return
  }
  friendSearching.value = true
  promptMsg.value = ''
  try {
    friendResults.value = await app.searchUsers(k)
  } catch {
    friendResults.value = []
    promptMsg.value = '搜索失败，请重试'
  } finally {
    friendSearching.value = false
  }
}
async function doAddFriendUser(u: { id: number; username: string; nick?: string }): Promise<void> {
  await run(() => app.addFriend(u.id))
  if (!promptMsg.value) {
    showAddFriend.value = false
    friendResults.value = []
    friendKeyword.value = ''
  }
}

// 成员 / 群 右键操作
function openMemberMenu(e: MouseEvent, user: OrgMember): void {
  e.preventDefault()
  memberMenu.value = { user, x: e.clientX, y: e.clientY }
}
function openGroupMenu(e: MouseEvent, group: Group): void {
  e.preventDefault()
  groupMenu.value = { group, x: e.clientX, y: e.clientY }
}
function closeMenus(): void {
  memberMenu.value = null
  groupMenu.value = null
}
async function doKickMember(userId: number): Promise<void> {
  closeMenus()
  await run(() => app.kickMember(userId))
}
async function doSetAdmin(userId: number, role: 'admin' | 'member'): Promise<void> {
  closeMenus()
  await run(() => app.setMemberRole(userId, role))
}
async function doLeaveGroup(groupId: number): Promise<void> {
  closeMenus()
  await run(() => app.leaveGroup(groupId))
}
async function removeFriendCtx(_e: MouseEvent, f: FriendItem): Promise<void> {
  await run(() => app.removeFriend(f.userId))
}
</script>

<template>
  <section class="contacts-panel" @click="closeMenus">
    <!-- 公司切换 -->
    <div class="company-bar">
      <button class="company-switch" @click.stop="companyMenu = !companyMenu">
        <span class="company-name">{{ app.activeCompany?.name || '未加入公司' }}</span>
        <i class="fas fa-caret-down"></i>
      </button>
      <span v-if="app.isAdmin && app.activeCompany" class="company-join">
        <button class="company-code-toggle" @click.stop="showJoinCode = !showJoinCode">
          <i class="fas fa-qrcode"></i> {{ showJoinCode ? '隐藏加入码' : '查看加入码' }}
        </button>
        <span v-if="showJoinCode" class="company-code-val" @click.stop>{{ app.activeCompany?.code || '—' }}</span>
      </span>
      <div v-if="companyMenu" class="company-dropdown">
        <button
          v-for="c in app.companies"
          :key="c.company.id"
          class="company-opt"
          :class="{ active: c.company.id === app.activeCompanyId }"
          @click="app.switchCompany(c.company.id); companyMenu = false"
        >{{ c.company.name }}（{{ app.roleLabel(c.role) }}）</button>
        <div class="company-drop-actions">
          <button @click="showCreateCompany = true; companyMenu = false"><i class="fas fa-plus"></i> 创建公司</button>
          <button @click="showJoinCompany = true; companyMenu = false"><i class="fas fa-sign-in-alt"></i> 加入公司</button>
        </div>
      </div>
    </div>

    <div class="contacts-scroll">
      <!-- 组织架构 -->
      <div class="sec">
        <div class="sec-head">
          <span class="sec-title"><i class="fas fa-building"></i> 组织架构</span>
          <button v-if="app.isAdmin" class="sec-add" title="创建部门" @click="showCreateDept = true"><i class="fas fa-plus"></i></button>
        </div>
        <div v-if="tree.length" class="dept-tree">
          <div v-for="dept in tree" :key="dept.id" class="dept-node">
            <div class="dept-row" @click="toggleDept(dept.id)">
              <i class="fas" :class="openDept.has(dept.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
              <i class="fas fa-folder"></i>
              <span>{{ dept.name }}</span>
            </div>
            <div v-if="openDept.has(dept.id)" class="dept-children">
              <template v-if="dept.children.length">
                <div v-for="child in dept.children" :key="child.id" class="dept-row child"><i class="fas fa-folder"></i><span>{{ child.name }}</span></div>
              </template>
              <div v-else class="dept-hint">（空部门）</div>
            </div>
          </div>
        </div>
        <div v-else class="dept-hint">暂无部门</div>
      </div>

      <!-- 公司成员 -->
      <div class="sec">
        <div class="sec-head">
          <span class="sec-title"><i class="fas fa-users"></i> 成员（{{ app.members.length }}）</span>
        </div>
        <div class="member-list">
          <div
            v-for="m in app.members"
            :key="m.userId"
            class="member-row"
            :class="{ me: m.userId === myId }"
            @contextmenu.prevent="openMemberMenu($event, m)"
            @click="app.openDm(m.userId, m.nick || m.username)"
          >
            <UserAvatar :nick="m.nick || m.username" :avatar="m.avatar" :size="36" />
            <div class="member-info">
              <div class="member-name">
                {{ m.nick || m.username }}
                <span v-if="m.role === 'owner'" class="tag owner">创建人</span>
                <span v-else-if="m.role === 'admin'" class="tag admin">管理员</span>
              </div>
              <div class="member-sub">
                <span class="dot" :class="{ off: !m.online }"></span>
                {{ m.online ? '在线' : '离线' }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 群聊 -->
      <div class="sec">
        <div class="sec-head">
          <span class="sec-title"><i class="fas fa-comments"></i> 群聊</span>
          <div class="sec-actions">
            <button class="sec-add" title="创建群" @click="showCreateGroup = true"><i class="fas fa-plus"></i></button>
            <button class="sec-add" title="加入群" @click="showJoinGroup = true"><i class="fas fa-sign-in-alt"></i></button>
          </div>
        </div>
        <div class="member-list">
          <div v-for="g in app.groups" :key="g.id" class="member-row" @contextmenu.prevent="openGroupMenu($event, g)" @click="app.openGroup(g.id, g.name)">
            <div class="member-av group">{{ g.name.slice(0, 1) }}</div>
            <div class="member-info">
              <div class="member-name">{{ g.name }}</div>
              <div v-if="!isMainGroup(g)" class="member-sub"><i class="fas fa-hashtag"></i> {{ g.code }}</div>
            </div>
          </div>
          <div v-if="app.groups.length === 0" class="dept-hint">暂无群</div>
        </div>
      </div>

      <!-- 好友 -->
      <div class="sec">
        <div class="sec-head">
          <span class="sec-title"><i class="far fa-heart"></i> 好友</span>
          <button class="sec-add" title="添加好友" @click="showAddFriend = true"><i class="fas fa-user-plus"></i></button>
        </div>
        <div class="member-list">
          <div
            v-for="f in app.friends"
            :key="f.userId"
            class="member-row"
            @contextmenu.prevent="removeFriendCtx($event, f)"
            @click="app.openDm(f.userId, f.nick || f.username)"
          >
            <UserAvatar :nick="f.nick || f.username" :avatar="f.avatar" :size="36" />
            <div class="member-info">
              <div class="member-name">{{ f.nick || f.username }}</div>
            </div>
          </div>
          <div v-if="app.friends.length === 0" class="dept-hint">暂无好友</div>
        </div>
      </div>
    </div>

    <!-- 成员右键菜单 -->
    <div v-if="memberMenu" class="ctx-menu" :style="{ left: memberMenu.x + 'px', top: memberMenu.y + 'px' }" @click.stop>
      <button class="ctx-item" @click="app.openDm(memberMenu.user.userId, memberMenu.user.nick || memberMenu.user.username); closeMenus()"><i class="fas fa-comment"></i> 发起私聊</button>
      <button v-if="app.isAdmin && memberMenu.user.userId !== myId" class="ctx-item" @click="doKickMember(memberMenu.user.userId)"><i class="fas fa-user-minus"></i> 移出公司</button>
      <button v-if="app.isAdmin && memberMenu.user.userId !== myId && memberMenu.user.role !== 'owner'" class="ctx-item" @click="doSetAdmin(memberMenu.user.userId, memberMenu.user.role === 'admin' ? 'member' : 'admin')">
        <i class="fas fa-user-cog"></i> {{ memberMenu.user.role === 'admin' ? '取消管理员' : '设为管理员' }}
      </button>
    </div>

    <!-- 群右键菜单 -->
    <div v-if="groupMenu" class="ctx-menu" :style="{ left: groupMenu.x + 'px', top: groupMenu.y + 'px' }" @click.stop>
      <button class="ctx-item" @click="app.openGroup(groupMenu.group.id, groupMenu.group.name); closeMenus()"><i class="fas fa-comment"></i> 打开群</button>
      <button class="ctx-item" @click="doLeaveGroup(groupMenu.group.id)"><i class="fas fa-sign-out-alt"></i> 退出群</button>
    </div>

    <div v-if="promptMsg" class="prompt-toast">{{ promptMsg }}</div>

    <!-- 弹窗们 -->
    <div v-if="showCreateCompany" class="modal-mask" @click.self="showCreateCompany = false">
      <div class="modal">
        <div class="modal-head">创建公司</div>
        <div class="modal-body"><input v-model="newCompanyName" class="modal-input" placeholder="公司名称" maxlength="64" /></div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showCreateCompany = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!newCompanyName.trim()" @click="doCreateCompany">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showJoinCompany" class="modal-mask" @click.self="showJoinCompany = false">
      <div class="modal">
        <div class="modal-head">加入公司</div>
        <div class="modal-body"><input v-model="joinCompanyCode" class="modal-input" placeholder="输入公司加入码" maxlength="32" /></div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showJoinCompany = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!joinCompanyCode.trim()" @click="doJoinCompany">加入</button>
        </div>
      </div>
    </div>

    <div v-if="showCreateDept" class="modal-mask" @click.self="showCreateDept = false">
      <div class="modal">
        <div class="modal-head">创建部门</div>
        <div class="modal-body"><input v-model="newDeptName" class="modal-input" placeholder="部门名称" maxlength="64" /></div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showCreateDept = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!newDeptName.trim()" @click="doCreateDept">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showCreateGroup" class="modal-mask" @click.self="showCreateGroup = false">
      <div class="modal">
        <div class="modal-head">创建群</div>
        <div class="modal-body"><input v-model="newGroupName" class="modal-input" placeholder="群名称" maxlength="64" /></div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showCreateGroup = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!newGroupName.trim()" @click="doCreateGroup">创建</button>
        </div>
      </div>
    </div>

    <div v-if="showJoinGroup" class="modal-mask" @click.self="showJoinGroup = false">
      <div class="modal">
        <div class="modal-head">加入群</div>
        <div class="modal-body"><input v-model="joinGroupCode" class="modal-input" placeholder="输入群加入码" maxlength="32" /></div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showJoinGroup = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!joinGroupCode.trim()" @click="doJoinGroup">加入</button>
        </div>
      </div>
    </div>

    <div v-if="showAddFriend" class="modal-mask" @click.self="showAddFriend = false">
      <div class="modal">
        <div class="modal-head">添加好友</div>
        <div class="modal-body">
          <div class="addf-row">
            <input v-model="friendKeyword" class="modal-input" placeholder="搜索用户 ID / 用户名 / 昵称" maxlength="64" @keyup.enter="doSearchFriend" />
            <button class="dt-btn dt-btn-primary addf-search" :disabled="friendSearching" @click="doSearchFriend"><i class="fas fa-search"></i></button>
          </div>
          <div class="addf-results">
            <div v-if="friendSearching" class="addf-hint">搜索中…</div>
            <template v-else-if="friendResults.length">
              <div v-for="u in friendResults" :key="u.id" class="addf-item">
                <UserAvatar :nick="u.nick || u.username" :avatar="u.avatar" :size="30" />
                <div class="member-info">
                  <div class="member-name">{{ u.nick || u.username }}</div>
                  <div class="member-sub">@{{ u.username }} · ID {{ u.id }}</div>
                </div>
                <button class="dt-btn dt-btn-primary" @click="doAddFriendUser(u)">添加</button>
              </div>
            </template>
            <div v-else-if="friendKeyword.trim()" class="addf-hint">未找到匹配用户</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showAddFriend = false">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.contacts-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #fff;
  border-right: 1px solid var(--dt-border-light);
  position: relative;
}
.company-join { display: inline-flex; align-items: center; gap: 6px; margin-left: 8px; }
.company-code-toggle {
  background: #1f2532;
  border: 1px solid #2d3340;
  color: #9aa4b2;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.company-code-toggle:hover { color: #1677ff; border-color: #1677ff; }
.company-code-val {
  background: #0d1117;
  border: 1px dashed #1677ff;
  color: #1677ff;
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  font-weight: 600;
  letter-spacing: 1px;
}
.company-bar {
  flex-shrink: 0;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dt-border-light);
  position: relative;
}
.company-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font-size: 16px;
  font-weight: 600;
  color: var(--dt-text);
}
.company-name {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.company-dropdown {
  position: absolute;
  top: 48px;
  left: 12px;
  right: 12px;
  background: #fff;
  border: 1px solid var(--dt-border-light);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  z-index: 40;
  padding: 6px;
}
.company-opt {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-radius: 6px;
  font-size: 14px;
  color: var(--dt-text);
}
.company-opt:hover {
  background: var(--dt-hover);
}
.company-opt.active {
  background: var(--dt-active);
  color: var(--dt-primary);
}
.company-drop-actions {
  border-top: 1px solid var(--dt-border-light);
  margin-top: 4px;
  padding-top: 6px;
  display: flex;
  gap: 6px;
}
.company-drop-actions button {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--dt-text-2);
}
.company-drop-actions button:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.contacts-scroll {
  flex: 1;
  overflow-y: auto;
}
.sec {
  padding: 12px 8px;
  border-bottom: 1px solid var(--dt-border-light);
}
.sec-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 6px 6px;
}
.sec-title {
  font-size: 13px;
  color: var(--dt-text-3);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sec-actions {
  display: flex;
  gap: 4px;
}
.sec-add {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sec-add:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.dept-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 6px;
  border-radius: 6px;
  font-size: 14px;
  color: var(--dt-text);
  cursor: pointer;
}
.dept-row:hover {
  background: var(--dt-hover);
}
.dept-row .fa-folder {
  color: var(--dt-text-3);
}
.dept-children {
  margin-left: 18px;
}
.dept-row.child {
  font-size: 13px;
  color: var(--dt-text-2);
}
.dept-hint {
  font-size: 12px;
  color: var(--dt-text-4);
  padding: 6px 8px;
}
.member-list {
  padding: 0 2px;
}
.member-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.member-row:hover {
  background: var(--dt-hover);
}
.member-av {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, #0089ff, #5cb6ff);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
}
.member-av.group {
  background: linear-gradient(135deg, #00b0a0, #33c0b0);
}
.member-av.friend {
  background: linear-gradient(135deg, #6b7bff, #9aa5ff);
}
.member-info {
  flex: 1;
  min-width: 0;
}
.member-name {
  font-size: 14px;
  color: var(--dt-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.member-sub {
  font-size: 12px;
  color: var(--dt-text-3);
  display: flex;
  align-items: center;
  gap: 5px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dt-success);
  display: inline-block;
}
.dot.off {
  background: var(--dt-text-4);
}
.tag {
  font-size: 11px;
  border: 1px solid currentColor;
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 6px;
}
.tag.owner {
  color: var(--dt-danger);
}
.tag.admin {
  color: #7a5af5;
}
.ctx-menu {
  position: fixed;
  background: #fff;
  border: 1px solid var(--dt-border-light);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
  padding: 4px;
  z-index: 120;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--dt-text);
  width: 100%;
  text-align: left;
  white-space: nowrap;
}
.ctx-item:hover {
  background: var(--dt-hover);
}
.prompt-toast {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 6px;
  z-index: 200;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: 380px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}
.modal-head {
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--dt-border-light);
}
.modal-body {
  padding: 18px;
}
.modal-input {
  width: 100%;
  height: 38px;
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  padding: 0 12px;
  font-size: 14px;
  color: var(--dt-text);
  outline: none;
}
.modal-input:focus {
  border-color: var(--dt-primary);
}
.modal-foot {
  padding: 12px 18px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--dt-border-light);
}
.addf-row { display: flex; gap: 8px; }
.addf-search { flex-shrink: 0; }
.addf-results { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; max-height: 40vh; overflow-y: auto; }
.addf-item { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; background: var(--dt-hover, #f5f7fa); }
.addf-hint { font-size: 13px; color: var(--dt-text-4); text-align: center; padding: 12px 0; }
</style>
