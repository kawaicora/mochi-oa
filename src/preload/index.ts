import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IpcChannels, IpcEvents, type NotifKind, type NotifTarget } from '../shared/ipc'
import type {
  Ack,
  AuthAck,
  NewDeviceLoginEvent,
  OpenMeetingWindowParams,
  RtcChatMessageEvent,
  RtcDmIncomingEvent,
  GroupInviteEvent,
  ServerGroupMember,
  RtcDmRejectedEvent,
  RtcEndedEvent,
  RtcGroupCallEvent,
  RtcIceServer,
  RtcKind,
  RtcPeer,
  RtcPeerJoinedEvent,
  RtcPeerLeftEvent,
  MainMailInfo,
  MainMailInput,
  RtcRoom,
  RtcSfuInfo,
  ServerChatMessage,
  ServerClientState,
  ServerMessageDeleted,
  ServerPresenceUpdate,
  ServerSession,
  ServerSettings,
  SessionRevokedEvent,
  UserProfileUpdateAck
} from '../shared/server-types'
import type { SfuAckFields } from '../shared/sfu'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_e: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

/**
 * 深拷贝为普通对象，剥掉 Vue3 reactive 的 Proxy。
 * Electron ipcRenderer.invoke 走结构化克隆，遇 Proxy 直接抛 "An object could not be cloned."；
 * 这里统一把所有入参转成纯字面量对象，一处修复、全部通道安全。
 * Date / ArrayBuffer / TypedArray 原样返回；函数/符号跳过；WeakSet 防循环引用。
 */
function toPlain(v: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (v === null || typeof v !== 'object') return v
  // 函数/符号不可结构化克隆也无意义，跳过
  if (typeof v === 'function' || typeof v === 'symbol') return undefined
  // Date / ArrayBuffer / TypedArray 原样保留
  if (v instanceof Date) return v
  if (v instanceof ArrayBuffer) return v
  if (ArrayBuffer.isView(v)) return v
  if (seen.has(v)) return undefined
  seen.add(v)
  if (Array.isArray(v)) return v.map((item) => toPlain(item, seen))
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as Record<string, unknown>)) {
    out[k] = toPlain((v as Record<string, unknown>)[k], seen)
  }
  return out
}

// 统一包装 invoke：所有参数先深拷贝去 Proxy，再交给结构化克隆
const _invoke = ipcRenderer.invoke.bind(ipcRenderer)
const safeInvoke = (channel: string, ...args: unknown[]): Promise<any> =>
  _invoke(channel, ...args.map((a) => toPlain(a)))

const api = {
  // 应用 / 窗口
  getAppInfo: (): Promise<{ version: string; name: string }> => safeInvoke(IpcChannels.appInfo),
  // 主进程日志转发到渲染层控制台：主进程 console 广播 '__main_console'，渲染层 console.log 显示
  onMainConsole: (cb: (line: string) => void): (() => void) => subscribe('__main_console', cb),
  // 品牌配置：软件名/图标（随安装包打包，运行时只读）
  getBranding: (): Promise<{
    name: string
    iconPath: string | null
    rtc: { url: string; apiKey: string; apiSecret: string; roomPrefix: string } | null
  }> => safeInvoke(IpcChannels.brandingGet),
  minimizeWindow: (): Promise<void> => safeInvoke(IpcChannels.winMinimize),
  toggleMaximize: (): Promise<void> => safeInvoke(IpcChannels.winToggleMaximize),
  closeWindow: (): Promise<void> => safeInvoke(IpcChannels.winClose),
  setMainMode: (): Promise<void> => safeInvoke(IpcChannels.winSetMainMode),
  setLoginMode: (): Promise<void> => safeInvoke(IpcChannels.winSetLoginMode),
  openMeetingWindow: (params: OpenMeetingWindowParams): Promise<void> =>
    safeInvoke(IpcChannels.openMeetingWindow, params),
  openTaskWindow: (taskId: number): Promise<void> =>
    safeInvoke(IpcChannels.openTaskWindow, taskId),
  openPreviewWindow: (params: { kind: 'pdf' | 'word' | 'excel'; path: string; name: string }): Promise<{ ok: boolean; error?: string }> =>
    safeInvoke(IpcChannels.openPreviewWindow, params),
  openRemoteWindow: (params: { room: string; iceServers: unknown[]; mode: 'remote' | 'local'; peerId: number; peerName?: string; meId: number; sfu?: { url: string; token: string; roomName: string } }): Promise<{ ok: boolean; error?: string }> =>
    safeInvoke(IpcChannels.openRemoteWindow, params),
  remoteGetParams: (): Promise<{ room: string; iceServers: unknown[]; mode: string; peerId: number; peerName: string; meId: number; sfu?: { url: string; token: string; roomName: string } } | null> =>
    safeInvoke(IpcChannels.remoteGetParams),
  openScreenshotWindow: (payload: { dataUrl: string; width: number; height: number }): Promise<void> =>
    safeInvoke(IpcChannels.openScreenshotWindow, payload),
  screenshotGetPending: (): Promise<{ dataUrl: string; width: number; height: number } | null> =>
    safeInvoke(IpcChannels.screenshotGetPending),
  screenshotSave: (dataUrl: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    safeInvoke(IpcChannels.screenshotSave, dataUrl),
  screenshotResize: (sel: { x: number; y: number; w: number; h: number }, toolbarDIP?: number): Promise<void> =>
    safeInvoke(IpcChannels.screenshotResize, sel, toolbarDIP),
  /** 独立工具栏窗口 → 截图窗口：驱动编辑命令 */
  screenshotToolbarCommand: (cmd: { action: string; value?: unknown }): void =>
    ipcRenderer.send(IpcChannels.screenshotToolbarCommand, cmd),
  /** 截图窗口订阅来自工具栏窗口的命令（返回退订函数） */
  onScreenshotToolbarCommand: (l: (cmd: { action: string; value?: unknown }) => void): (() => void) =>
    subscribe<{ action: string; value?: unknown }>(IpcEvents.screenshotToolbarCommand, l),
  /** 截图窗口：显示/隐藏独立工具栏窗口（全屏编辑时隐藏，框选时显示） */
  screenshotToolbarVisible: (visible: boolean): Promise<void> =>
    safeInvoke(IpcChannels.screenshotToolbarVisible, visible),
  /** 截图窗口：移动独立工具栏窗口到目标位置（DIP） */
  screenshotToolbarPos: (pos: { x: number; y: number; width: number; height: number }): Promise<void> =>
    safeInvoke(IpcChannels.screenshotToolbarPos, pos),
  /** 截图窗口 → 工具栏窗口：已进入编辑，工具栏切换为完整工具/颜色/保存 */
  screenshotToolbarEdit: (): void => ipcRenderer.send(IpcChannels.screenshotToolbarEdit),
  /** 工具栏窗口订阅“进入编辑”通知（返回退订函数） */
  onScreenshotToolbarEdit: (l: () => void): (() => void) => subscribe(IpcEvents.screenshotToolbarEdit, l),
  // 最小化/后台提醒：Windows 通知 + 窗口状态/唤起
  notify: (opts: { kind?: NotifKind; title: string; body: string; target?: NotifTarget; tray?: boolean }): Promise<{ ok: boolean }> =>
    safeInvoke(IpcChannels.notify, opts),
  // 解析要播放的提示音文件：自定义存在用它，丢失/为空自动回退 resources 里的默认
  resolveNotifySound: (opts: { kind?: NotifKind; customPath?: string }): Promise<{ ok: boolean; path?: string; source?: 'custom' | 'fallback' | 'default'; missing?: string; error?: string }> =>
    safeInvoke(IpcChannels.appResolveNotifySound, opts),
  getWindowState: (): Promise<{ focused: boolean; visible: boolean; minimized: boolean }> =>
    safeInvoke(IpcChannels.getWindowState),
  focusWindow: (): Promise<{ ok: boolean }> => safeInvoke(IpcChannels.focusWindow),
  getAutoLaunch: (): Promise<boolean> => safeInvoke(IpcChannels.getAutoLaunch),
  setAutoLaunch: (openAtLogin: boolean): Promise<{ ok: boolean; openAtLogin: boolean; method?: string; error?: string }> =>
    safeInvoke(IpcChannels.setAutoLaunch, openAtLogin),

  // 连接 / 状态 / 设置
  serverConnect: (serverUrl: string, token?: string): Promise<void> =>
    safeInvoke(IpcChannels.serverConnect, serverUrl, token ?? null),
  serverDisconnect: (): Promise<void> => safeInvoke(IpcChannels.serverDisconnect),
  serverGetState: (): Promise<ServerClientState> => safeInvoke(IpcChannels.serverState),
  serverGetSettings: (): Promise<ServerSettings> => safeInvoke(IpcChannels.serverGetSettings),
  serverSaveSettings: (s: Partial<ServerSettings>): Promise<ServerSettings> =>
    safeInvoke(IpcChannels.serverSaveSettings, s),
  serverSetActiveCompany: (companyId: number): Promise<void> =>
    safeInvoke(IpcChannels.serverSetActiveCompany, companyId),

  // 账号
  serverRegister: (username: string, password: string, nick?: string, email?: string, avatarPath?: string, code?: string): Promise<AuthAck> =>
    safeInvoke(IpcChannels.serverRegister, username, password, nick ?? null, email ?? null, avatarPath ?? null, code ?? null),
  serverLogin: (username: string, password?: string, code?: string): Promise<AuthAck> =>
    safeInvoke(IpcChannels.serverLogin, username, password ?? null, code ?? null),
  serverSendEmailCode: (email: string, purpose: 'register' | 'login'): Promise<Ack> =>
    safeInvoke(IpcChannels.serverSendEmailCode, email, purpose),
  serverSendResetCode: (email: string): Promise<Ack> =>
    safeInvoke(IpcChannels.serverSendResetCode, email),
  serverSendResetMail: (email: string, code: string, baseUrl: string): Promise<Ack> =>
    safeInvoke(IpcChannels.serverSendResetMail, email, code, baseUrl),
  serverLogout: (): Promise<void> => safeInvoke(IpcChannels.serverLogout),
  /** 切换服务器地址：清 token + 断开旧会话 + 用新地址重连（渲染层会回到登录页） */
  serverChangeUrl: (url: string): Promise<import('../shared/server-types').ServerSettings> =>
    safeInvoke(IpcChannels.serverChangeUrl, url),
  serverUpdateProfile: (patch: { nick?: string; avatar?: string; phone?: string; extra?: { emergency: Array<{ name: string; phone: string }> } }): Promise<UserProfileUpdateAck> =>
    safeInvoke(IpcChannels.userUpdateProfile, patch),
  serverChangePassword: (oldPassword: string, newPassword: string): Promise<Ack> =>
    safeInvoke(IpcChannels.userChangePassword, oldPassword, newPassword),
  serverGetMainMail: (): Promise<import('../shared/server-types').MainMailInfo> =>
    safeInvoke(IpcChannels.serverGetMainMail),
  serverSetMainMail: (cfg: import('../shared/server-types').MainMailInput): Promise<Ack> =>
    safeInvoke(IpcChannels.serverSetMainMail, cfg),
  serverDownloadFile: (url: string): Promise<{ ok: boolean; path?: string; fileUrl?: string; error?: string }> =>
    safeInvoke(IpcChannels.serverDownloadFile, url),
  serverReadFileBytes: (filePath: string): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> =>
    safeInvoke(IpcChannels.serverReadFileBytes, filePath),
  appSaveRecording: (name: string, base64: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    safeInvoke(IpcChannels.appSaveRecording, { name, base64 }),
  openFileLocation: (path: string): Promise<void> => safeInvoke(IpcChannels.appOpenFileLocation, path),
  /** 用系统默认程序打开本地文件（不可内嵌预览的文件走这里，等同双击文件） */
  openPath: (path: string): Promise<{ ok: boolean; error?: string }> => safeInvoke(IpcChannels.appOpenPath, path),
  // 登录会话（多端）/ 账号安全
  serverSessions: (): Promise<Ack & { data?: { sessions: ServerSession[]; currentSessionId?: number; sessionDays?: number | null } }> =>
    safeInvoke(IpcChannels.serverSessions),
  serverEndSession: (sessionId: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverEndSession, sessionId),
  serverEndAllSessions: (): Promise<Ack> => safeInvoke(IpcChannels.serverEndAllSessions),
  serverSetSessionDays: (days: number | null): Promise<Ack> =>
    safeInvoke(IpcChannels.serverSetSessionDays, days),

  // 公司 / 部门
  serverListCompanies: (): Promise<Ack> => safeInvoke(IpcChannels.serverCompanies),
  serverCreateCompany: (name: string, code?: string): Promise<Ack> =>
    safeInvoke(IpcChannels.serverCompanyCreate, name, code ?? null),
  serverJoinCompany: (code: string): Promise<Ack> => safeInvoke(IpcChannels.serverCompanyJoin, code),
  serverSearchCompanies: (keyword?: string): Promise<Ack> =>
    safeInvoke(IpcChannels.serverCompanySearch, keyword ?? null),
  serverLeaveCompany: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverCompanyLeave, companyId),
  serverSetCompanyRole: (companyId: number, userId: number, role: 'owner' | 'admin' | 'member'): Promise<Ack> =>
    safeInvoke(IpcChannels.serverCompanySetRole, companyId, userId, role),
  serverKickCompanyMember: (companyId: number, userId: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverCompanyKick, companyId, userId),
  serverDepartments: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverDepartments, companyId),
  serverCreateDepartment: (companyId: number, name: string, parentId?: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverDepartmentCreate, companyId, name, parentId ?? null),
  serverAssignDepartment: (departmentId: number, userId: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverDepartmentAssign, departmentId, userId),
  serverRemoveDepartmentMember: (departmentId: number, userId: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverDepartmentRemoveMember, departmentId, userId),
  serverMembers: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverMembers, companyId),
  serverAddCompanyMember: (companyId: number, target: number | string, departmentId?: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverCompanyAddMember, companyId, target, departmentId ?? null),
  serverSearchUsers: (keyword: string): Promise<Ack> => safeInvoke(IpcChannels.serverUserSearch, keyword),
  serverDeleteDepartment: (companyId: number, departmentId: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverDepartmentDelete, companyId, departmentId),
  serverDepartmentMembers: (departmentId: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverDepartmentMembers, departmentId),

  // 群
  serverListGroups: (): Promise<Ack> => safeInvoke(IpcChannels.serverGroups),
  serverCreateGroup: (companyId: number, name: string, departmentId?: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverGroupCreate, companyId, name, departmentId ?? null),
  serverJoinGroup: (code: string): Promise<Ack> => safeInvoke(IpcChannels.serverGroupJoin, code),
  serverSearchGroups: (companyId?: number, keyword?: string): Promise<Ack> =>
    safeInvoke(IpcChannels.serverGroupSearch, companyId ?? null, keyword ?? null),
  serverLeaveGroup: (groupId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupLeave, groupId),
  serverKickGroupMember: (groupId: number, userId: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverGroupKick, groupId, userId),
  serverGroupMembers: (groupId: number): Promise<Ack & { data?: { members: ServerGroupMember[] } }> =>
    safeInvoke(IpcChannels.serverGroupMembers, groupId),
  serverGroupSetAdmin: (groupId: number, userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupSetAdmin, groupId, userId),
  serverGroupUnsetAdmin: (groupId: number, userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupUnsetAdmin, groupId, userId),
  serverGroupMute: (groupId: number, userId: number, seconds: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupMute, groupId, userId, seconds),
  serverGroupAdd: (groupId: number, userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupAdd, groupId, userId),
  serverGroupInvite: (groupId: number, userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupInvite, groupId, userId),
  serverGroupAcceptInvite: (groupId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupAcceptInvite, groupId),
  serverGroupDeclineInvite: (groupId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupDeclineInvite, groupId),
  serverGroupTransfer: (groupId: number, userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupTransfer, groupId, userId),
  serverGroupDissolve: (groupId: number): Promise<Ack> => safeInvoke(IpcChannels.serverGroupDissolve, groupId),
  serverCompanyTransfer: (companyId: number, userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverCompanyTransfer, companyId, userId),
  serverCompanyDissolve: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverCompanyDissolve, companyId),
  serverUpdateCompanyLogo: (companyId: number, logo: string): Promise<Ack> => safeInvoke(IpcChannels.serverUpdateCompanyLogo, companyId, logo),

  // 会话 / 聊天
  serverConversations: (type?: 'group' | 'dm'): Promise<Ack> =>
    safeInvoke(IpcChannels.serverConversations, type ?? null),
  serverConversationPin: (conversationId: number, pinned: boolean): Promise<Ack> =>
    safeInvoke(IpcChannels.serverConversationPin, conversationId, pinned),
  serverConversationRead: (conversationId: number, lastMessageId?: number | null): Promise<Ack> =>
    safeInvoke(IpcChannels.serverConversationRead, conversationId, lastMessageId && lastMessageId > 0 ? lastMessageId : null),
  serverChatHistory: (groupId: number, beforeTs?: number, limit?: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverChatHistory, groupId, beforeTs ?? null, limit ?? null),
  serverChatSend: (groupId: number, content: string, kind?: 'text' | 'image' | 'file' | 'video' | 'audio' | 'folder' | 'proxy_card' | 'expense_card' | 'advance_card' | 'attendance_card'): Promise<Ack> =>
    safeInvoke(IpcChannels.serverChatSend, groupId, content, kind ?? null),
  serverDmHistory: (withUserId: number, beforeTs?: number, limit?: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverDmHistory, withUserId, beforeTs ?? null, limit ?? null),
  serverDmSend: (toUserId: number, content: string, kind?: 'text' | 'image' | 'file' | 'video' | 'audio' | 'folder' | 'proxy_card' | 'expense_card' | 'advance_card' | 'attendance_card'): Promise<Ack> =>
    safeInvoke(IpcChannels.serverDmSend, toUserId, content, kind ?? null),
  serverMessageDelete: (conversationId: number, messageId: string, content?: string): Promise<Ack> =>
    safeInvoke(IpcChannels.serverMessageDelete, conversationId, messageId, content ?? ''),
  serverMessageHardDelete: (conversationId: number, messageId: string): Promise<Ack> =>
    safeInvoke(IpcChannels.serverMessageHardDelete, conversationId, messageId),

  // 好友
  serverListFriends: (): Promise<Ack> => safeInvoke(IpcChannels.serverFriends),
  serverAddFriend: (userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverFriendAdd, userId),
  serverRemoveFriend: (userId: number): Promise<Ack> => safeInvoke(IpcChannels.serverFriendRemove, userId),
  serverHolidays: (year?: number): Promise<Ack> => safeInvoke(IpcChannels.serverHolidays, year),
  serverHolidayAdd: (date: string, name: string, type: string): Promise<Ack> => safeInvoke(IpcChannels.serverHolidayAdd, date, name, type),
  serverHolidayRemove: (date: string): Promise<Ack> => safeInvoke(IpcChannels.serverHolidayRemove, date),
  serverHolidayAddMany: (items: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverHolidayAddMany, items),
  serverHolidayRemoveMany: (dates: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverHolidayRemoveMany, dates),
  serverHolidayReset: (): Promise<Ack> => safeInvoke(IpcChannels.serverHolidayReset),
  // 任务流程系统
  serverTaskListProjects: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskProjects, companyId),
  serverTaskCreateProject: (companyId: number, name: string): Promise<Ack> => safeInvoke(IpcChannels.serverTaskProjectCreate, companyId, name),
  serverTaskDeleteProject: (companyId: number, projectId: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskProjectDelete, companyId, projectId),
  serverTaskSetProjectRole: (companyId: number, projectId: number, userId: number, role: string): Promise<Ack> => safeInvoke(IpcChannels.serverTaskProjectSetRole, companyId, projectId, userId, role),
  serverTaskProjectMembers: (projectId: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskProjectMembers, projectId),
  serverTaskList: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskList, companyId, projectId),
  serverTaskDetail: (taskId: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskDetail, taskId),
  serverTaskCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverTaskCreate, payload),
  serverTaskUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverTaskUpdate, payload),
  serverTaskDelete: (taskId: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskDelete, taskId),
  serverTaskSetStatus: (taskId: number, status: string, note: string): Promise<Ack> => safeInvoke(IpcChannels.serverTaskSetStatus, taskId, status, note),
  serverTaskSetReminder: (taskId: number, y: number, r: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskSetReminder, taskId, y, r),
  serverTaskAddAssignment: (taskId: number, userId: number, content: string): Promise<Ack> => safeInvoke(IpcChannels.serverTaskAddAssignment, taskId, userId, content),
  serverTaskRemoveAssignment: (id: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskRemoveAssignment, id),
  serverTaskSetAssignmentStatus: (id: number, status: string): Promise<Ack> => safeInvoke(IpcChannels.serverTaskSetAssignmentStatus, id, status),
  serverTaskComment: (taskId: number, content: string, attachments?: Array<{ kind: string; url: string; name: string }>): Promise<Ack> => safeInvoke(IpcChannels.serverTaskComment, taskId, content, attachments ?? []),
  serverTaskAddIssue: (taskId: number, title: string, content: string): Promise<Ack> => safeInvoke(IpcChannels.serverTaskAddIssue, taskId, title, content),
  serverTaskResolveIssue: (issueId: number): Promise<Ack> => safeInvoke(IpcChannels.serverTaskResolveIssue, issueId),
  serverTaskRequestExtension: (taskId: number, dt: string, reason: string): Promise<Ack> => safeInvoke(IpcChannels.serverTaskRequestExtension, taskId, dt, reason),
  serverTaskDecideExtension: (companyId: number, taskId: number, extensionId: number, approved: boolean): Promise<Ack> => safeInvoke(IpcChannels.serverTaskDecideExtension, companyId, taskId, extensionId, approved),

  // TAPD 项目管理
  serverReqList: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverReqList, companyId, projectId),
  serverReqCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReqCreate, payload),
  serverReqUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReqUpdate, payload),
  serverReqStatus: (id: number, status: string): Promise<Ack> => safeInvoke(IpcChannels.serverReqStatus, id, status),
  serverReqDelete: (id: number): Promise<Ack> => safeInvoke(IpcChannels.serverReqDelete, id),
  serverReqLinkTasks: (id: number, taskIds: number[]): Promise<Ack> => safeInvoke(IpcChannels.serverReqLinkTasks, id, taskIds),
  serverBugList: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverBugList, companyId, projectId),
  serverBugCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverBugCreate, payload),
  serverBugUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverBugUpdate, payload),
  serverBugStatus: (id: number, status: string): Promise<Ack> => safeInvoke(IpcChannels.serverBugStatus, id, status),
  serverBugDelete: (id: number): Promise<Ack> => safeInvoke(IpcChannels.serverBugDelete, id),
  serverPlanList: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverPlanList, companyId, projectId),
  serverPlanCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverPlanCreate, payload),
  serverPlanUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverPlanUpdate, payload),
  serverPlanDelete: (id: number): Promise<Ack> => safeInvoke(IpcChannels.serverPlanDelete, id),
  serverDocList: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverDocList, companyId, projectId),
  serverDocCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverDocCreate, payload),
  serverDocUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverDocUpdate, payload),
  serverDocDelete: (id: number): Promise<Ack> => safeInvoke(IpcChannels.serverDocDelete, id),
  serverWikiList: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverWikiList, companyId, projectId),
  serverWikiCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverWikiCreate, payload),
  serverWikiUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverWikiUpdate, payload),
  serverWikiDelete: (id: number): Promise<Ack> => safeInvoke(IpcChannels.serverWikiDelete, id),
  serverPmDashboard: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverPmDashboard, companyId, projectId),
  serverPmMemberTracking: (companyId: number, projectId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverPmMemberTracking, companyId, projectId),

  // 日报 / 周报（公司隔离）
  serverReportCurrent: (companyId: number, type: string): Promise<Ack> => safeInvoke(IpcChannels.serverReportCurrent, companyId, type),
  serverReportCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReportCreate, payload),
  serverReportUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReportUpdate, payload),
  serverReportSubmit: (companyId: number, id: number): Promise<Ack> => safeInvoke(IpcChannels.serverReportSubmit, companyId, id),
  serverReportDelete: (companyId: number, id: number): Promise<Ack> => safeInvoke(IpcChannels.serverReportDelete, companyId, id),
  serverReportList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReportList, payload),
  serverReportInbox: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReportInbox, payload),
  serverReportTemplateList: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverReportTemplateList, companyId),
  serverReportTemplateCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReportTemplateCreate, payload),
  serverReportTemplateUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReportTemplateUpdate, payload),
  serverReportTemplateDelete: (companyId: number, id: number): Promise<Ack> => safeInvoke(IpcChannels.serverReportTemplateDelete, companyId, id),
  serverReportStats: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverReportStats, payload),

  // 考勤申请
  serverAttendanceCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceCreate, payload),
  serverAttendanceList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceList, payload),
  serverAttendanceStatList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceStatList, payload),
  serverAttendanceApprove: (companyId: number, id: number): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceApprove, companyId, id),
  serverAttendanceReject: (companyId: number, id: number, note?: string): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceReject, companyId, id, note ?? ''),
  // 审批流程配置
  serverApprovalFlowGet: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverApprovalFlowGet, payload),
  serverApprovalFlowSave: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverApprovalFlowSave, payload),
  serverApprovalFlowList: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverApprovalFlowList, companyId),
  // 打卡
  serverCheckinCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverCheckinCreate, payload),
  serverCheckinList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverCheckinList, payload),
  serverCheckinSettingsGet: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverCheckinSettingsGet, companyId),
  serverCheckinSettingsSave: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverCheckinSettingsSave, payload),
  serverCheckinRulesGet: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverCheckinRulesGet, companyId),
  serverCheckinRulesSave: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverCheckinRulesSave, payload),
  serverCheckinStatusGet: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverCheckinStatusGet, payload),
  serverApprovalSettingsGet: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverApprovalSettingsGet, companyId),
  serverApprovalSettingsSet: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverApprovalSettingsSet, payload),
  serverProxyCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverProxyCreate, payload),
  serverProxyList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverProxyList, payload),
  serverProxyGet: (id: number): Promise<Ack> => safeInvoke(IpcChannels.serverProxyGet, id),
  serverProxyApprove: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverProxyApprove, payload),
  serverProxyReject: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverProxyReject, payload),
  serverProxyRenew: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverProxyRenew, payload),
  serverProxyAccountList: (companyId: number): Promise<Ack> => safeInvoke(IpcChannels.serverProxyAccountList, companyId),
  serverProxyNotifyStop: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverProxyNotifyStop, payload),
  serverProxyServerList: (): Promise<Ack> => safeInvoke(IpcChannels.serverProxyServerList, {}),
  serverAttendanceReceived: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceReceived, payload),
  serverAttendanceCc: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceCc, payload),
  serverAttendanceCcView: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceCcView, payload),
  serverAttendanceNotifyStop: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAttendanceNotifyStop, payload),
  // 报销申请（公司隔离）
  serverCreateExpense: (payload: { category: string; amount: number; reason: string; evidence: string[]; approverIds: number[]; ccIds: number[]; companyId?: number }): Promise<Ack> =>
    safeInvoke(IpcChannels.serverExpenseCreate, payload),
  serverExpenseList: (params: { category?: string; page: number; pageSize: number; companyId?: number }): Promise<Ack> =>
    safeInvoke(IpcChannels.serverExpenseList, params),
  serverExpenseReceived: (companyId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverExpenseReceived, companyId ?? 0),
  serverExpenseCc: (companyId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverExpenseCc, companyId ?? 0),
  serverExpenseCcView: (requestId: number): Promise<Ack> => safeInvoke(IpcChannels.serverExpenseCcView, requestId),
  serverExpenseApprove: (requestId: number, note?: string): Promise<Ack> => safeInvoke(IpcChannels.serverExpenseApprove, requestId, note ?? ''),
  serverExpenseReject: (requestId: number, note: string): Promise<Ack> => safeInvoke(IpcChannels.serverExpenseReject, requestId, note),
  // 备用金借款（公司隔离）
  serverAdvanceCreate: (payload: { category: string; amount: number; reason: string; evidence: string[]; approverIds: number[]; ccIds: number[]; companyId?: number }): Promise<Ack> =>
    safeInvoke(IpcChannels.serverAdvanceCreate, payload),
  serverAdvanceList: (params: { category?: string; page: number; pageSize: number; companyId?: number }): Promise<Ack> =>
    safeInvoke(IpcChannels.serverAdvanceList, params),
  serverAdvanceReceived: (companyId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverAdvanceReceived, companyId ?? 0),
  serverAdvanceCc: (companyId?: number): Promise<Ack> => safeInvoke(IpcChannels.serverAdvanceCc, companyId ?? 0),
  serverAdvanceCcView: (requestId: number): Promise<Ack> => safeInvoke(IpcChannels.serverAdvanceCcView, requestId),
  serverAdvanceApprove: (requestId: number, note?: string): Promise<Ack> => safeInvoke(IpcChannels.serverAdvanceApprove, requestId, note ?? ''),
  serverAdvanceReject: (requestId: number, note: string): Promise<Ack> => safeInvoke(IpcChannels.serverAdvanceReject, requestId, note),
  systemProxySet: (target: unknown): Promise<Ack> => safeInvoke(IpcChannels.systemProxySet, target),
  systemProxyClear: (target?: unknown): Promise<Ack> => safeInvoke(IpcChannels.systemProxyClear, target ?? null),
  tunProxySet: (target: unknown): Promise<Ack> => safeInvoke(IpcChannels.tunProxySet, target),
  tunProxyClear: (target?: unknown): Promise<Ack> => safeInvoke(IpcChannels.tunProxyClear, target ?? null),
  // 取本机 MAC（返回大写无冒号字符串）
  getMac: (): Promise<string> => safeInvoke(IpcChannels.getMac),
  // 资产管理
  serverAssetCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAssetCreate, payload),
  serverAssetList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAssetList, payload),
  serverAssetGet: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAssetGet, payload),
  serverAssetUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAssetUpdate, payload),
  serverAssetDelete: (companyId: number, id: number): Promise<Ack> => safeInvoke(IpcChannels.serverAssetDelete, companyId, id),
  serverAssetFlowCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAssetFlowCreate, payload),
  serverAssetFlowList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverAssetFlowList, payload),
  // 公司职位系统
  serverJobCreate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverJobCreate, payload),
  serverJobUpdate: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverJobUpdate, payload),
  serverJobDelete: (companyId: number, id: number): Promise<Ack> => safeInvoke(IpcChannels.serverJobDelete, companyId, id),
  serverJobList: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverJobList, payload),
  serverJobBind: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverJobBind, payload),
  serverJobBindings: (payload: unknown): Promise<Ack> => safeInvoke(IpcChannels.serverJobBindings, payload),

  // 文件上传
  serverUploadFile: (filePath: string, companyId?: number): Promise<Ack> =>
    safeInvoke(IpcChannels.serverUpload, filePath, companyId ?? 0),
  serverUploadChunked: (filePath: string, clientId: string, companyId?: number, relativePath?: string): Promise<{ ok: boolean; error?: string; url?: string; uuid?: string; fileName?: string; size?: number }> =>
    safeInvoke(IpcChannels.serverUploadChunked, filePath, clientId, companyId ?? 0, relativePath ?? ''),
  pickFile: (filter?: 'image' | 'video' | 'audio'): Promise<string | null> => safeInvoke(IpcChannels.filePick, filter ?? null),
  pickFiles: (filter?: 'image' | 'video' | 'audio'): Promise<string[]> => safeInvoke(IpcChannels.filePickMulti, filter ?? null),
  pickFolder: (): Promise<string | null> => safeInvoke(IpcChannels.filePickFolder),
  // 拖放上传：从 File 对象取磁盘绝对路径（Electron 30+ 用 webUtils；旧版回退 File.path）
  pathForFile: (file: File): string => {
    try {
      if (typeof webUtils?.getPathForFile === 'function') return webUtils.getPathForFile(file)
    } catch {
      /* 回退到旧版 File.path */
    }
    return (file as unknown as { path?: string }).path ?? ''
  },
  serverListFolderFiles: (folderPath: string): Promise<string[]> =>
    safeInvoke(IpcChannels.serverListFolderFiles, folderPath),
  serverDownloadFolder: (relPath: string): Promise<Ack & { data?: { destDir?: string; count?: number } }> =>
    safeInvoke(IpcChannels.serverDownloadFolder, relPath),
  captureScreen: (): Promise<{ dataUrl: string; width: number; height: number } | null> =>
    safeInvoke(IpcChannels.fileCaptureScreen),
  writeTempImage: (dataUrl: string): Promise<string | null> => safeInvoke(IpcChannels.fileWriteTempImage, dataUrl),

  // RTC 信令
  rtcCreateMeeting: (opts: { title?: string; startAt?: string; password?: string; kind: RtcKind }): Promise<Ack & { data?: { meeting: RtcRoom; scheduled: boolean; peers?: RtcPeer[]; iceServers?: RtcIceServer[] } & SfuAckFields }> =>
    safeInvoke(IpcChannels.rtcCreateMeeting, opts),
  rtcGetMeeting: (meetingNo: string): Promise<Ack & { data?: { meeting: RtcRoom } }> =>
    safeInvoke(IpcChannels.rtcGetMeeting, meetingNo),
  rtcJoin: (roomId: string, password?: string, kind?: RtcKind): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[]; started: boolean } & SfuAckFields }> =>
    safeInvoke(IpcChannels.rtcJoin, roomId, password ?? null, kind ?? null),
  rtcLeave: (roomId: string): Promise<Ack> =>
    safeInvoke(IpcChannels.rtcLeave, roomId),
  rtcEnd: (roomId: string): Promise<Ack> =>
    safeInvoke(IpcChannels.rtcEnd, roomId),
  rtcDmCall: (userId: number, kind: RtcKind, password?: string): Promise<Ack & { data?: { room: RtcRoom; kind: RtcKind; iceServers?: RtcIceServer[] } & SfuAckFields }> =>
    safeInvoke(IpcChannels.rtcDmCall, userId, kind, password ?? undefined),
  rtcDmAnswer: (roomId: string, accept: boolean): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } & SfuAckFields }> =>
    safeInvoke(IpcChannels.rtcDmAnswer, roomId, accept),
  rtcGroupCall: (groupId: number, kind: RtcKind): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } & SfuAckFields }> =>
    safeInvoke(IpcChannels.rtcGroupCall, groupId, kind),
  rtcChatMessage: (roomId: string, content: string): Promise<Ack> =>
    safeInvoke(IpcChannels.rtcChatSend, roomId, content),
  // 远程控制输入注入（被控端）：start 选后端+设键鼠模式（返回能力描述）/ event 分发控制指令 / stop 复位+结束
  remoteInputStart: (
    mode: 'remote' | 'local',
    screen?: { w: number; h: number }
  ): Promise<{ ok: boolean; capability?: { ok: boolean; backend: string; detail: string; screen?: { w: number; h: number } } }> =>
    safeInvoke(IpcChannels.remoteInputStart, mode, screen ?? null),
  remoteInputStop: (): Promise<{ ok: boolean }> =>
    safeInvoke(IpcChannels.remoteInputStop),
  remoteInputEvent: (evt: Record<string, unknown>): Promise<{ ok: boolean }> =>
    safeInvoke(IpcChannels.remoteInputEvent, evt),
  // 远程设备控制（被控端）
  devGetInfo: (): Promise<{ deviceId: string; hostname: string; os: string; ip: string }> =>
    safeInvoke(IpcChannels.devGetInfo),
  devRegister: (p: { deviceId: string; name: string; os: string; ip: string; username: string }): Promise<Ack> =>
    safeInvoke(IpcChannels.devRegister, p),
  devHeartbeat: (info: { deviceId: string; name?: string; os?: string; ip?: string; username?: string }): Promise<void> => safeInvoke(IpcChannels.devHeartbeat, info),
  devDevices: (deviceId: string, cams: Array<{ id: string; label: string }>, mics: Array<{ id: string; label: string }>): Promise<Ack> =>
    safeInvoke(IpcChannels.devDevices, deviceId, cams, mics),
  /** 控制端发起查看远程设备（SERVER_ADMIN）：服务端签发 SFU token 下发 */
  devView: (deviceId: string): Promise<Ack & { data?: { deviceId?: string; url?: string; token?: string; roomName?: string } }> =>
    safeInvoke(IpcChannels.devView, deviceId),

  // 推送订阅
  onServerState: (l: (s: ServerClientState) => void) => subscribe<ServerClientState>(IpcEvents.serverState, l),
  onServerMessage: (l: (m: ServerChatMessage) => void) => subscribe<ServerChatMessage>(IpcEvents.serverMessage, l),
  onNavigateToConversation: (l: (conversationId: number) => void) => subscribe<number>(IpcEvents.navigateToConversation, l),
  /** 需求 7.3：审批卡片系统通知被点击 → 渲染层深链到对应审批 View */
  onOpenApprovalCard: (l: (d: { cardKind: 'attendance_card' | 'expense_card' | 'advance_card' | 'proxy_card'; requestId: number }) => void) =>
    subscribe<{ cardKind: 'attendance_card' | 'expense_card' | 'advance_card' | 'proxy_card'; requestId: number }>(IpcEvents.openApprovalCard, l),
  onServerPresence: (l: (p: ServerPresenceUpdate) => void) => subscribe<ServerPresenceUpdate>(IpcEvents.serverPresence, l),
  onUserProfileUpdated: (l: (d: { user: { id: number; username: string; nick: string; avatar: string; email: string; phone: string; extra: string } }) => void) => subscribe<{ user: { id: number; username: string; nick: string; avatar: string; email: string; phone: string; extra: string } }>(IpcEvents.userProfileUpdated, l),
  onServerMessageDeleted: (l: (d: ServerMessageDeleted) => void) =>
    subscribe<ServerMessageDeleted>(IpcEvents.serverMessageDeleted, l),
  onServerConversationsUpdated: (l: (d: unknown) => void) => subscribe<unknown>(IpcEvents.serverConversationsUpdated, l),
  onServerChatReadReceipt: (l: (d: { conversationId: number; userId: number; lastReadMessageId: number | null }) => void) =>
    subscribe<{ conversationId: number; userId: number; lastReadMessageId: number | null }>(IpcEvents.serverChatReadReceipt, l),
  onServerSessionNewDevice: (l: (d: NewDeviceLoginEvent) => void) =>
    subscribe<NewDeviceLoginEvent>(IpcEvents.serverSessionNewDevice, l),
  onServerSessionRevoked: (l: (d: SessionRevokedEvent) => void) =>
    subscribe<SessionRevokedEvent>(IpcEvents.serverSessionRevoked, l),
  /** 断线连续重试仍失败 → 回登录页（token 保留） */
  onServerReconnectGaveUp: (l: (d: { reason: string; at: string }) => void) =>
    subscribe<{ reason: string; at: string }>(IpcEvents.serverReconnectGaveUp, l),

  // RTC 信令推送订阅
  onRtcDmIncoming: (l: (d: RtcDmIncomingEvent) => void) => subscribe<RtcDmIncomingEvent>(IpcEvents.rtcDmIncoming, l),
  onRtcDmRejected: (l: (d: RtcDmRejectedEvent) => void) => subscribe<RtcDmRejectedEvent>(IpcEvents.rtcDmRejected, l),
  onRtcPeerJoined: (l: (d: RtcPeerJoinedEvent) => void) => subscribe<RtcPeerJoinedEvent>(IpcEvents.rtcPeerJoined, l),
  onRtcPeerLeft: (l: (d: RtcPeerLeftEvent) => void) => subscribe<RtcPeerLeftEvent>(IpcEvents.rtcPeerLeft, l),
  onRtcEnded: (l: (d: RtcEndedEvent) => void) => subscribe<RtcEndedEvent>(IpcEvents.rtcEnded, l),
  onRtcGroupCall: (l: (d: RtcGroupCallEvent) => void) => subscribe<RtcGroupCallEvent>(IpcEvents.rtcGroupCall, l),
  onRtcChatMessage: (l: (d: RtcChatMessageEvent) => void) => subscribe<RtcChatMessageEvent>(IpcEvents.rtcChatMessage, l),
  // 远程设备控制（被控端）事件订阅
  onDevView: (l: (d: { deviceId?: string; url?: string; token?: string; roomName?: string }) => void) => subscribe<{ deviceId?: string; url?: string; token?: string; roomName?: string }>(IpcEvents.devView, l),
  onDevEnumerate: (l: (d: { deviceId?: string }) => void) => subscribe<{ deviceId?: string }>(IpcEvents.devEnumerate, l),
  onDevStart: (l: (d: { deviceId?: string; kind?: string; device?: unknown }) => void) => subscribe<{ deviceId?: string; kind?: string; device?: unknown }>(IpcEvents.devStart, l),
  onDevStop: (l: (d: { deviceId?: string }) => void) => subscribe<{ deviceId?: string }>(IpcEvents.devStop, l),
  onGroupMembersUpdated: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupMembersUpdated, l),
  onGroupInvite: (l: (d: GroupInviteEvent) => void) => subscribe<GroupInviteEvent>(IpcEvents.groupInvite, l),
  onGroupDissolved: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupDissolved, l),
  onCompanyDissolved: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyDissolved, l),
  onCompanyUpdated: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyUpdated, l),
  onCompanyRemoved: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyRemoved, l),
  onCompanyAdded: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyAdded, l),
  onCompanyNotified: (l: (d: unknown) => void) => subscribe<unknown>(IpcEvents.companyNotified, l),
  onGroupAdded: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupAdded, l),
  onGroupRemoved: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupRemoved, l),
  onFriendsUpdated: (l: () => void) => subscribe<unknown>(IpcEvents.friendsUpdated, () => l()),
  onHolidaysUpdated: (l: () => void) => subscribe<unknown>(IpcEvents.holidaysUpdated, () => l()),
  onTasksUpdated: (l: (d: { companyId?: number }) => void) => subscribe<{ companyId?: number }>(IpcEvents.tasksUpdated, l),
  onProjectsUpdated: (l: (d: { companyId?: number }) => void) => subscribe<{ companyId?: number }>(IpcEvents.projectsUpdated, l),
  onRequirementsUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.requirementsUpdated, l),
  /** 日报/周报到点提醒推送回调 */
  onReportReminder: (l: (d: { companyId?: number; type?: string; periodDate?: string; missingUsers?: Array<{ userId: number; nick?: string; username?: string }> }) => void) =>
    subscribe<{ companyId?: number; type?: string; periodDate?: string; missingUsers?: Array<{ userId: number; nick?: string; username?: string }> }>(IpcEvents.reportReminder, l),
  onBugsUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.bugsUpdated, l),
  onPlansUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.plansUpdated, l),
  onDocsUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.docsUpdated, l),
  onWikiUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.wikiUpdated, l),
  runAlarmCommand: (command: string): Promise<{ ok: boolean; error?: string }> => safeInvoke(IpcChannels.alarmRun, command),
  readAudioFile: (path: string): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> => safeInvoke(IpcChannels.audioReadFile, path),
  onUploadProgress: (l: (d: { clientId: string; percent: number }) => void) => subscribe<{ clientId: string; percent: number }>(IpcEvents.uploadProgress, l),
  onDownloadProgress: (l: (d: { url: string; received: number; total: number; percent: number }) => void) =>
    subscribe<{ url: string; received: number; total: number; percent: number }>(IpcEvents.downloadProgress, l),
  onScreenshotSaved: (l: (path: string) => void) => subscribe<string>(IpcEvents.screenshotSaved, l),
  // 消息右键「复制」：文本/表情 → writeClipboardText；图片 → writeClipboardImage(本地绝对路径)
  writeClipboardText: (text: string): Promise<{ ok: boolean; error?: string }> =>
    safeInvoke(IpcChannels.appClipboardWriteText, text),
  writeClipboardImage: (path: string): Promise<{ ok: boolean; error?: string }> =>
    safeInvoke(IpcChannels.appClipboardWriteImage, path),
  // 粘贴剪贴板图片：渲染层只有 blob，落成临时文件拿路径后复用 sendFile 上传
  writeTempFile: (payload: { name: string; data: ArrayBuffer }): Promise<{ ok: boolean; path?: string; error?: string }> =>
    safeInvoke(IpcChannels.appWriteTempFile, payload)
}

export type PantryApi = typeof api

contextBridge.exposeInMainWorld('pantry', api)
