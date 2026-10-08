/**
 * 应用主 store（Pinia setup store）。
 * 集中管理：公司/部门/成员/群/好友/会话/消息、本地预览缓存、群设置、上传进度、聊天与通知。
 * 注意：本文件是从构建产物（out/renderer）逆编译重建，逻辑与方法签名与源码一致。
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useServerStore } from './server'
import type {
  Ack,
  CompanyMembership,
  Department,
  Group,
  ServerGroupMember,
  ConversationItem,
  ReadReceipt,
  FriendItem,
  OrgMember,
  ServerChatMessage,
  MessageKind
} from '../../../shared/server-types'
import type { NotifTarget } from '../../../shared/ipc'

/** 从 ack 提取 data 载荷 */
function d<T>(ack: unknown): T | undefined {
  const a = ack as { data?: T } | null
  return a?.data ?? undefined
}

/** 本地乐观消息/选中的会话 */
export interface SelectedChat {
  conversationId: number
  kind: 'group' | 'dm'
  groupId?: number
  dmUserId?: number
  name: string
  pinned: boolean
  readReceipts?: ReadReceipt[]
}

export const useAppStore = defineStore('app', () => {
  const server = useServerStore()

  // ─── 基础状态 ───
  const ready = ref(false)
  const loading = ref(false)
  const companies = ref<CompanyMembership[]>([])
  const activeCompanyId = ref(0)
  const departments = ref<Department[]>([])
  const members = ref<OrgMember[]>([])
  const groups = ref<Group[]>([])
  const friends = ref<FriendItem[]>([])
  const conversations = ref<ConversationItem[]>([])
  const selected = ref<SelectedChat | null>(null)
  const messages = ref<ServerChatMessage[]>([])
  const onlineMap = ref<Record<number, boolean>>({})
  const localCache = ref<Record<string, { fileUrl: string; path: string }>>({})
  const failedLocalCache = ref<Set<string>>(new Set())
  const pendingUploads = ref<{ clientId: string; fileName: string; kind: string; percent: number; error?: string }[]>([])

  // ─── 本地预览（图片/视频/文件自动下载） ───
  function isAutoPreviewKind(kind: string): boolean {
    return kind === 'image' || kind === 'video' || kind === 'file' || kind === 'audio'
  }
  function autoDownloadEnabled(): boolean {
    return server.settings.autoDownload !== false
  }
  async function ensureLocalPreview(msg: ServerChatMessage): Promise<void> {
    if (!autoDownloadEnabled()) return
    if (!isAutoPreviewKind(msg.kind)) return
    if (localCache.value[msg.id]) return
    if (failedLocalCache.value.has(msg.id)) return
    try {
      console.log('正在下载消息预览文件:', msg.content)
      const r = await window.pantry.serverDownloadFile(server.absFileUrl(msg.content))
      if (r.ok && r.path && r.fileUrl && !failedLocalCache.value.has(msg.id)) {
        localCache.value[msg.id] = { fileUrl: r.fileUrl, path: r.path }
      }
    } catch {
      // 忽略下载失败，下次重试
    }
  }
  function localPreviewUrl(msg: ServerChatMessage): string {
    const c = localCache.value[msg.id]
    const u = c ? c.fileUrl : server.absFileUrl(msg.content)
    console.log('正在获取本地预览路径:', u)
    return u
  }
  function fallbackPreview(msg: ServerChatMessage): void {
    if (localCache.value[msg.id]) delete localCache.value[msg.id]
    console.log('清除本地预览缓存:', msg.id)
    failedLocalCache.value.add(msg.id)
  }
  function ensureLocalForAll(list: ServerChatMessage[]): void {
    for (const m of list) void ensureLocalPreview(m)
  }

  // ─── 上传进度 ───
  window.pantry.onUploadProgress(({ clientId, percent }) => {
    const p = pendingUploads.value.find((x) => x.clientId === clientId)
    if (p) p.percent = percent
  })
  // 通知管理器：点击消息通知 → 定位到该会话
  window.pantry.onNavigateToConversation((conversationId) => {
    void navigateToConversation(conversationId)
  })

  // ─── 群设置（owner/admin） ───
  const groupSettingsOpen = ref(false)
  const groupSettingsId = ref(0)
  const groupSettingsName = ref('')
  const groupSettingsMembers = ref<ServerGroupMember[]>([])
  const groupSettingsLoading = ref(false)

  function openGroupSettings(groupId: number, name: string): void {
    groupSettingsId.value = groupId
    groupSettingsName.value = name
    groupSettingsOpen.value = true
    void loadGroupSettings()
  }
  function closeGroupSettings(): void {
    groupSettingsOpen.value = false
    groupSettingsMembers.value = []
  }
  async function loadGroupSettings(): Promise<void> {
    const gid = groupSettingsId.value
    if (!gid) return
    groupSettingsLoading.value = true
    const ack = await window.pantry.serverGroupMembers(gid)
    if (ack.ok && ack.data) groupSettingsMembers.value = (ack.data as { members: ServerGroupMember[] }).members
    groupSettingsLoading.value = false
  }
  const groupSettingsMyRole = computed(() => groupSettingsMembers.value.find((m) => m.userId === server.state.userId)?.role)
  const canManageGroup = computed(() => groupSettingsMyRole.value === 'owner' || groupSettingsMyRole.value === 'admin')
  const isGroupOwner = computed(() => groupSettingsMyRole.value === 'owner')

  async function setGroupAdmin(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverGroupSetAdmin(groupSettingsId.value, userId)
    if (ack.ok) await loadGroupSettings()
    return { ok: ack.ok, error: ack.error }
  }
  async function unsetGroupAdmin(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverGroupUnsetAdmin(groupSettingsId.value, userId)
    if (ack.ok) await loadGroupSettings()
    return { ok: ack.ok, error: ack.error }
  }
  async function muteGroupMember(userId: number, seconds: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverGroupMute(groupSettingsId.value, userId, seconds)
    if (ack.ok) await loadGroupSettings()
    return { ok: ack.ok, error: ack.error }
  }
  async function addGroupMember(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverGroupAdd(groupSettingsId.value, userId)
    if (ack.ok) await loadGroupSettings()
    return { ok: ack.ok, error: ack.error }
  }
  async function inviteGroupMember(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverGroupInvite(groupSettingsId.value, userId)
    return { ok: ack.ok, error: ack.error }
  }
  async function kickGroupMemberUi(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverKickGroupMember(groupSettingsId.value, userId)
    if (ack.ok) await loadGroupSettings()
    return { ok: ack.ok, error: ack.error }
  }

  window.pantry.onGroupMembersUpdated(({ groupId }) => {
    if (groupSettingsOpen.value && groupSettingsId.value === groupId) void loadGroupSettings()
  })

  window.pantry.onGroupInvite((ev) => {
    if (window.confirm(`${ev.from.nick} 邀请你加入群「${ev.groupName}」，是否接受？`)) {
      void window.pantry.serverGroupAcceptInvite(ev.groupId).then(() => {
        void refreshConversations()
      })
    } else {
      void window.pantry.serverGroupDeclineInvite(ev.groupId)
    }
  })

  async function transferGroupOwner(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverGroupTransfer(groupSettingsId.value, userId)
    if (ack.ok) await loadGroupSettings()
    return { ok: ack.ok, error: ack.error }
  }
  async function dissolveGroup(): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverGroupDissolve(groupSettingsId.value)
    if (ack.ok) {
      closeGroupSettings()
      conversations.value = conversations.value.filter((c) => !(c.type === 'group' && c.groupId === groupSettingsId.value))
      void refreshConversations()
    }
    return { ok: ack.ok, error: ack.error }
  }

  // ─── 公司 owner 操作 ───
  async function transferCompanyOwner(companyId: number, userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverCompanyTransfer(companyId, userId)
    if (ack.ok) void refreshCompanies()
    return { ok: ack.ok, error: ack.error }
  }
  async function dissolveCompany(companyId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverCompanyDissolve(companyId)
    if (ack.ok) {
      companies.value = companies.value.filter((m) => m.company.id !== companyId)
      groups.value = groups.value.filter((g) => g.companyId !== companyId)
      if (activeCompanyId.value === companyId) {
        const rest = companies.value
        if (rest.length) {
          await switchCompany(rest[0].company.id)
          await refreshGroups()
        } else {
          activeCompanyId.value = 0
          departments.value = []
          members.value = []
          groups.value = []
        }
      }
      void refreshCompanies()
      void refreshConversations()
    }
    return { ok: ack.ok, error: ack.error }
  }

  // ─── 服务端事件：组织/好友变化 ───
  window.pantry.onGroupDissolved(({ groupId }) => {
    if (groupSettingsOpen.value && groupSettingsId.value === groupId) closeGroupSettings()
    if (selected.value?.kind === 'group' && selected.value.groupId === groupId) selected.value = null
    conversations.value = conversations.value.filter((c) => !(c.type === 'group' && c.groupId === groupId))
    void refreshConversations()
  })
  window.pantry.onCompanyDissolved(({ companyId }) => {
    companies.value = companies.value.filter((m) => m.company.id !== companyId)
    groups.value = groups.value.filter((g) => g.companyId !== companyId)
    if (activeCompanyId.value === companyId) {
      const rest = companies.value
      if (rest.length) {
        void switchCompany(rest[0].company.id)
        void refreshGroups()
      } else {
        activeCompanyId.value = 0
        departments.value = []
        members.value = []
        groups.value = []
      }
    }
    void refreshCompanies()
    void refreshGroups()
    void refreshConversations()
  })
  window.pantry.onCompanyUpdated(({ companyId }) => {
    void refreshCompanies()
    if (activeCompanyId.value === companyId) {
      void refreshDepartments()
      void refreshMembers()
      void refreshGroups()
      void refreshConversations()
    }
  })
  window.pantry.onCompanyRemoved(({ companyId }) => {
    companies.value = companies.value.filter((m) => m.company.id !== companyId)
    groups.value = groups.value.filter((g) => g.companyId !== companyId)
    if (activeCompanyId.value === companyId) {
      const rest = companies.value
      if (rest.length) {
        void switchCompany(rest[0].company.id)
        void refreshGroups()
      } else {
        activeCompanyId.value = 0
        departments.value = []
        members.value = []
        groups.value = []
      }
    }
    void refreshCompanies()
    void refreshGroups()
    void refreshConversations()
  })
  window.pantry.onCompanyAdded(({ companyId }) => {
    void refreshCompanies()
  })
  window.pantry.onGroupAdded(({ groupId }) => {
    void refreshGroups()
    void refreshConversations()
  })
  window.pantry.onGroupRemoved(({ groupId }) => {
    groups.value = groups.value.filter((g) => g.id !== groupId)
    conversations.value = conversations.value.filter((c) => !(c.type === 'group' && c.groupId === groupId))
    if (selected.value?.kind === 'group' && selected.value.groupId === groupId) selected.value = null
    void refreshConversations()
  })
  window.pantry.onFriendsUpdated(() => {
    void refreshFriends()
  })
  window.pantry.onUserProfileUpdated(() => {
    void refreshFriends()
    if (activeCompanyId.value) void refreshMembers()
    void refreshConversations()
  })
  // 会话已读/置顶他端同步：增量更新指定会话，避免全量刷新覆盖本地新消息未读自增
  window.pantry.onServerConversationsUpdated((d) => {
    const p = (d ?? {}) as { conversationId?: number; unread?: number; pinned?: boolean }
    const id = Number(p.conversationId)
    if (!Number.isInteger(id) || id <= 0) return
    const item = conversations.value.find((c) => c.conversationId === id)
    if (!item) return
    if (typeof p.unread === 'number') item.unread = Math.max(0, p.unread)
    if (typeof p.pinned === 'boolean') {
      item.pinned = p.pinned
      conversations.value.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
    }
  })

  // 已读回执：他端读到某条消息 → 更新本地该会话/当前会话的已读位置，供消息"已读"标记渲染
  window.pantry.onServerChatReadReceipt((ev) => {
    const id = Number(ev.conversationId)
    const item = conversations.value.find((c) => c.conversationId === id)
    if (item) {
      if (!Array.isArray(item.readReceipts)) item.readReceipts = []
      const idx = item.readReceipts.findIndex((r) => r.userId === Number(ev.userId))
      if (idx >= 0) item.readReceipts[idx]!.lastReadMessageId = ev.lastReadMessageId
      else item.readReceipts.push({ userId: Number(ev.userId), lastReadMessageId: ev.lastReadMessageId })
    }
    if (selected.value && selected.value.conversationId === id) {
      if (!Array.isArray(selected.value.readReceipts)) selected.value.readReceipts = []
      const i2 = selected.value.readReceipts.findIndex((r) => r.userId === Number(ev.userId))
      if (i2 >= 0) selected.value.readReceipts[i2]!.lastReadMessageId = ev.lastReadMessageId
      else selected.value.readReceipts.push({ userId: Number(ev.userId), lastReadMessageId: ev.lastReadMessageId })
    }
  })

  // ─── 计算属性 ───
  const activeCompany = computed(() => {
    const m = companies.value.find((c) => c.company.id === activeCompanyId.value)
    return m ? m.company : null
  })
  const activeRole = computed(() => {
    const m = companies.value.find((c) => c.company.id === activeCompanyId.value)
    return m ? m.role : ''
  })
  const isAdmin = computed(() => activeRole.value === 'owner' || activeRole.value === 'admin')
  const isOwner = computed(() => activeCompany.value?.ownerId === server.state.userId)
  function roleLabel(role: string): string {
    if (role === 'owner' || role === 'admin') return '管理员'
    return '员工'
  }
  const unreadTotal = computed(() => conversations.value.reduce((s, c) => s + c.unread, 0))

  // ─── 数据刷新 ───
  async function refreshCompanies(): Promise<void> {
    const ack = await window.pantry.serverListCompanies()
    companies.value = d<{ companies: CompanyMembership[] }>(ack)?.companies ?? []
  }
  async function refreshDepartments(): Promise<void> {
    if (!activeCompanyId.value) {
      departments.value = []
      return
    }
    const ack = await window.pantry.serverDepartments(activeCompanyId.value)
    departments.value = d<{ departments: Department[] }>(ack)?.departments ?? []
  }
  async function refreshMembers(): Promise<void> {
    if (!activeCompanyId.value) {
      members.value = []
      return
    }
    const ack = await window.pantry.serverMembers(activeCompanyId.value)
    const ms = d<{ members: OrgMember[] }>(ack)?.members ?? []
    members.value = ms
    for (const m of ms) onlineMap.value[m.userId] = !!m.online
  }
  async function refreshGroups(): Promise<void> {
    const ack = await window.pantry.serverListGroups()
    groups.value = d<{ groups: Group[] }>(ack)?.groups ?? []
  }
  async function refreshFriends(): Promise<void> {
    const ack = await window.pantry.serverListFriends()
    friends.value = d<{ friends: FriendItem[] }>(ack)?.friends ?? []
  }
  async function refreshConversations(): Promise<void> {
    const ack = await window.pantry.serverConversations()
    conversations.value = d<{ conversations: ConversationItem[] }>(ack)?.conversations ?? []
    if (selected.value) {
      const cur = conversations.value.find((c) => c.conversationId === selected.value?.conversationId)
      if (cur && selected.value) selected.value.pinned = cur.pinned
    }
  }

  async function bootstrap(): Promise<void> {
    loading.value = true
    try {
      await refreshCompanies()
      if (companies.value.length === 0) {
        await Promise.all([refreshGroups(), refreshFriends(), refreshConversations()])
        ready.value = true
        return
      }
      const saved = server.state.activeCompanyId
      const first = companies.value.some((c) => c.company.id === saved) ? saved : companies.value[0].company.id
      await switchCompany(first)
      await Promise.all([refreshGroups(), refreshFriends(), refreshConversations()])
      ready.value = true
    } finally {
      loading.value = false
    }
  }
  async function switchCompany(companyId: number): Promise<void> {
    activeCompanyId.value = companyId
    server.setActiveCompany(companyId)
    await Promise.all([refreshDepartments(), refreshMembers()])
  }

  // ─── 公司操作 ───
  async function createCompany(name: string, code?: string): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverCreateCompany(name, code)
    if (ack.ok) {
      await refreshCompanies()
      const c = d<{ company: CompanyMembership['company'] }>(ack)?.company
      if (c?.id) {
        await switchCompany(c.id)
        await refreshGroups()
      }
    }
    return { ok: ack.ok, error: ack.error }
  }
  async function joinCompany(code: string): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverJoinCompany(code)
    if (ack.ok) {
      await refreshCompanies()
      const c = d<{ company: CompanyMembership['company'] }>(ack)?.company
      if (c?.id && activeCompanyId.value !== c.id) await switchCompany(c.id)
    }
    return { ok: ack.ok, error: ack.error }
  }
  async function leaveCompany(companyId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverLeaveCompany(companyId)
    if (ack.ok) {
      await refreshCompanies()
      groups.value = groups.value.filter((g) => g.companyId !== companyId)
      if (activeCompanyId.value === companyId) {
        if (companies.value.length) {
          await switchCompany(companies.value[0].company.id)
          await refreshGroups()
        } else {
          activeCompanyId.value = 0
          departments.value = []
          members.value = []
          groups.value = []
        }
      }
    }
    return { ok: ack.ok, error: ack.error }
  }
  async function setMemberRole(userId: number, role: string): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverSetCompanyRole(activeCompanyId.value, userId, role as 'owner' | 'admin' | 'member')
    if (ack.ok) await refreshMembers()
    return { ok: ack.ok, error: ack.error }
  }
  async function kickMember(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverKickCompanyMember(activeCompanyId.value, userId)
    if (ack.ok) await refreshMembers()
    return { ok: ack.ok, error: ack.error }
  }
  async function searchUsers(keyword: string): Promise<Array<{ id: number; username: string; nick?: string; avatar?: string }>> {
    const ack = await window.pantry.serverSearchUsers(keyword)
    return d<{ users: Array<{ id: number; username: string; nick?: string; avatar?: string }> }>(ack)?.users ?? []
  }
  type HolidayItem = { id: number; date: string; name: string; type: string; createdAt: string }
  async function fetchHolidays(year?: number): Promise<HolidayItem[]> {
    const ack = await window.pantry.serverHolidays(year)
    return d<{ holidays: HolidayItem[] }>(ack)?.holidays ?? []
  }
  async function addHoliday(date: string, name: string, type: 'legal' | 'workday' | 'custom'): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverHolidayAdd(date, name, type)
    return { ok: ack.ok, error: ack.error }
  }
  async function removeHoliday(date: string): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverHolidayRemove(date)
    return { ok: ack.ok, error: ack.error }
  }
  async function addHolidays(items: Array<{ date: string; name: string; type: 'legal' | 'workday' | 'custom' }>): Promise<{ ok: boolean; error?: string; added?: number }> {
    const ack = await window.pantry.serverHolidayAddMany(items)
    const data = d<{ added: number }>(ack)
    return { ok: ack.ok, error: ack.error, added: data?.added }
  }
  async function removeHolidays(dates: string[]): Promise<{ ok: boolean; error?: string; removed?: number }> {
    const ack = await window.pantry.serverHolidayRemoveMany(dates)
    const data = d<{ removed: number }>(ack)
    return { ok: ack.ok, error: ack.error, removed: data?.removed }
  }
  async function resetHolidays(): Promise<{ ok: boolean; error?: string; count?: number }> {
    const ack = await window.pantry.serverHolidayReset()
    const data = d<{ count: number }>(ack)
    return { ok: ack.ok, error: ack.error, count: data?.count }
  }

  // ─── 任务流程系统 ───
  type TaskStatusStr = 'created' | 'in_progress' | 'completed' | 'pending_extension' | 'extended' | 'overdue'
  type TaskProject = { id: number; companyId: number; name: string; pmId: number; createdAt: string }
  type TaskProjectMember = { projectId: number; userId: number; role: string; joinedAt: string }
  type TaskItem = { id: number; companyId: number; projectId: number | null; title: string; description: string; startTime: string; dueTime: string; completedTime: string | null; status: TaskStatusStr; isOverdue: boolean; reminderYellow: number; reminderRed: number; images: string[]; createdBy: number; createdAt: string; updatedAt: string }
  type TaskAssignment = { id: number; taskId: number; userId: number; content: string; status: 'created' | 'in_progress' | 'completed'; completedAt: string | null; username?: string; nick?: string; avatar?: string }
  type TaskAttachment = { kind: 'image' | 'video' | 'audio' | 'folder' | 'file'; url: string; name: string }
  type TaskComment = { id: number; taskId: number; userId: number; content: string; attachments: TaskAttachment[]; createdAt: string; username?: string; nick?: string; avatar?: string }
  type TaskIssue = { id: number; taskId: number; userId: number; title: string; content: string; status: 'open' | 'resolved'; resolvedAt: string | null; createdAt: string; username?: string; nick?: string; avatar?: string }
  type TaskExtension = { id: number; taskId: number; userId: number; requestedDueTime: string; reason: string; status: 'pending' | 'approved' | 'rejected'; decidedBy: number | null; decidedAt: string | null; createdAt: string; username?: string; nick?: string }
  type TaskLog = { id: number; taskId: number; userId: number; fromStatus: string; toStatus: TaskStatusStr; note: string; createdAt: string; username?: string; nick?: string }
  type TaskDetail = { task: TaskItem; assignments: TaskAssignment[]; comments: TaskComment[]; issues: TaskIssue[]; extensions: TaskExtension[]; logs: TaskLog[] }
  async function fetchProjects(): Promise<TaskProject[]> {
    const ack = await window.pantry.serverTaskListProjects(activeCompanyId.value)
    return d<{ projects: TaskProject[] }>(ack)?.projects ?? []
  }
  async function createProject(name: string): Promise<{ ok: boolean; error?: string; project?: TaskProject }> {
    const ack = await window.pantry.serverTaskCreateProject(activeCompanyId.value, name)
    return { ok: ack.ok, error: ack.error, project: d<{ project: TaskProject }>(ack)?.project }
  }
  async function deleteProject(projectId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverTaskDeleteProject(activeCompanyId.value, projectId)
    return { ok: ack.ok, error: ack.error }
  }
  async function setProjectRole(projectId: number, userId: number, role: string): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverTaskSetProjectRole(activeCompanyId.value, projectId, userId, role)
    return { ok: ack.ok, error: ack.error }
  }
  async function projectMembers(projectId: number): Promise<TaskProjectMember[]> {
    const ack = await window.pantry.serverTaskProjectMembers(projectId)
    return d<{ members: TaskProjectMember[] }>(ack)?.members ?? []
  }
  async function fetchTasks(projectId?: number): Promise<TaskItem[]> {
    const ack = await window.pantry.serverTaskList(activeCompanyId.value, projectId)
    return d<{ tasks: TaskItem[] }>(ack)?.tasks ?? []
  }
  async function fetchTaskDetail(taskId: number): Promise<TaskDetail | null> {
    const ack = await window.pantry.serverTaskDetail(taskId)
    return d<{ detail: TaskDetail }>(ack)?.detail ?? null
  }
  async function createTask(input: { companyId?: number; projectId?: number; title: string; description?: string; startTime: string; dueTime: string; images?: string[]; assignments?: Array<{ userId: number; content: string }> }): Promise<{ ok: boolean; error?: string; task?: TaskItem }> {
    const payload = {
      companyId: Number(input.companyId ?? activeCompanyId.value) || 0,
      projectId: input.projectId && input.projectId > 0 ? Number(input.projectId) : null,
      title: String(input.title ?? ''),
      description: String(input.description ?? ''),
      startTime: String(input.startTime ?? ''),
      dueTime: String(input.dueTime ?? ''),
      images: Array.isArray(input.images) ? input.images.map((x) => String(x)).slice(0, 9) : [],
      assignments: Array.isArray(input.assignments)
        ? input.assignments.map((a) => ({ userId: Number(a?.userId) || 0, content: String(a?.content ?? '') }))
        : []
    }
    const ack = await window.pantry.serverTaskCreate(payload)
    return { ok: ack.ok, error: ack.error, task: d<{ task: TaskItem }>(ack)?.task }
  }
  async function updateTask(input: { taskId: number; title?: string; description?: string; startTime?: string; dueTime?: string; images?: string[] }): Promise<{ ok: boolean; error?: string; task?: TaskItem }> {
    const ack = await window.pantry.serverTaskUpdate({ taskId: input.taskId, title: input.title, description: input.description, startTime: input.startTime, dueTime: input.dueTime, images: input.images })
    return { ok: ack.ok, error: ack.error, task: d<{ task: TaskItem }>(ack)?.task }
  }
  async function deleteTask(taskId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverTaskDelete(taskId)
    return { ok: ack.ok, error: ack.error }
  }
  async function setTaskStatus(taskId: number, status: TaskStatusStr, note: string): Promise<{ ok: boolean; error?: string; task?: TaskItem }> {
    const ack = await window.pantry.serverTaskSetStatus(taskId, status, note)
    return { ok: ack.ok, error: ack.error, task: d<{ task: TaskItem }>(ack)?.task }
  }
  async function setTaskReminder(taskId: number, reminderYellow: number, reminderRed: number): Promise<{ ok: boolean; error?: string; task?: TaskItem }> {
    const ack = await window.pantry.serverTaskSetReminder(taskId, reminderYellow, reminderRed)
    return { ok: ack.ok, error: ack.error, task: d<{ task: TaskItem }>(ack)?.task }
  }
  async function addAssignment(taskId: number, userId: number, content: string): Promise<{ ok: boolean; error?: string; assignment?: TaskAssignment }> {
    const ack = await window.pantry.serverTaskAddAssignment(taskId, userId, content)
    return { ok: ack.ok, error: ack.error, assignment: d<{ assignment: TaskAssignment }>(ack)?.assignment }
  }
  async function removeAssignment(id: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverTaskRemoveAssignment(id)
    return { ok: ack.ok, error: ack.error }
  }
  async function setAssignmentStatus(id: number, status: 'created' | 'in_progress' | 'completed'): Promise<{ ok: boolean; error?: string; assignment?: TaskAssignment }> {
    const ack = await window.pantry.serverTaskSetAssignmentStatus(id, status)
    return { ok: ack.ok, error: ack.error, assignment: d<{ assignment: TaskAssignment }>(ack)?.assignment }
  }
  async function addTaskComment(taskId: number, content: string, attachments?: TaskAttachment[]): Promise<{ ok: boolean; error?: string; comment?: TaskComment }> {
    const ack = await window.pantry.serverTaskComment(taskId, content, (attachments ?? []).map((a) => ({ kind: a.kind, url: a.url, name: a.name })))
    return { ok: ack.ok, error: ack.error, comment: d<{ comment: TaskComment }>(ack)?.comment }
  }
  async function addTaskIssue(taskId: number, title: string, content: string): Promise<{ ok: boolean; error?: string; issue?: TaskIssue }> {
    const ack = await window.pantry.serverTaskAddIssue(taskId, title, content)
    return { ok: ack.ok, error: ack.error, issue: d<{ issue: TaskIssue }>(ack)?.issue }
  }
  async function resolveTaskIssue(issueId: number): Promise<{ ok: boolean; error?: string; issue?: TaskIssue }> {
    const ack = await window.pantry.serverTaskResolveIssue(issueId)
    return { ok: ack.ok, error: ack.error, issue: d<{ issue: TaskIssue }>(ack)?.issue }
  }
  async function requestExtension(taskId: number, requestedDueTime: string, reason: string): Promise<{ ok: boolean; error?: string; extension?: TaskExtension }> {
    const ack = await window.pantry.serverTaskRequestExtension(taskId, requestedDueTime, reason)
    return { ok: ack.ok, error: ack.error, extension: d<{ extension: TaskExtension }>(ack)?.extension }
  }
  async function decideExtension(taskId: number, extensionId: number, approved: boolean): Promise<{ ok: boolean; error?: string; extension?: TaskExtension }> {
    const ack = await window.pantry.serverTaskDecideExtension(activeCompanyId.value, taskId, extensionId, approved)
    return { ok: ack.ok, error: ack.error, extension: d<{ extension: TaskExtension }>(ack)?.extension }
  }

  // ─── TAPD 项目管理 ───
  type ReqCategory = 'uncategorized' | 'product' | 'tech'
  type ReqPriority = 'nth' | 'middle' | 'high'
  type ReqStatus = 'planning' | 'in_progress' | 'done' | 'closed'
  type RequirementItem = { id: number; companyId: number; projectId: number | null; code: string; title: string; description: string; category: ReqCategory; priority: ReqPriority; status: ReqStatus; handlerId: number | null; creatorId: number; startTime: string; dueTime: string; completedTime: string | null; linkedTaskIds: number[]; createdAt: string; updatedAt: string; handlerName?: string; creatorName?: string }
  type BugSeverityStr = 'minor' | 'normal' | 'major' | 'critical'
  type BugPriorityStr = 'low' | 'middle' | 'high'
  type BugStatusStr = 'pending' | 'processing' | 'verified' | 'closed'
  type BugItem = { id: number; companyId: number; projectId: number | null; requirementId: number | null; code: string; title: string; description: string; severity: BugSeverityStr; priority: BugPriorityStr; status: BugStatusStr; handlerId: number | null; creatorId: number; foundVersion: string; createdAt: string; updatedAt: string; handlerName?: string; creatorName?: string }
  type PlanItem = { id: number; companyId: number; projectId: number | null; name: string; description: string; startTime: string; dueTime: string; status: string; creatorId: number; createdAt: string; updatedAt: string }
  type DocItem = { id: number; companyId: number; projectId: number | null; title: string; content: string; creatorId: number; createdAt: string; updatedAt: string }
  type WikiItem = DocItem
  type DashboardItem = { newRequirement30d: number; overdueRequirement: number; bugResolveRate: number; unresolvedBug: number; requirementByStatus: Record<string, number>; bugBySeverity: Record<string, number> }
  type MemberTrackItem = { userId: number; nick: string; username: string; total: number; completed: number; inProgress: number; overdue: number }

  async function fetchRequirements(projectId?: number): Promise<RequirementItem[]> {
    const ack = await window.pantry.serverReqList(activeCompanyId.value, projectId)
    return d<{ requirements: RequirementItem[] }>(ack)?.requirements ?? []
  }
  async function createRequirement(input: { projectId?: number; title: string; description?: string; category?: string; priority?: string; handlerId?: number; startTime: string; dueTime: string; taskIds?: number[] }): Promise<{ ok: boolean; error?: string; requirement?: RequirementItem }> {
    const ack = await window.pantry.serverReqCreate({ companyId: activeCompanyId.value, projectId: input.projectId && input.projectId > 0 ? Number(input.projectId) : null, title: String(input.title ?? ''), description: String(input.description ?? ''), category: String(input.category ?? ''), priority: String(input.priority ?? ''), handlerId: Number(input.handlerId ?? 0) || null, startTime: String(input.startTime ?? ''), dueTime: String(input.dueTime ?? ''), taskIds: Array.isArray(input.taskIds) ? input.taskIds.map((x) => Number(x)) : [] })
    return { ok: ack.ok, error: ack.error, requirement: d<{ requirement: RequirementItem }>(ack)?.requirement }
  }
  async function updateRequirement(input: { id: number; title?: string; description?: string; category?: string; priority?: string; handlerId?: number | null; startTime?: string; dueTime?: string }): Promise<{ ok: boolean; error?: string; requirement?: RequirementItem }> {
    const ack = await window.pantry.serverReqUpdate({ id: input.id, title: input.title, description: input.description, category: input.category, priority: input.priority, handlerId: input.handlerId, startTime: input.startTime, dueTime: input.dueTime })
    return { ok: ack.ok, error: ack.error, requirement: d<{ requirement: RequirementItem }>(ack)?.requirement }
  }
  async function setRequirementStatus(id: number, status: ReqStatus): Promise<{ ok: boolean; error?: string; requirement?: RequirementItem }> {
    const ack = await window.pantry.serverReqStatus(id, status)
    return { ok: ack.ok, error: ack.error, requirement: d<{ requirement: RequirementItem }>(ack)?.requirement }
  }
  async function deleteRequirement(id: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverReqDelete(id)
    return { ok: ack.ok, error: ack.error }
  }
  async function linkRequirementTasks(id: number, taskIds: number[]): Promise<{ ok: boolean; error?: string; linkedTaskIds?: number[] }> {
    const ack = await window.pantry.serverReqLinkTasks(id, taskIds)
    return { ok: ack.ok, error: ack.error, linkedTaskIds: d<{ linkedTaskIds: number[] }>(ack)?.linkedTaskIds }
  }

  async function fetchBugs(projectId?: number): Promise<BugItem[]> {
    const ack = await window.pantry.serverBugList(activeCompanyId.value, projectId)
    return d<{ bugs: BugItem[] }>(ack)?.bugs ?? []
  }
  async function createBug(input: { projectId?: number; requirementId?: number; title: string; description?: string; severity?: string; priority?: string; handlerId?: number; foundVersion?: string }): Promise<{ ok: boolean; error?: string; bug?: BugItem }> {
    const ack = await window.pantry.serverBugCreate({ companyId: activeCompanyId.value, projectId: input.projectId && input.projectId > 0 ? Number(input.projectId) : null, requirementId: input.requirementId && input.requirementId > 0 ? Number(input.requirementId) : null, title: String(input.title ?? ''), description: String(input.description ?? ''), severity: String(input.severity ?? ''), priority: String(input.priority ?? ''), handlerId: Number(input.handlerId ?? 0) || null, foundVersion: String(input.foundVersion ?? '') })
    return { ok: ack.ok, error: ack.error, bug: d<{ bug: BugItem }>(ack)?.bug }
  }
  async function updateBug(input: { id: number; title?: string; description?: string; severity?: string; priority?: string; handlerId?: number | null; foundVersion?: string }): Promise<{ ok: boolean; error?: string; bug?: BugItem }> {
    const ack = await window.pantry.serverBugUpdate({ id: input.id, title: input.title, description: input.description, severity: input.severity, priority: input.priority, handlerId: input.handlerId, foundVersion: input.foundVersion })
    return { ok: ack.ok, error: ack.error, bug: d<{ bug: BugItem }>(ack)?.bug }
  }
  async function setBugStatus(id: number, status: BugStatusStr): Promise<{ ok: boolean; error?: string; bug?: BugItem }> {
    const ack = await window.pantry.serverBugStatus(id, status)
    return { ok: ack.ok, error: ack.error, bug: d<{ bug: BugItem }>(ack)?.bug }
  }
  async function deleteBug(id: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverBugDelete(id)
    return { ok: ack.ok, error: ack.error }
  }

  async function fetchPlans(projectId?: number): Promise<PlanItem[]> {
    const ack = await window.pantry.serverPlanList(activeCompanyId.value, projectId)
    return d<{ plans: PlanItem[] }>(ack)?.plans ?? []
  }
  async function createPlan(input: { projectId?: number; name: string; description?: string; startTime: string; dueTime: string }): Promise<{ ok: boolean; error?: string; plan?: PlanItem }> {
    const ack = await window.pantry.serverPlanCreate({ companyId: activeCompanyId.value, projectId: input.projectId && input.projectId > 0 ? Number(input.projectId) : null, name: String(input.name ?? ''), description: String(input.description ?? ''), startTime: String(input.startTime ?? ''), dueTime: String(input.dueTime ?? '') })
    return { ok: ack.ok, error: ack.error, plan: d<{ plan: PlanItem }>(ack)?.plan }
  }
  async function updatePlan(input: { id: number; name?: string; description?: string; startTime?: string; dueTime?: string; status?: string }): Promise<{ ok: boolean; error?: string; plan?: PlanItem }> {
    const ack = await window.pantry.serverPlanUpdate({ id: input.id, name: input.name, description: input.description, startTime: input.startTime, dueTime: input.dueTime, status: input.status })
    return { ok: ack.ok, error: ack.error, plan: d<{ plan: PlanItem }>(ack)?.plan }
  }
  async function deletePlan(id: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverPlanDelete(id)
    return { ok: ack.ok, error: ack.error }
  }

  async function fetchDocs(projectId?: number): Promise<DocItem[]> {
    const ack = await window.pantry.serverDocList(activeCompanyId.value, projectId)
    return d<{ docs: DocItem[] }>(ack)?.docs ?? []
  }
  async function createDoc(input: { projectId?: number; title: string; content?: string }): Promise<{ ok: boolean; error?: string; doc?: DocItem }> {
    const ack = await window.pantry.serverDocCreate({ companyId: activeCompanyId.value, projectId: input.projectId && input.projectId > 0 ? Number(input.projectId) : null, title: String(input.title ?? ''), content: String(input.content ?? '') })
    return { ok: ack.ok, error: ack.error, doc: d<{ doc: DocItem }>(ack)?.doc }
  }
  async function updateDoc(input: { id: number; title?: string; content?: string }): Promise<{ ok: boolean; error?: string; doc?: DocItem }> {
    const ack = await window.pantry.serverDocUpdate({ id: input.id, title: input.title, content: input.content })
    return { ok: ack.ok, error: ack.error, doc: d<{ doc: DocItem }>(ack)?.doc }
  }
  async function deleteDoc(id: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverDocDelete(id)
    return { ok: ack.ok, error: ack.error }
  }

  async function fetchWiki(projectId?: number): Promise<WikiItem[]> {
    const ack = await window.pantry.serverWikiList(activeCompanyId.value, projectId)
    return d<{ pages: WikiItem[] }>(ack)?.pages ?? []
  }
  async function createWiki(input: { projectId?: number; title: string; content?: string }): Promise<{ ok: boolean; error?: string; page?: WikiItem }> {
    const ack = await window.pantry.serverWikiCreate({ companyId: activeCompanyId.value, projectId: input.projectId && input.projectId > 0 ? Number(input.projectId) : null, title: String(input.title ?? ''), content: String(input.content ?? '') })
    return { ok: ack.ok, error: ack.error, page: d<{ page: WikiItem }>(ack)?.page }
  }
  async function updateWiki(input: { id: number; title?: string; content?: string }): Promise<{ ok: boolean; error?: string; page?: WikiItem }> {
    const ack = await window.pantry.serverWikiUpdate({ id: input.id, title: input.title, content: input.content })
    return { ok: ack.ok, error: ack.error, page: d<{ page: WikiItem }>(ack)?.page }
  }
  async function deleteWiki(id: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverWikiDelete(id)
    return { ok: ack.ok, error: ack.error }
  }

  async function fetchDashboard(projectId?: number): Promise<DashboardItem | null> {
    const ack = await window.pantry.serverPmDashboard(activeCompanyId.value, projectId)
    return d<{ stats: DashboardItem }>(ack)?.stats ?? null
  }
  async function fetchMemberTracking(projectId?: number): Promise<MemberTrackItem[]> {
    const ack = await window.pantry.serverPmMemberTracking(activeCompanyId.value, projectId)
    return d<{ members: MemberTrackItem[] }>(ack)?.members ?? []
  }
  async function addCompanyMember(target: number | string, departmentId?: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverAddCompanyMember(activeCompanyId.value, target, departmentId ?? undefined)
    if (ack.ok) await refreshMembers()
    return { ok: ack.ok, error: ack.error }
  }
  async function deleteDepartment(departmentId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverDeleteDepartment(activeCompanyId.value, departmentId)
    if (ack.ok) await refreshDepartments()
    return { ok: ack.ok, error: ack.error }
  }
  async function loadDepartmentMembers(departmentId: number): Promise<OrgMember[]> {
    const ack = await window.pantry.serverDepartmentMembers(departmentId)
    return d<{ members: OrgMember[] }>(ack)?.members ?? []
  }
  async function createDepartment(name: string, parentId?: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverCreateDepartment(activeCompanyId.value, name, parentId)
    if (ack.ok) await refreshDepartments()
    return { ok: ack.ok, error: ack.error }
  }
  async function assignToDepartment(departmentId: number, userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverAssignDepartment(departmentId, userId)
    if (ack.ok) {
      await refreshDepartments()
      await refreshMembers()
    }
    return { ok: ack.ok, error: ack.error }
  }
  async function removeFromDepartment(departmentId: number, userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverRemoveDepartmentMember(departmentId, userId)
    if (ack.ok) {
      await refreshDepartments()
      await refreshMembers()
    }
    return { ok: ack.ok, error: ack.error }
  }

  // ─── 群操作 ───
  async function createGroup(name: string, departmentId?: number): Promise<{ ok: boolean; error?: string; groupId?: number }> {
    const ack = await window.pantry.serverCreateGroup(activeCompanyId.value, name, departmentId)
    const g = d<{ group: Group }>(ack)?.group
    if (ack.ok) {
      await refreshGroups()
      await refreshConversations()
      if (g?.id) await openGroup(g.id, g.name)
    }
    return { ok: ack.ok, error: ack.error, groupId: g?.id }
  }
  async function joinGroup(code: string): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverJoinGroup(code)
    const g = d<{ group: Group }>(ack)?.group
    if (ack.ok) {
      await refreshGroups()
      await refreshConversations()
      if (g?.id) await openGroup(g.id, g.name)
    }
    return { ok: ack.ok, error: ack.error }
  }
  async function leaveGroup(groupId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverLeaveGroup(groupId)
    if (ack.ok) {
      await refreshGroups()
      await refreshConversations()
      if (selected.value?.groupId === groupId) {
        selected.value = null
        messages.value = []
      }
    }
    return { ok: ack.ok, error: ack.error }
  }
  async function kickGroupMember(groupId: number, userId: number): Promise<{ ok: boolean; error?: string }> {
    return window.pantry.serverKickGroupMember(groupId, userId)
  }

  // ─── 好友 ───
  async function addFriend(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverAddFriend(userId)
    if (ack.ok) await refreshFriends()
    return { ok: ack.ok, error: ack.error }
  }
  async function removeFriend(userId: number): Promise<{ ok: boolean; error?: string }> {
    const ack = await window.pantry.serverRemoveFriend(userId)
    if (ack.ok) await refreshFriends()
    return { ok: ack.ok, error: ack.error }
  }

  // ─── 会话/消息 ───
  async function openGroup(groupId: number, name: string): Promise<void> {
    selected.value = { conversationId: 0, kind: 'group', groupId, name, pinned: false, readReceipts: [] }
    const conv = conversations.value.find((c) => c.groupId === groupId)
    if (conv && selected.value) {
      selected.value.conversationId = conv.conversationId
      selected.value.pinned = conv.pinned
      selected.value.readReceipts = conv.readReceipts ? [...conv.readReceipts] : []
      void markRead(conv.conversationId)
    }
    await loadGroupHistory(groupId)
    if (conv && selected.value) {
      const lm = messages.value[messages.value.length - 1]
      void markRead(conv.conversationId, lm && !String(lm.id).startsWith('local-') ? Number(lm.id) : null)
    }
  }
  async function openDm(userId: number, name: string): Promise<void> {
    selected.value = { conversationId: 0, kind: 'dm', dmUserId: userId, name, pinned: false, readReceipts: [] }
    const conv = conversations.value.find((c) => c.dmUserId === userId)
    if (conv && selected.value) {
      selected.value.conversationId = conv.conversationId
      selected.value.pinned = conv.pinned
      selected.value.readReceipts = conv.readReceipts ? [...conv.readReceipts] : []
      void markRead(conv.conversationId)
    }
    await loadDmHistory(userId)
    if (conv && selected.value) {
      const lm = messages.value[messages.value.length - 1]
      void markRead(conv.conversationId, lm && !String(lm.id).startsWith('local-') ? Number(lm.id) : null)
    }
  }
  async function openConversation(item: ConversationItem): Promise<void> {
    if (item.type === 'group' && item.groupId) await openGroup(item.groupId, item.name)
    else if (item.type === 'dm' && item.dmUserId) await openDm(item.dmUserId, item.name)
  }
  /** 通知管理器：按 conversationId 定位到对应会话（找不到则刷新列表） */
  async function navigateToConversation(conversationId: number): Promise<void> {
    if (!conversationId || conversationId <= 0) return
    let item = conversations.value.find((c) => c.conversationId === conversationId)
    if (!item) {
      const ack = await window.pantry.serverConversations()
      conversations.value = d<{ conversations: ConversationItem[] }>(ack)?.conversations ?? []
      item = conversations.value.find((c) => c.conversationId === conversationId)
    }
    if (item) await openConversation(item)
  }
  async function loadGroupHistory(groupId: number): Promise<void> {
    const ack = await window.pantry.serverChatHistory(groupId, undefined, 80)
    messages.value = (d<{ messages: ServerChatMessage[] }>(ack)?.messages ?? []).slice().reverse()
    ensureLocalForAll(messages.value)
  }
  async function loadDmHistory(withUserId: number): Promise<void> {
    const ack = await window.pantry.serverDmHistory(withUserId, undefined, 80)
    messages.value = (d<{ messages: ServerChatMessage[] }>(ack)?.messages ?? []).slice().reverse()
    ensureLocalForAll(messages.value)
  }
  function appendLocal(kind: MessageKind, content: string, id?: string): void {
    const s = selected.value
    if (!s) return
    const msgId = id ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    if (messages.value.some((m) => m.id === msgId)) return
    messages.value.push({
      id: msgId,
      conversationId: s.conversationId,
      type: s.kind,
      fromId: server.state.userId ?? 0,
      nick: server.state.username ?? '',
      kind,
      content,
      ts: Date.now()
    })
  }
  function failUpload(clientId: string, reason?: string): void {
    const p = pendingUploads.value.find((x) => x.clientId === clientId)
    if (p) {
      p.error = reason || '上传失败'
      p.percent = -1
    }
    setTimeout(() => {
      pendingUploads.value = pendingUploads.value.filter((x) => x.clientId !== clientId)
    }, 4000)
  }
  /** 判断是否本地音频文件路径（粘贴发送时识别为 audio，而非纯文本） */
  function isAudioFilePath(s: string): boolean {
    if (!/\\.(mp3|wav|flac|aac|ogg|oga|opus|weba|m4a|m4b|wma|ac3|aiff|aif|au|amr|alac|mka|mid|midi|cda|cue)$/i.test(s)) return false
    if (/^file:\/\//i.test(s)) return true
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true
    if (/^\/[^/]/.test(s)) return true
    return false
  }
  async function sendText(text: string): Promise<boolean> {
    const s = selected.value
    if (!s || !text.trim()) return false
    // 粘贴的是本地音频文件路径（而非纯文本）→ 走 sendFile 格式检查并记为对应音频格式
    if (isAudioFilePath(text.trim())) return sendFile(text.trim())
    const ack =
      s.kind === 'group' && s.groupId
        ? await window.pantry.serverChatSend(s.groupId, text.trim(), 'text')
        : s.dmUserId
          ? await window.pantry.serverDmSend(s.dmUserId, text.trim(), 'text')
          : null
    if (!ack) return false
    if (ack.ok) appendLocal('text', text.trim(), (ack.data as { id?: string } | undefined)?.id)
    return ack.ok
  }
  function fileKindOf(p: string): MessageKind {
    if (/\.(mp4|webm|mov|mkv|avi|m4v|flv)$/i.test(p)) return 'video'
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) return 'image'
    if (/\.(mp3|wav|flac|aac|ogg|oga|opus|weba|m4a|m4b|wma|ac3|aiff|aif|au|amr|alac|mka|mid|midi|cda|cue)$/i.test(p)) return 'audio'
    return 'file'
  }
  function baseNameOf(p: string): string {
    return p.split(/[\\/]/).pop() ?? p
  }
  async function sendFile(filePath: string, relativePath = ''): Promise<boolean> {
    const s = selected.value
    if (!s) return false
    const kind = fileKindOf(filePath)
    const clientId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const fileName = baseNameOf(filePath)
    pendingUploads.value.push({ clientId, fileName, kind, percent: 0 })
    let up: { ok: boolean; error?: string; url?: string; uuid?: string; fileName?: string; size?: number }
    try {
      up = await window.pantry.serverUploadChunked(filePath, clientId, activeCompanyId.value, relativePath)
    } catch (e) {
      failUpload(clientId, e instanceof Error ? e.message : '上传调用异常')
      return false
    }
    if (!up.ok || !up.url) {
      failUpload(clientId, up.error || '上传失败')
      return false
    }
    const url = up.url
    const ack =
      s.kind === 'group' && s.groupId
        ? await window.pantry.serverChatSend(s.groupId, url, kind)
        : s.dmUserId
          ? await window.pantry.serverDmSend(s.dmUserId, url, kind)
          : null
    if (ack && ack.ok) {
      pendingUploads.value = pendingUploads.value.filter((x) => x.clientId !== clientId)
      appendLocal(kind, url, (ack.data as { id?: string } | undefined)?.id)
      return true
    }
    failUpload(clientId, ack?.error || '发送消息失败')
    return false
  }
  async function uploadOnly(filePath: string, relativePath: string, clientId: string): Promise<{ ok: boolean; url?: string; error?: string }> {
    try {
      const up = await window.pantry.serverUploadChunked(filePath, clientId, activeCompanyId.value, relativePath)
      if (!up.ok || !up.url) return { ok: false, error: up.error || '上传失败' }
      return { ok: true, url: up.url }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '上传调用异常' }
    }
  }
  async function sendFolder(folderPath: string): Promise<boolean> {
    const s = selected.value
    if (!s) return false
    const files = await window.pantry.serverListFolderFiles(folderPath)
    if (!files.length) return false
    const clientId = `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const root = folderPath.replace(/\\/g, '/').replace(/\/+$/, '')
    const folderName = root.split('/').pop() ?? ''
    pendingUploads.value.push({ clientId, fileName: folderName, kind: 'folder', percent: 0 })
    let done = 0
    for (const f of files) {
      const rel = f.replace(/\\/g, '/')
      const relDir = rel.startsWith(root) ? rel.slice(root.length).replace(/^\/+/, '') : ''
      const dirOnly = relDir.split('/').slice(0, -1).join('/')
      const relPath = folderName ? [folderName, dirOnly].filter(Boolean).join('/') : dirOnly
      const up = await uploadOnly(f, relPath, clientId)
      if (!up.ok) {
        failUpload(clientId, up.error || '上传失败')
        return false
      }
      done += 1
      const p = pendingUploads.value.find((x) => x.clientId === clientId)
      if (p) p.percent = Math.round((done / files.length) * 100)
    }
    const companyKey = activeCompanyId.value > 0 ? String(activeCompanyId.value) : 'default'
    const folderPathRel = `${companyKey}/${folderName}`
    const ack =
      s.kind === 'group' && s.groupId
        ? await window.pantry.serverChatSend(s.groupId, folderPathRel, 'folder')
        : s.dmUserId
          ? await window.pantry.serverDmSend(s.dmUserId, folderPathRel, 'folder')
          : null
    if (ack && ack.ok) {
      pendingUploads.value = pendingUploads.value.filter((x) => x.clientId !== clientId)
      appendLocal('folder', folderPathRel, (ack.data as { id?: string } | undefined)?.id)
      return true
    }
    failUpload(clientId, ack?.error || '发送文件夹消息失败')
    return false
  }
  async function downloadFolder(content: string): Promise<{ ok: boolean; error?: string; destDir?: string; count?: number }> {
    const ack = await window.pantry.serverDownloadFolder(content)
    return { ok: ack.ok, error: ack.error, destDir: ack.data?.destDir, count: ack.data?.count }
  }
  async function sendScreenshot(): Promise<boolean> {
    const s = selected.value
    if (!s) return false
    const shot = await window.pantry.captureScreen()
    if (!shot) return false
    return sendFile(shot)
  }
  async function togglePin(conversationId: number, pinned: boolean): Promise<void> {
    const ack = await window.pantry.serverConversationPin(conversationId, pinned)
    if (ack.ok) await refreshConversations()
  }
  async function markRead(conversationId: number, lastMessageId?: number | null): Promise<void> {
    if (conversationId <= 0) return
    await window.pantry.serverConversationRead(conversationId, lastMessageId && lastMessageId > 0 ? lastMessageId : null)
    const item = conversations.value.find((c) => c.conversationId === conversationId)
    if (item) item.unread = 0
  }
  async function deleteMessage(messageId: string): Promise<{ ok: boolean; error?: string }> {
    const s = selected.value
    if (!s || !s.conversationId) return { ok: false, error: '未在会话中' }
    const target = messages.value.find((m) => m.id === messageId)
    const isOwn = target ? target.fromId === (server.state.userId ?? 0) : true
    const myId = server.state.userId ?? 0
    const ack = await window.pantry.serverMessageDelete(s.conversationId, messageId, target?.content ?? '')
    // 撤回：自己的消息本地兜底移除（含本地临时消息）；若存在同内容重复条目（同一图片本地+服务端各一条）一并移除
    if (ack.ok || isOwn || !target) {
      messages.value = messages.value.filter((m) => {
        if (m.id === messageId) return false
        if (ack.ok && target && isOwn && m.fromId === myId && m.kind === target.kind && m.content === target.content) return false
        return true
      })
      return { ok: true }
    }
    return { ok: false, error: ack.error || '撤回失败' }
  }
  async function hardDeleteMessage(messageId: string): Promise<{ ok: boolean; error?: string }> {
    const s = selected.value
    if (!s || !s.conversationId) return { ok: false, error: '未在会话中' }
    const ack = await window.pantry.serverMessageHardDelete(s.conversationId, messageId)
    if (ack.ok) messages.value = messages.value.filter((m) => m.id !== messageId)
    return { ok: ack.ok, error: ack.error }
  }
  async function notifyIfUnfocused(title: string, body: string, target?: NotifTarget): Promise<void> {
    try {
      const st = await window.pantry.getWindowState()
      if (st && !st.focused) await window.pantry.notify({ title, body, target })
    } catch {
      // 忽略
    }
  }
  function onServerMessage(msg: ServerChatMessage): void {
    const idx = messages.value.findIndex((m) => m.id === msg.id)
    const inConv =
      !!selected.value &&
      ((msg.type === 'group' && msg.conversationId === selected.value.conversationId) ||
        (msg.type === 'dm' && msg.conversationId === selected.value.conversationId))
    if (selected.value && selected.value.conversationId === 0 && msg.fromId === server.state.userId) {
      selected.value.conversationId = msg.conversationId
    }
    if (selected.value && (inConv || idx >= 0)) {
      if (idx >= 0) messages.value[idx] = msg
      else messages.value.push(msg)
      void ensureLocalPreview(msg)
      if (inConv) void markRead(selected.value.conversationId, Number(msg.id) || null)
    }
    const conv = conversations.value.find((c) => c.conversationId === msg.conversationId)
    const preview =
      msg.kind === 'text' ? msg.content : msg.kind === 'image' ? '[图片]' : msg.kind === 'video' ? '[视频]' : msg.kind === 'folder' ? '[文件夹]' : '[文件]'
    if (msg.fromId !== server.state.userId) {
      void notifyIfUnfocused(conv?.name ? `新消息：${conv.name}` : '新消息', preview, { kind: 'main', conversationId: msg.conversationId })
    }
    if (conv) {
      const isSelf = msg.fromId === server.state.userId
      if (!isSelf) conv.unread += 1
      conv.lastPreview = preview
      conv.lastMessageAt = msg.ts
    } else {
      void refreshConversations()
    }
    conversations.value.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }
  function onServerMessageDeleted(ev: { conversationId: number; messageId: string }): void {
    if (selected.value && ev.conversationId === selected.value.conversationId) {
      messages.value = messages.value.filter((m) => m.id !== ev.messageId)
    }
  }
  function onServerPresence(p: { userId: number; online: boolean }): void {
    onlineMap.value[p.userId] = p.online
  }

  return {
    ready,
    loading,
    companies,
    activeCompanyId,
    activeCompany,
    activeRole,
    isAdmin,
    isOwner,
    roleLabel,
    departments,
    members,
    groups,
    friends,
    conversations,
    selected,
    messages,
    onlineMap,
    pendingUploads,
    localCache,
    unreadTotal,
    ensureLocalPreview,
    localPreviewUrl,
    fallbackPreview,
    failUpload,
    bootstrap,
    refreshCompanies,
    refreshDepartments,
    refreshMembers,
    refreshGroups,
    refreshFriends,
    refreshConversations,
    switchCompany,
    createCompany,
    joinCompany,
    leaveCompany,
    setMemberRole,
    kickMember,
    addCompanyMember,
    loadDepartmentMembers,
    searchUsers,
    fetchHolidays,
    addHoliday,
    removeHoliday,
    addHolidays,
    removeHolidays,
    resetHolidays,
    fetchProjects,
    createProject,
    deleteProject,
    setProjectRole,
    projectMembers,
    fetchTasks,
    fetchTaskDetail,
    createTask,
    updateTask,
    deleteTask,
    setTaskStatus,
    setTaskReminder,
    addAssignment,
    removeAssignment,
    setAssignmentStatus,
    addTaskComment,
    addTaskIssue,
    resolveTaskIssue,
    requestExtension,
    decideExtension,
    fetchRequirements,
    createRequirement,
    updateRequirement,
    setRequirementStatus,
    deleteRequirement,
    linkRequirementTasks,
    fetchBugs,
    createBug,
    updateBug,
    setBugStatus,
    deleteBug,
    fetchPlans,
    createPlan,
    updatePlan,
    deletePlan,
    fetchDocs,
    createDoc,
    updateDoc,
    deleteDoc,
    fetchWiki,
    createWiki,
    updateWiki,
    deleteWiki,
    fetchDashboard,
    fetchMemberTracking,
    createDepartment,
    deleteDepartment,
    assignToDepartment,
    removeFromDepartment,
    createGroup,
    joinGroup,
    leaveGroup,
    kickGroupMember,
    addFriend,
    removeFriend,
    openGroup,
    openDm,
    openConversation,
    loadGroupHistory,
    loadDmHistory,
    sendText,
    sendFile,
    sendFolder,
    downloadFolder,
    sendScreenshot,
    togglePin,
    markRead,
    deleteMessage,
    hardDeleteMessage,
    openGroupSettings,
    closeGroupSettings,
    loadGroupSettings,
    groupSettingsOpen,
    groupSettingsId,
    groupSettingsName,
    groupSettingsMembers,
    groupSettingsLoading,
    groupSettingsMyRole,
    canManageGroup,
    isGroupOwner,
    setGroupAdmin,
    unsetGroupAdmin,
    muteGroupMember,
    addGroupMember,
    inviteGroupMember,
    kickGroupMemberUi,
    transferGroupOwner,
    dissolveGroup,
    transferCompanyOwner,
    dissolveCompany,
    onServerMessage,
    onServerMessageDeleted,
    onServerPresence
  }
})
