<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import { useRtcStore } from '../stores/rtc'
import UserAvatar from './UserAvatar.vue'
import DeptAdmin from './DeptAdmin.vue'
import type { OrgMember, Group, FriendItem } from '@shared/server-types'
import type { ContactsScope } from './ContactsNav.vue'

const props = defineProps<{ scope: ContactsScope; deptId: number | null }>()

const app = useAppStore()
const srv = useServerStore()
const rtc = useRtcStore()
const myId = computed(() => srv.state.userId)

const promptMsg = ref('')
const showJoinCode = ref(false)
const companyTransferPick = ref(false)

async function doTransferCompany(u: OrgMember): Promise<void> {
  const c = app.activeCompany
  if (!c) return
  if (!window.confirm(`确定将「${c.name}」转让给 ${u.nick || u.username}？转让后你将成为管理员。`)) return
  companyTransferPick.value = false
  await run(() => app.transferCompanyOwner(c.id, u.userId))
}
async function doDissolveCompany(): Promise<void> {
  const c = app.activeCompany
  if (!c) return
  if (!window.confirm('解散该公司将删除其所有部门、群与消息且不可恢复，确定解散？')) return
  await run(() => app.dissolveCompany(c.id))
}

// 表单
const newCompanyName = ref('')
const joinCompanyCode = ref('')
const newGroupName = ref('')
const joinGroupCode = ref('')
const createGroupDept = ref<number>(0)
const friendKeyword = ref('')
const friendResults = ref<Array<{ id: number; username: string; nick?: string; avatar?: string }>>([])
const friendSearching = ref(false)
const showCreateCompany = ref(false)
const showJoinCompany = ref(false)
const showCreateDept = ref(false)
const showCreateGroup = ref(false)
const showJoinGroup = ref(false)

// 成员右键菜单
const memberMenu = ref<{ user: OrgMember; x: number; y: number } | null>(null)
const groupMenu = ref<{ group: Group; x: number; y: number } | null>(null)

async function run(fn: () => Promise<{ ok: boolean; error?: string }>): Promise<boolean> {
  promptMsg.value = ''
  const r = await fn()
  if (!r.ok) { promptMsg.value = r.error || '操作失败'; return false }
  return true
}
async function doCreateCompany(): Promise<void> {
  if (!newCompanyName.value.trim()) return
  if (await run(() => app.createCompany(newCompanyName.value.trim()))) { showCreateCompany.value = false; newCompanyName.value = '' }
}
async function doJoinCompany(): Promise<void> {
  if (!joinCompanyCode.value.trim()) return
  if (await run(() => app.joinCompany(joinCompanyCode.value.trim()))) { showJoinCompany.value = false; joinCompanyCode.value = '' }
}
async function doCreateGroup(): Promise<void> {
  if (!newGroupName.value.trim()) return
  const dept = createGroupDept.value === 0 ? undefined : Number(createGroupDept.value)
  if (await run(() => app.createGroup(newGroupName.value.trim(), dept))) { showCreateGroup.value = false; newGroupName.value = '' }
}
async function doJoinGroup(): Promise<void> {
  if (!joinGroupCode.value.trim()) return
  if (await run(() => app.joinGroup(joinGroupCode.value.trim()))) { showJoinGroup.value = false; joinGroupCode.value = '' }
}
async function doSearchFriend(): Promise<void> {
  const k = friendKeyword.value.trim()
  if (!k) { friendResults.value = []; return }
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
  if (await run(() => app.addFriend(u.id))) {
    promptMsg.value = `已添加 ${u.nick || u.username}`
    friendResults.value = []
    friendKeyword.value = ''
  }
}

// 右键
function openMemberMenu(e: MouseEvent, user: OrgMember): void { e.preventDefault(); memberMenu.value = { user, x: e.clientX, y: e.clientY } }
function openGroupMenu(e: MouseEvent, group: Group): void { e.preventDefault(); groupMenu.value = { group, x: e.clientX, y: e.clientY } }
function closeMenus(): void { memberMenu.value = null; groupMenu.value = null }
async function doKickMember(userId: number): Promise<void> { closeMenus(); await run(() => app.kickMember(userId)) }
async function doSetAdmin(userId: number, role: 'admin' | 'member'): Promise<void> { closeMenus(); await run(() => app.setMemberRole(userId, role)) }
async function doLeaveGroup(groupId: number): Promise<void> { closeMenus(); await run(() => app.leaveGroup(groupId)) }
async function removeFriendCtx(_e: MouseEvent, f: { userId: number }): Promise<void> { await run(() => app.removeFriend(f.userId)) }
const friendMenu = ref<{ f: FriendItem; x: number; y: number } | null>(null)
function openFriendMenu(e: MouseEvent, f: FriendItem): void { e.preventDefault(); friendMenu.value = { f, x: e.clientX, y: e.clientY } }
function closeFriendMenu(): void { friendMenu.value = null }
const friendConfirm = ref<FriendItem | null>(null)
async function doRemoveFriend(): Promise<void> {
  const f = friendConfirm.value
  if (!f) return
  friendConfirm.value = null
  await run(() => app.removeFriend(f.userId))
}
function isMainGroup(g: Group): boolean { return typeof g.name === 'string' && g.name.endsWith('总群') }

// 组织架构：选中部门名 + 该部门群
const deptName = computed(() => {
  if (props.deptId == null) return ''
  const d = app.departments.find((x) => x.id === props.deptId)
  return d?.name ?? ''
})
const deptGroups = computed(() => (props.deptId == null ? [] : app.groups.filter((g) => g.departmentId === props.deptId)))
</script>

<template>
  <div class="c-content" @click="closeMenus">
    <!-- 组织架构：成员 -->
    <template v-if="scope === 'org'">
      <div class="content-head">
        <i class="fas fa-briefcase"></i>
        <span class="content-title">{{ app.activeCompany?.name || '未加入公司' }} · 组织架构</span>
        <span v-if="deptId != null" class="crumb">/ {{ deptName }}</span>
        <span v-if="app.isAdmin && app.activeCompany" class="company-join">
          <button class="company-code-toggle" @click.stop="showJoinCode = !showJoinCode"><i class="fas fa-qrcode"></i> {{ showJoinCode ? '隐藏加入码' : '查看加入码' }}</button>
          <span v-if="showJoinCode" class="company-code-val" @click.stop>{{ app.activeCompany?.code || '—' }}</span>
        </span>
        <span v-if="app.isOwner && app.activeCompany" class="company-join">
          <button class="company-code-toggle" @click.stop="companyTransferPick = true"><i class="fas fa-share"></i> 转让</button>
          <button class="company-code-toggle danger" @click.stop="doDissolveCompany"><i class="fas fa-trash-alt"></i> 解散</button>
        </span>
      </div>
      <div class="content-scroll">
        <DeptAdmin v-if="app.isAdmin" />
        <div v-if="deptId != null && deptGroups.length" class="group-block">
          <div class="block-title"><i class="fas fa-comments"></i> 部门群组（{{ deptGroups.length }}）</div>
          <div v-for="g in deptGroups" :key="g.id" class="grow" @contextmenu.prevent="openGroupMenu($event, g)" @click="app.openGroup(g.id, g.name)">
            <div class="g-av group">{{ g.name.slice(0, 1) }}</div>
            <div class="g-name">{{ g.name }}</div>
            <div v-if="!isMainGroup(g)" class="g-code"><i class="fas fa-hashtag"></i> {{ g.code }}</div>
          </div>
        </div>

        <div class="block-title">成员（{{ app.members.length }}）</div>
        <div class="member-list">
          <div v-for="m in app.members" :key="m.userId" class="member-row" :class="{ me: m.userId === myId }"
               @contextmenu.prevent="openMemberMenu($event, m)" @click="app.openDm(m.userId, m.nick || m.username)">
            <UserAvatar :nick="m.nick || m.username" :avatar="m.avatar" :size="36" />
            <div class="member-info">
              <div class="member-name">{{ m.nick || m.username }}
                <span v-if="m.role === 'owner'" class="tag owner">创建人</span>
                <span v-else-if="m.role === 'admin'" class="tag admin">管理员</span>
              </div>
              <div class="member-sub"><span class="dot" :class="{ off: !m.online }"></span>{{ m.online ? '在线' : '离线' }}</div>
            </div>
          </div>
          <div v-if="app.members.length === 0" class="hint">暂无成员</div>
        </div>

        <div class="block-title">群聊（{{ app.groups.length }}）</div>
        <div class="member-list">
          <div v-for="g in app.groups" :key="g.id" class="member-row" @contextmenu.prevent="openGroupMenu($event, g)" @click="app.openGroup(g.id, g.name)">
            <div class="member-av group">{{ g.name.slice(0, 1) }}</div>
            <div class="member-info">
              <div class="member-name">{{ g.name }}</div>
              <div v-if="!isMainGroup(g)" class="member-sub"><i class="fas fa-hashtag"></i> {{ g.code }}</div>
            </div>
          </div>
          <div v-if="app.groups.length === 0" class="hint">暂无群</div>
        </div>
      </div>
    </template>

    <!-- 我的好友 -->
    <template v-else-if="scope === 'friends'">
      <div class="content-head"><i class="far fa-heart"></i><span class="content-title">我的好友</span></div>
      <div class="content-scroll">
        <div class="member-list">
          <div v-for="f in app.friends" :key="f.userId" class="member-row"
               @contextmenu.prevent="openFriendMenu($event, f)" @click="app.openDm(f.userId, f.nick || f.username)">
            <UserAvatar :nick="f.nick || f.username" :avatar="f.avatar" :size="36" />
            <div class="member-info">
              <div class="member-name">{{ f.nick || f.username }}</div>
              <div class="member-sub"><i class="fas fa-user"></i> {{ f.username }}</div>
            </div>
          </div>
          <div v-if="app.friends.length === 0" class="hint">暂无好友，可在「新的好友」中添加</div>
        </div>
      </div>
    </template>

    <!-- 新的好友 -->
    <template v-else-if="scope === 'newfriend'">
      <div class="content-head"><i class="fas fa-user-plus"></i><span class="content-title">新的好友</span></div>
      <div class="content-scroll">
        <div class="form-block">
          <div class="form-row">
            <input v-model="friendKeyword" class="input" placeholder="搜索用户 ID / 用户名 / 昵称" maxlength="64" @keyup.enter="doSearchFriend" />
            <button class="dt-btn dt-btn-primary" :disabled="friendSearching" @click="doSearchFriend"><i class="fas fa-search"></i> 搜索</button>
          </div>
          <div class="form-hint">支持用户 ID、用户名、昵称搜索，选择目标后添加为好友。</div>
          <div class="friend-results">
            <div v-if="friendSearching" class="hint pad">搜索中…</div>
            <template v-else-if="friendResults.length">
              <div v-for="u in friendResults" :key="u.id" class="member-row" style="cursor:default">
                <UserAvatar :nick="u.nick || u.username" :avatar="u.avatar" :size="36" />
                <div class="member-info">
                  <div class="member-name">{{ u.nick || u.username }}</div>
                  <div class="member-sub">@{{ u.username }} · ID {{ u.id }}</div>
                </div>
                <button class="dt-btn dt-btn-primary" @click="doAddFriendUser(u)"><i class="fas fa-user-plus"></i> 添加</button>
              </div>
            </template>
            <div v-else-if="friendKeyword.trim()" class="hint pad">未找到匹配用户</div>
          </div>
        </div>
      </div>
    </template>

    <!-- 企业/团队邀请 -->
    <template v-else-if="scope === 'invites'">
      <div class="content-head"><i class="far fa-envelope"></i><span class="content-title">企业/团队邀请</span></div>
      <div class="content-scroll"><div class="hint pad">邀请功能建设中，请在企业管理端处理入职邀请。</div></div>
    </template>

    <!-- 创建或加入企业/团队 -->
    <template v-else-if="scope === 'create'">
      <div class="content-head"><i class="fas fa-building"></i><span class="content-title">创建或加入企业/团队</span></div>
      <div class="content-scroll">
        <div class="card">
          <div class="card-title"><i class="fas fa-plus"></i> 创建企业/团队</div>
          <div class="form-row">
            <input v-model="newCompanyName" class="input" placeholder="企业/团队名称" maxlength="64" />
            <button class="dt-btn dt-btn-primary" :disabled="!newCompanyName.trim()" @click="doCreateCompany">创建</button>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><i class="fas fa-sign-in-alt"></i> 加入企业/团队</div>
          <div class="form-row">
            <input v-model="joinCompanyCode" class="input" placeholder="输入企业加入码" maxlength="32" />
            <button class="dt-btn dt-btn-primary" :disabled="!joinCompanyCode.trim()" @click="doJoinCompany">加入</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 群聊（独立：不在公司内也可创建/加入群） -->
    <template v-else-if="scope === 'groups'">
      <div class="content-head"><i class="fas fa-users"></i><span class="content-title">群聊</span></div>
      <div class="content-scroll">
        <div class="card">
          <div class="card-title"><i class="fas fa-plus"></i> 创建群</div>
          <div class="form-row">
            <input v-model="newGroupName" class="input" placeholder="群名称" maxlength="64" />
            <button class="dt-btn dt-btn-primary" :disabled="!newGroupName.trim()" @click="doCreateGroup">创建</button>
          </div>
          <div v-if="app.departments.length" class="form-row" style="margin-top:10px">
            <select v-model="createGroupDept" class="input">
              <option :value="0">不挂部门</option>
              <option v-for="d in app.departments" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
          </div>
          <div class="form-hint">不在公司内也可以创建群；在公司内可将群挂到指定部门。</div>
        </div>
        <div class="card">
          <div class="card-title"><i class="fas fa-sign-in-alt"></i> 加入群</div>
          <div class="form-row">
            <input v-model="joinGroupCode" class="input" placeholder="输入群加入码" maxlength="32" />
            <button class="dt-btn dt-btn-primary" :disabled="!joinGroupCode.trim()" @click="doJoinGroup">加入</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 成员右键菜单 -->
    <div v-if="memberMenu" class="ctx-menu" :style="{ left: memberMenu.x + 'px', top: memberMenu.y + 'px' }" @click.stop>
      <button class="ctx-item" @click="app.openDm(memberMenu.user.userId, memberMenu.user.nick || memberMenu.user.username); closeMenus()"><i class="fas fa-comment"></i> 发起私聊</button>
      <button class="ctx-item" @click="rtc.startDmCall(memberMenu.user.userId, 'video'); closeMenus()"><i class="fas fa-phone"></i> 通话</button>
      <button v-if="app.isAdmin && memberMenu.user.userId !== myId" class="ctx-item" @click="doKickMember(memberMenu.user.userId)"><i class="fas fa-user-minus"></i> 移出企业</button>
      <button v-if="app.isAdmin && memberMenu.user.userId !== myId && memberMenu.user.role !== 'owner'" class="ctx-item" @click="doSetAdmin(memberMenu.user.userId, memberMenu.user.role === 'admin' ? 'member' : 'admin')">
        <i class="fas fa-user-cog"></i> {{ memberMenu.user.role === 'admin' ? '取消管理员' : '设为管理员' }}
      </button>
    </div>

    <!-- 好友右键菜单 -->
    <div v-if="friendMenu" class="ctx-menu" :style="{ left: friendMenu.x + 'px', top: friendMenu.y + 'px' }" @click.stop>
      <button class="ctx-item" @click="app.openDm(friendMenu.f.userId, friendMenu.f.nick || friendMenu.f.username); closeFriendMenu()"><i class="fas fa-comment"></i> 发起私信</button>
      <button class="ctx-item" @click="rtc.startDmCall(friendMenu.f.userId, 'video'); closeFriendMenu()"><i class="fas fa-phone"></i> 通话</button>
      <button class="ctx-item danger" @click="friendConfirm = friendMenu.f; closeFriendMenu()"><i class="fas fa-trash"></i> 删除好友</button>
    </div>

    <!-- 转让公司候选 -->
    <div v-if="companyTransferPick" class="t-mask" @click.self="companyTransferPick = false">
      <div class="t-card">
        <div class="t-head">转让「{{ app.activeCompany?.name }}」给
          <button class="t-close" @click="companyTransferPick = false"><i class="fas fa-times"></i></button>
        </div>
        <div v-for="u in app.members.filter((x) => x.userId !== myId)" :key="u.userId" class="t-item" @click="doTransferCompany(u)">
          <UserAvatar :nick="u.nick || u.username" :avatar="u.avatar" :size="30" />
          <span>{{ u.nick || u.username }}</span>
        </div>
        <div v-if="!app.members.filter((x) => x.userId !== myId).length" class="t-empty">没有可转让的成员</div>
      </div>
    </div>

    <!-- 删除好友二次确认 -->
    <div v-if="friendConfirm" class="modal-mask" @click.self="friendConfirm = null">
      <div class="modal confirm">
        <div class="modal-head">删除好友</div>
        <div class="modal-body"><p class="modal-desc">确定删除好友「{{ friendConfirm.nick || friendConfirm.username }}」？删除后需重新添加。</p></div>
        <div class="modal-foot">
          <button class="dt-btn" @click="friendConfirm = null">取消</button>
          <button class="dt-btn dt-btn-danger" @click="doRemoveFriend">确定删除</button>
        </div>
      </div>
    </div>

    <!-- 群右键菜单 -->
    <div v-if="groupMenu" class="ctx-menu" :style="{ left: groupMenu.x + 'px', top: groupMenu.y + 'px' }" @click.stop>
      <button class="ctx-item" @click="app.openGroup(groupMenu.group.id, groupMenu.group.name); closeMenus()"><i class="fas fa-comment"></i> 打开群</button>
      <button class="ctx-item" @click="doLeaveGroup(groupMenu.group.id)"><i class="fas fa-sign-out-alt"></i> 退出群</button>
    </div>

    <div v-if="promptMsg" class="prompt-toast">{{ promptMsg }}</div>
  </div>
</template>

<style scoped>
.c-content { flex: 1; min-width: 0; background: var(--dt-bg-app); display: flex; flex-direction: column; overflow: hidden; position: relative; }
.content-head {
  flex-shrink: 0; display: flex; align-items: center; gap: 8px;
  padding: 14px 18px; background: #fff; border-bottom: 1px solid var(--dt-border-light);
  color: var(--dt-primary); font-size: 15px;
}
.content-title { font-weight: 600; color: var(--dt-text); }
.crumb { font-weight: 400; color: var(--dt-text-3); font-size: 14px; }
.company-join { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.company-code-toggle {
  background: #fff; border: 1px solid var(--dt-border); color: var(--dt-text-3);
  font-size: 12px; padding: 3px 10px; border-radius: 6px; cursor: pointer;
}
.company-code-toggle:hover { color: var(--dt-primary); border-color: var(--dt-primary); }
.company-code-val {
  background: #f0f6ff; border: 1px dashed var(--dt-primary); color: var(--dt-primary);
  font-size: 12px; padding: 3px 10px; border-radius: 6px; font-weight: 600; letter-spacing: 1px;
}
.content-scroll { flex: 1; overflow-y: auto; padding: 14px 18px; }
.block-title { font-size: 13px; color: var(--dt-text-3); font-weight: 600; margin: 12px 0 8px; display: flex; align-items: center; gap: 6px; }
.group-block { margin-bottom: 6px; }
.grow { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; background: #fff; margin-bottom: 8px; cursor: pointer; }
.grow:hover { background: var(--dt-hover); }
.g-av { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #00b0a0, #33c0b0); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; }
.g-name { flex: 1; font-size: 14px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.g-code { font-size: 12px; color: var(--dt-text-3); }
.member-list { display: flex; flex-direction: column; gap: 2px; }
.member-row { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: 8px; cursor: pointer; background: #fff; }
.member-row:hover { background: var(--dt-hover); }
.member-row.me { background: var(--dt-active-weak, #f7faff); }
.member-av { width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #0089ff, #5cb6ff); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; }
.member-av.group { background: linear-gradient(135deg, #00b0a0, #33c0b0); }
.member-av.friend { background: linear-gradient(135deg, #6b7bff, #9aa5ff); }
.member-info { flex: 1; min-width: 0; }
.member-name { font-size: 14px; color: var(--dt-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.member-sub { font-size: 12px; color: var(--dt-text-3); display: flex; align-items: center; gap: 5px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dt-success); display: inline-block; }
.dot.off { background: var(--dt-text-4); }
.tag { font-size: 11px; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; margin-left: 6px; }
.tag.owner { color: var(--dt-danger); }
.tag.admin { color: #7a5af5; }
.hint { font-size: 13px; color: var(--dt-text-4); }
.hint.pad { padding: 20px; text-align: center; }
.form-block { max-width: 480px; }
.form-row { display: flex; gap: 8px; align-items: center; }
.input { flex: 1; height: 38px; border: 1px solid var(--dt-border); border-radius: 6px; padding: 0 12px; font-size: 14px; color: var(--dt-text); outline: none; background: #fff; }
.input:focus { border-color: var(--dt-primary); }
.form-hint { font-size: 12px; color: var(--dt-text-4); margin-top: 10px; }
.friend-results { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
.card { background: #fff; border-radius: 10px; padding: 16px; margin-bottom: 12px; max-width: 520px; }
.card-title { font-size: 14px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; color: var(--dt-text); }
.dt-btn { height: 36px; padding: 0 16px; border-radius: 6px; font-size: 13px; border: 1px solid var(--dt-border); background: #fff; color: var(--dt-text-2); cursor: pointer; }
.dt-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.dt-btn-primary { background: var(--dt-primary); color: #fff; border-color: var(--dt-primary); }
.dt-btn-primary:hover { color: #fff; }
.dt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ctx-menu { position: fixed; background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14); padding: 4px; z-index: 120; }
.ctx-item { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 6px; font-size: 13px; color: var(--dt-text); width: 100%; text-align: left; white-space: nowrap; }
.ctx-item:hover { background: var(--dt-hover); }
.ctx-item.danger { color: var(--dt-danger, #e34d59); }
.ctx-item.danger:hover { background: rgba(227, 77, 89, 0.08); }
.modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); display: flex; align-items: center; justify-content: center; z-index: 160; }
.modal { width: 400px; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18); overflow: hidden; }
.modal-head { padding: 16px 20px; font-size: 15px; font-weight: 600; color: var(--dt-text); border-bottom: 1px solid var(--dt-border-light); }
.modal-body { padding: 18px 20px; }
.modal-desc { font-size: 13px; color: var(--dt-text-3); margin: 0; }
.modal-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid var(--dt-border-light); }
.dt-btn-danger { background: var(--dt-danger, #e34d59); color: #fff; border-color: var(--dt-danger, #e34d59); }
.dt-btn-danger:hover { color: #fff; opacity: 0.9; }
.prompt-toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: rgba(0, 0, 0, 0.75); color: #fff; font-size: 13px; padding: 8px 16px; border-radius: 6px; z-index: 200; }
.company-code-toggle.danger:hover { color: var(--dt-danger, #e34d59); border-color: var(--dt-danger, #e34d59); }
.t-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.4); display: flex; align-items: center; justify-content: center; z-index: 220; }
.t-card { width: 300px; max-height: 60vh; display: flex; flex-direction: column; background: #fff; border-radius: 10px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25); overflow: hidden; }
.t-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid var(--dt-border-light, #eee); font-weight: 600; font-size: 14px; }
.t-close { border: none; background: none; font-size: 15px; color: #999; cursor: pointer; }
.t-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; cursor: pointer; font-size: 13px; }
.t-item:hover { background: #e6f4ff; }
.t-empty { padding: 20px; text-align: center; color: #bbb; font-size: 13px; }
</style>
