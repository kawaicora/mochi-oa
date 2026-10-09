import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannels, IpcEvents, type NotifTarget } from '../shared/ipc'
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
  RtcSignalEvent,
  RtcSignalPayload,
  ServerChatMessage,
  ServerClientState,
  ServerMessageDeleted,
  ServerPresenceUpdate,
  ServerSession,
  ServerSettings,
  SessionRevokedEvent,
  UserProfileUpdateAck
} from '../shared/server-types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_e: unknown, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api = {
  // 应用 / 窗口
  getAppInfo: (): Promise<{ version: string; name: string }> => ipcRenderer.invoke(IpcChannels.appInfo),
  // 品牌配置：软件名/图标（随安装包打包，运行时只读）
  getBranding: (): Promise<{ name: string; iconPath: string | null }> => ipcRenderer.invoke(IpcChannels.brandingGet),
  // 渲染进程错误日志（写 userData/logs/renderer-error.log）
  logError: (msg: string): void => { ipcRenderer.send(IpcChannels.logError, msg) },
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winMinimize),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winToggleMaximize),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winClose),
  setMainMode: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winSetMainMode),
  setLoginMode: (): Promise<void> => ipcRenderer.invoke(IpcChannels.winSetLoginMode),
  openMeetingWindow: (params: OpenMeetingWindowParams): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openMeetingWindow, params),
  openTaskWindow: (taskId: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openTaskWindow, taskId),
  openScreenshotWindow: (payload: { dataUrl: string; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.openScreenshotWindow, payload),
  screenshotGetPending: (): Promise<{ dataUrl: string; width: number; height: number } | null> =>
    ipcRenderer.invoke(IpcChannels.screenshotGetPending),
  screenshotSave: (dataUrl: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.screenshotSave, dataUrl),
  screenshotResize: (sel: { x: number; y: number; w: number; h: number }, toolbarDIP?: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.screenshotResize, sel, toolbarDIP),
  /** 独立工具栏窗口 → 截图窗口：驱动编辑命令 */
  screenshotToolbarCommand: (cmd: { action: string; value?: unknown }): void =>
    ipcRenderer.send(IpcChannels.screenshotToolbarCommand, cmd),
  /** 截图窗口订阅来自工具栏窗口的命令（返回退订函数） */
  onScreenshotToolbarCommand: (l: (cmd: { action: string; value?: unknown }) => void): (() => void) =>
    subscribe<{ action: string; value?: unknown }>(IpcEvents.screenshotToolbarCommand, l),
  /** 截图窗口：显示/隐藏独立工具栏窗口（全屏编辑时隐藏，框选时显示） */
  screenshotToolbarVisible: (visible: boolean): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.screenshotToolbarVisible, visible),
  /** 截图窗口：移动独立工具栏窗口到目标位置（DIP） */
  screenshotToolbarPos: (pos: { x: number; y: number; width: number; height: number }): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.screenshotToolbarPos, pos),
  /** 截图窗口 → 工具栏窗口：已进入编辑，工具栏切换为完整工具/颜色/保存 */
  screenshotToolbarEdit: (): void => ipcRenderer.send(IpcChannels.screenshotToolbarEdit),
  /** 工具栏窗口订阅“进入编辑”通知（返回退订函数） */
  onScreenshotToolbarEdit: (l: () => void): (() => void) => subscribe(IpcEvents.screenshotToolbarEdit, l),
  // 最小化/后台提醒：Windows 通知 + 窗口状态/唤起
  notify: (opts: { title: string; body: string; target?: NotifTarget; tray?: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IpcChannels.notify, opts),
  getWindowState: (): Promise<{ focused: boolean; visible: boolean; minimized: boolean }> =>
    ipcRenderer.invoke(IpcChannels.getWindowState),
  focusWindow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IpcChannels.focusWindow),
  getAutoLaunch: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.getAutoLaunch),
  setAutoLaunch: (openAtLogin: boolean): Promise<{ ok: boolean; openAtLogin: boolean }> =>
    ipcRenderer.invoke(IpcChannels.setAutoLaunch, openAtLogin),

  // 连接 / 状态 / 设置
  serverConnect: (serverUrl: string, token?: string): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.serverConnect, serverUrl, token ?? null),
  serverDisconnect: (): Promise<void> => ipcRenderer.invoke(IpcChannels.serverDisconnect),
  serverGetState: (): Promise<ServerClientState> => ipcRenderer.invoke(IpcChannels.serverState),
  serverGetSettings: (): Promise<ServerSettings> => ipcRenderer.invoke(IpcChannels.serverGetSettings),
  serverSaveSettings: (s: Partial<ServerSettings>): Promise<ServerSettings> =>
    ipcRenderer.invoke(IpcChannels.serverSaveSettings, s),
  serverSetActiveCompany: (companyId: number): Promise<void> =>
    ipcRenderer.invoke(IpcChannels.serverSetActiveCompany, companyId),

  // 账号
  serverRegister: (username: string, password: string, nick?: string, email?: string, avatarPath?: string, code?: string): Promise<AuthAck> =>
    ipcRenderer.invoke(IpcChannels.serverRegister, username, password, nick ?? null, email ?? null, avatarPath ?? null, code ?? null),
  serverLogin: (username: string, password?: string, code?: string): Promise<AuthAck> =>
    ipcRenderer.invoke(IpcChannels.serverLogin, username, password ?? null, code ?? null),
  serverSendEmailCode: (email: string, purpose: 'register' | 'login'): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverSendEmailCode, email, purpose),
  serverSendResetCode: (email: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverSendResetCode, email),
  serverSendResetMail: (email: string, code: string, baseUrl: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverSendResetMail, email, code, baseUrl),
  serverLogout: (): Promise<void> => ipcRenderer.invoke(IpcChannels.serverLogout),
  serverUpdateProfile: (patch: { nick?: string; avatar?: string; phone?: string; extra?: { emergency: Array<{ name: string; phone: string }> } }): Promise<UserProfileUpdateAck> =>
    ipcRenderer.invoke(IpcChannels.userUpdateProfile, patch),
  serverChangePassword: (oldPassword: string, newPassword: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.userChangePassword, oldPassword, newPassword),
  serverGetMainMail: (): Promise<import('../shared/server-types').MainMailInfo> =>
    ipcRenderer.invoke(IpcChannels.serverGetMainMail),
  serverSetMainMail: (cfg: import('../shared/server-types').MainMailInput): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverSetMainMail, cfg),
  serverDownloadFile: (url: string): Promise<{ ok: boolean; path?: string; fileUrl?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.serverDownloadFile, url),
  serverReadFileBytes: (filePath: string): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.serverReadFileBytes, filePath),
  appSaveRecording: (name: string, base64: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke(IpcChannels.appSaveRecording, { name, base64 }),
  openFileLocation: (path: string): Promise<void> => ipcRenderer.invoke(IpcChannels.appOpenFileLocation, path),
  // 登录会话（多端）/ 账号安全
  serverSessions: (): Promise<Ack & { data?: { sessions: ServerSession[]; currentSessionId?: number; sessionDays?: number | null } }> =>
    ipcRenderer.invoke(IpcChannels.serverSessions),
  serverEndSession: (sessionId: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverEndSession, sessionId),
  serverEndAllSessions: (): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverEndAllSessions),
  serverSetSessionDays: (days: number | null): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverSetSessionDays, days),

  // 公司 / 部门
  serverListCompanies: (): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverCompanies),
  serverCreateCompany: (name: string, code?: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverCompanyCreate, name, code ?? null),
  serverJoinCompany: (code: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverCompanyJoin, code),
  serverSearchCompanies: (keyword?: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverCompanySearch, keyword ?? null),
  serverLeaveCompany: (companyId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverCompanyLeave, companyId),
  serverSetCompanyRole: (companyId: number, userId: number, role: 'owner' | 'admin' | 'member'): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverCompanySetRole, companyId, userId, role),
  serverKickCompanyMember: (companyId: number, userId: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverCompanyKick, companyId, userId),
  serverDepartments: (companyId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverDepartments, companyId),
  serverCreateDepartment: (companyId: number, name: string, parentId?: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverDepartmentCreate, companyId, name, parentId ?? null),
  serverAssignDepartment: (departmentId: number, userId: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverDepartmentAssign, departmentId, userId),
  serverRemoveDepartmentMember: (departmentId: number, userId: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverDepartmentRemoveMember, departmentId, userId),
  serverMembers: (companyId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverMembers, companyId),
  serverAddCompanyMember: (companyId: number, target: number | string, departmentId?: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverCompanyAddMember, companyId, target, departmentId ?? null),
  serverSearchUsers: (keyword: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverUserSearch, keyword),
  serverDeleteDepartment: (companyId: number, departmentId: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverDepartmentDelete, companyId, departmentId),
  serverDepartmentMembers: (departmentId: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverDepartmentMembers, departmentId),

  // 群
  serverListGroups: (): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroups),
  serverCreateGroup: (companyId: number, name: string, departmentId?: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverGroupCreate, companyId, name, departmentId ?? null),
  serverJoinGroup: (code: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupJoin, code),
  serverSearchGroups: (companyId?: number, keyword?: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverGroupSearch, companyId ?? null, keyword ?? null),
  serverLeaveGroup: (groupId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupLeave, groupId),
  serverKickGroupMember: (groupId: number, userId: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverGroupKick, groupId, userId),
  serverGroupMembers: (groupId: number): Promise<Ack & { data?: { members: ServerGroupMember[] } }> =>
    ipcRenderer.invoke(IpcChannels.serverGroupMembers, groupId),
  serverGroupSetAdmin: (groupId: number, userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupSetAdmin, groupId, userId),
  serverGroupUnsetAdmin: (groupId: number, userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupUnsetAdmin, groupId, userId),
  serverGroupMute: (groupId: number, userId: number, seconds: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupMute, groupId, userId, seconds),
  serverGroupAdd: (groupId: number, userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupAdd, groupId, userId),
  serverGroupInvite: (groupId: number, userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupInvite, groupId, userId),
  serverGroupAcceptInvite: (groupId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupAcceptInvite, groupId),
  serverGroupDeclineInvite: (groupId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupDeclineInvite, groupId),
  serverGroupTransfer: (groupId: number, userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupTransfer, groupId, userId),
  serverGroupDissolve: (groupId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverGroupDissolve, groupId),
  serverCompanyTransfer: (companyId: number, userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverCompanyTransfer, companyId, userId),
  serverCompanyDissolve: (companyId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverCompanyDissolve, companyId),

  // 会话 / 聊天
  serverConversations: (type?: 'group' | 'dm'): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverConversations, type ?? null),
  serverConversationPin: (conversationId: number, pinned: boolean): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverConversationPin, conversationId, pinned),
  serverConversationRead: (conversationId: number, lastMessageId?: number | null): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverConversationRead, conversationId, lastMessageId && lastMessageId > 0 ? lastMessageId : null),
  serverChatHistory: (groupId: number, beforeTs?: number, limit?: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverChatHistory, groupId, beforeTs ?? null, limit ?? null),
  serverChatSend: (groupId: number, content: string, kind?: 'text' | 'image' | 'file' | 'video' | 'audio' | 'folder'): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverChatSend, groupId, content, kind ?? null),
  serverDmHistory: (withUserId: number, beforeTs?: number, limit?: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverDmHistory, withUserId, beforeTs ?? null, limit ?? null),
  serverDmSend: (toUserId: number, content: string, kind?: 'text' | 'image' | 'file' | 'video' | 'audio' | 'folder'): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverDmSend, toUserId, content, kind ?? null),
  serverMessageDelete: (conversationId: number, messageId: string, content?: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverMessageDelete, conversationId, messageId, content ?? ''),
  serverMessageHardDelete: (conversationId: number, messageId: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverMessageHardDelete, conversationId, messageId),

  // 好友
  serverListFriends: (): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverFriends),
  serverAddFriend: (userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverFriendAdd, userId),
  serverRemoveFriend: (userId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverFriendRemove, userId),
  serverHolidays: (year?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverHolidays, year),
  serverHolidayAdd: (date: string, name: string, type: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverHolidayAdd, date, name, type),
  serverHolidayRemove: (date: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverHolidayRemove, date),
  serverHolidayAddMany: (items: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverHolidayAddMany, items),
  serverHolidayRemoveMany: (dates: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverHolidayRemoveMany, dates),
  serverHolidayReset: (): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverHolidayReset),
  // 任务流程系统
  serverTaskListProjects: (companyId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskProjects, companyId),
  serverTaskCreateProject: (companyId: number, name: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskProjectCreate, companyId, name),
  serverTaskDeleteProject: (companyId: number, projectId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskProjectDelete, companyId, projectId),
  serverTaskSetProjectRole: (companyId: number, projectId: number, userId: number, role: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskProjectSetRole, companyId, projectId, userId, role),
  serverTaskProjectMembers: (projectId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskProjectMembers, projectId),
  serverTaskList: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskList, companyId, projectId),
  serverTaskDetail: (taskId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskDetail, taskId),
  serverTaskCreate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskCreate, payload),
  serverTaskUpdate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskUpdate, payload),
  serverTaskDelete: (taskId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskDelete, taskId),
  serverTaskSetStatus: (taskId: number, status: string, note: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskSetStatus, taskId, status, note),
  serverTaskSetReminder: (taskId: number, y: number, r: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskSetReminder, taskId, y, r),
  serverTaskAddAssignment: (taskId: number, userId: number, content: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskAddAssignment, taskId, userId, content),
  serverTaskRemoveAssignment: (id: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskRemoveAssignment, id),
  serverTaskSetAssignmentStatus: (id: number, status: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskSetAssignmentStatus, id, status),
  serverTaskComment: (taskId: number, content: string, attachments?: Array<{ kind: string; url: string; name: string }>): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskComment, taskId, content, attachments ?? []),
  serverTaskAddIssue: (taskId: number, title: string, content: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskAddIssue, taskId, title, content),
  serverTaskResolveIssue: (issueId: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskResolveIssue, issueId),
  serverTaskRequestExtension: (taskId: number, dt: string, reason: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskRequestExtension, taskId, dt, reason),
  serverTaskDecideExtension: (companyId: number, taskId: number, extensionId: number, approved: boolean): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverTaskDecideExtension, companyId, taskId, extensionId, approved),

  // TAPD 项目管理
  serverReqList: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverReqList, companyId, projectId),
  serverReqCreate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverReqCreate, payload),
  serverReqUpdate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverReqUpdate, payload),
  serverReqStatus: (id: number, status: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverReqStatus, id, status),
  serverReqDelete: (id: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverReqDelete, id),
  serverReqLinkTasks: (id: number, taskIds: number[]): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverReqLinkTasks, id, taskIds),
  serverBugList: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverBugList, companyId, projectId),
  serverBugCreate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverBugCreate, payload),
  serverBugUpdate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverBugUpdate, payload),
  serverBugStatus: (id: number, status: string): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverBugStatus, id, status),
  serverBugDelete: (id: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverBugDelete, id),
  serverPlanList: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverPlanList, companyId, projectId),
  serverPlanCreate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverPlanCreate, payload),
  serverPlanUpdate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverPlanUpdate, payload),
  serverPlanDelete: (id: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverPlanDelete, id),
  serverDocList: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverDocList, companyId, projectId),
  serverDocCreate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverDocCreate, payload),
  serverDocUpdate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverDocUpdate, payload),
  serverDocDelete: (id: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverDocDelete, id),
  serverWikiList: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverWikiList, companyId, projectId),
  serverWikiCreate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverWikiCreate, payload),
  serverWikiUpdate: (payload: unknown): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverWikiUpdate, payload),
  serverWikiDelete: (id: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverWikiDelete, id),
  serverPmDashboard: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverPmDashboard, companyId, projectId),
  serverPmMemberTracking: (companyId: number, projectId?: number): Promise<Ack> => ipcRenderer.invoke(IpcChannels.serverPmMemberTracking, companyId, projectId),

  // 文件上传
  serverUploadFile: (filePath: string, companyId?: number): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.serverUpload, filePath, companyId ?? 0),
  serverUploadChunked: (filePath: string, clientId: string, companyId?: number, relativePath?: string): Promise<{ ok: boolean; error?: string; url?: string; uuid?: string; fileName?: string; size?: number }> =>
    ipcRenderer.invoke(IpcChannels.serverUploadChunked, filePath, clientId, companyId ?? 0, relativePath ?? ''),
  pickFile: (filter?: 'image' | 'video' | 'audio'): Promise<string | null> => ipcRenderer.invoke(IpcChannels.filePick, filter ?? null),
  pickFiles: (filter?: 'image' | 'video' | 'audio'): Promise<string[]> => ipcRenderer.invoke(IpcChannels.filePickMulti, filter ?? null),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.filePickFolder),
  serverListFolderFiles: (folderPath: string): Promise<string[]> =>
    ipcRenderer.invoke(IpcChannels.serverListFolderFiles, folderPath),
  serverDownloadFolder: (relPath: string): Promise<Ack & { data?: { destDir?: string; count?: number } }> =>
    ipcRenderer.invoke(IpcChannels.serverDownloadFolder, relPath),
  captureScreen: (): Promise<{ dataUrl: string; width: number; height: number } | null> =>
    ipcRenderer.invoke(IpcChannels.fileCaptureScreen),
  writeTempImage: (dataUrl: string): Promise<string | null> => ipcRenderer.invoke(IpcChannels.fileWriteTempImage, dataUrl),

  // RTC 信令
  rtcCreateMeeting: (opts: { title?: string; startAt?: string; password?: string; kind: RtcKind }): Promise<Ack & { data?: { meeting: RtcRoom; scheduled: boolean; peers?: RtcPeer[]; iceServers?: RtcIceServer[] } }> =>
    ipcRenderer.invoke(IpcChannels.rtcCreateMeeting, opts),
  rtcGetMeeting: (meetingNo: string): Promise<Ack & { data?: { meeting: RtcRoom } }> =>
    ipcRenderer.invoke(IpcChannels.rtcGetMeeting, meetingNo),
  rtcJoin: (roomId: string, password?: string, kind?: RtcKind): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[]; started: boolean } }> =>
    ipcRenderer.invoke(IpcChannels.rtcJoin, roomId, password ?? null, kind ?? null),
  rtcSignal: (roomId: string, signal: RtcSignalPayload): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.rtcSignal, roomId, signal),
  rtcLeave: (roomId: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.rtcLeave, roomId),
  rtcEnd: (roomId: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.rtcEnd, roomId),
  rtcDmCall: (userId: number, kind: RtcKind): Promise<Ack & { data?: { room: RtcRoom; kind: RtcKind } }> =>
    ipcRenderer.invoke(IpcChannels.rtcDmCall, userId, kind),
  rtcDmAnswer: (roomId: string, accept: boolean): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } }> =>
    ipcRenderer.invoke(IpcChannels.rtcDmAnswer, roomId, accept),
  rtcGroupCall: (groupId: number, kind: RtcKind): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } }> =>
    ipcRenderer.invoke(IpcChannels.rtcGroupCall, groupId, kind),
  rtcChatMessage: (roomId: string, content: string): Promise<Ack> =>
    ipcRenderer.invoke(IpcChannels.rtcChatSend, roomId, content),

  // 推送订阅
  onServerState: (l: (s: ServerClientState) => void) => subscribe<ServerClientState>(IpcEvents.serverState, l),
  onServerMessage: (l: (m: ServerChatMessage) => void) => subscribe<ServerChatMessage>(IpcEvents.serverMessage, l),
  onNavigateToConversation: (l: (conversationId: number) => void) => subscribe<number>(IpcEvents.navigateToConversation, l),
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

  // RTC 信令推送订阅
  onRtcDmIncoming: (l: (d: RtcDmIncomingEvent) => void) => subscribe<RtcDmIncomingEvent>(IpcEvents.rtcDmIncoming, l),
  onRtcDmRejected: (l: (d: RtcDmRejectedEvent) => void) => subscribe<RtcDmRejectedEvent>(IpcEvents.rtcDmRejected, l),
  onRtcPeerJoined: (l: (d: RtcPeerJoinedEvent) => void) => subscribe<RtcPeerJoinedEvent>(IpcEvents.rtcPeerJoined, l),
  onRtcPeerLeft: (l: (d: RtcPeerLeftEvent) => void) => subscribe<RtcPeerLeftEvent>(IpcEvents.rtcPeerLeft, l),
  onRtcSignal: (l: (d: RtcSignalEvent) => void) => subscribe<RtcSignalEvent>(IpcEvents.rtcSignal, l),
  onRtcEnded: (l: (d: RtcEndedEvent) => void) => subscribe<RtcEndedEvent>(IpcEvents.rtcEnded, l),
  onRtcGroupCall: (l: (d: RtcGroupCallEvent) => void) => subscribe<RtcGroupCallEvent>(IpcEvents.rtcGroupCall, l),
  onRtcChatMessage: (l: (d: RtcChatMessageEvent) => void) => subscribe<RtcChatMessageEvent>(IpcEvents.rtcChatMessage, l),
  onGroupMembersUpdated: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupMembersUpdated, l),
  onGroupInvite: (l: (d: GroupInviteEvent) => void) => subscribe<GroupInviteEvent>(IpcEvents.groupInvite, l),
  onGroupDissolved: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupDissolved, l),
  onCompanyDissolved: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyDissolved, l),
  onCompanyUpdated: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyUpdated, l),
  onCompanyRemoved: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyRemoved, l),
  onCompanyAdded: (l: (d: { companyId: number }) => void) => subscribe<{ companyId: number }>(IpcEvents.companyAdded, l),
  onGroupAdded: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupAdded, l),
  onGroupRemoved: (l: (d: { groupId: number }) => void) => subscribe<{ groupId: number }>(IpcEvents.groupRemoved, l),
  onFriendsUpdated: (l: () => void) => subscribe<unknown>(IpcEvents.friendsUpdated, () => l()),
  onHolidaysUpdated: (l: () => void) => subscribe<unknown>(IpcEvents.holidaysUpdated, () => l()),
  onTasksUpdated: (l: (d: { companyId?: number }) => void) => subscribe<{ companyId?: number }>(IpcEvents.tasksUpdated, l),
  onProjectsUpdated: (l: (d: { companyId?: number }) => void) => subscribe<{ companyId?: number }>(IpcEvents.projectsUpdated, l),
  onRequirementsUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.requirementsUpdated, l),
  onBugsUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.bugsUpdated, l),
  onPlansUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.plansUpdated, l),
  onDocsUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.docsUpdated, l),
  onWikiUpdated: (l: (d: { companyId?: number; projectId?: number | null }) => void) => subscribe<{ companyId?: number; projectId?: number | null }>(IpcEvents.wikiUpdated, l),
  runAlarmCommand: (command: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IpcChannels.alarmRun, command),
  readAudioFile: (path: string): Promise<{ ok: boolean; data?: ArrayBuffer; error?: string }> => ipcRenderer.invoke(IpcChannels.audioReadFile, path),
  onUploadProgress: (l: (d: { clientId: string; percent: number }) => void) => subscribe<{ clientId: string; percent: number }>(IpcEvents.uploadProgress, l),
  onScreenshotSaved: (l: (path: string) => void) => subscribe<string>(IpcEvents.screenshotSaved, l)
}

export type PantryApi = typeof api

contextBridge.exposeInMainWorld('pantry', api)
