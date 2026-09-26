/**
 * Mochi OA - 中心服务器 IPC 通道注册。
 * renderer 经 preload 发起的 server* 请求全部在此落到 serverClient 单例，
 * 并把 serverClient 的推送事件桥接到 renderer。
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, writeFile } from 'node:fs/promises'
import { IpcChannels, IpcEvents } from '../shared/ipc'
import { serverClient } from './net/server-client'
import { notify as notifyManager, openMeetingWindow } from './notif'
import { loadServerConfig, saveServerConfig } from './server-config'

function sendToMainWindow(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerServerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  // 推送 → renderer
  serverClient.on('state', (s) => sendToMainWindow(getMainWindow(), IpcEvents.serverState, s))
  serverClient.on('message', (m) => sendToMainWindow(getMainWindow(), IpcEvents.serverMessage, m))
  serverClient.on('presence', (p) => sendToMainWindow(getMainWindow(), IpcEvents.serverPresence, p))
  serverClient.on('userProfileUpdated', (d) => sendToMainWindow(getMainWindow(), IpcEvents.userProfileUpdated, d))
  serverClient.on('messageDeleted', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverMessageDeleted, d))
  serverClient.on('conversationsUpdated', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverConversationsUpdated, d))
  serverClient.on('sessionNewDevice', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverSessionNewDevice, d))
  serverClient.on('sessionRevoked', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverSessionRevoked, d))

  // RTC 信令推送 → renderer（广播到所有窗口，会议独立窗口也需接收）
  serverClient.on('rtcDmIncoming', (d) => {
    broadcastToAllWindows(IpcEvents.rtcDmIncoming, d)
    // 来电：未聚焦/最小化时唤起主窗口弹呼叫界面（托盘闪动/系统通知由渲染层通知管理器触发）
    const win = getMainWindow()
    if (win && (!win.isFocused() || win.isMinimized())) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  serverClient.on('rtcDmRejected', (d) => broadcastToAllWindows(IpcEvents.rtcDmRejected, d))
  serverClient.on('rtcPeerJoined', (d) => broadcastToAllWindows(IpcEvents.rtcPeerJoined, d))
  serverClient.on('rtcPeerLeft', (d) => broadcastToAllWindows(IpcEvents.rtcPeerLeft, d))
  serverClient.on('rtcSignal', (d) => broadcastToAllWindows(IpcEvents.rtcSignal, d))
  serverClient.on('rtcEnded', (d) => broadcastToAllWindows(IpcEvents.rtcEnded, d))
  serverClient.on('rtcGroupCall', (d) => {
    broadcastToAllWindows(IpcEvents.rtcGroupCall, d)
    // 会议/群通话邀请：未聚焦/最小化时唤起主窗口弹会议界面（托盘闪动/系统通知由渲染层通知管理器触发）
    const win = getMainWindow()
    if (win && (!win.isFocused() || win.isMinimized())) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  serverClient.on('rtcChatMessage', (d) => broadcastToAllWindows(IpcEvents.rtcChatMessage, d))
  serverClient.on('groupMembersUpdated', (d) => broadcastToAllWindows(IpcEvents.groupMembersUpdated, d))
  serverClient.on('groupInvite', (d) => broadcastToAllWindows(IpcEvents.groupInvite, d))
  serverClient.on('groupDissolved', (d) => broadcastToAllWindows(IpcEvents.groupDissolved, d))
  serverClient.on('companyDissolved', (d) => broadcastToAllWindows(IpcEvents.companyDissolved, d))
  serverClient.on('companyUpdated', (d) => broadcastToAllWindows(IpcEvents.companyUpdated, d))
  serverClient.on('companyRemoved', (d) => broadcastToAllWindows(IpcEvents.companyRemoved, d))
  serverClient.on('companyAdded', (d) => broadcastToAllWindows(IpcEvents.companyAdded, d))
  serverClient.on('groupAdded', (d) => broadcastToAllWindows(IpcEvents.groupAdded, d))
  serverClient.on('groupRemoved', (d) => broadcastToAllWindows(IpcEvents.groupRemoved, d))
  serverClient.on('friendsUpdated', () => broadcastToAllWindows(IpcEvents.friendsUpdated, {}))
  serverClient.on('holidaysUpdated', () => broadcastToAllWindows(IpcEvents.holidaysUpdated, {}))
  serverClient.on('tasksUpdated', (d: unknown) => broadcastToAllWindows(IpcEvents.tasksUpdated, d ?? {}))
  serverClient.on('projectsUpdated', (d: unknown) => broadcastToAllWindows(IpcEvents.projectsUpdated, d ?? {}))

  // 连接 / 状态 / 设置
  ipcMain.handle(IpcChannels.serverConnect, (_e, serverUrl: unknown, token: unknown) => {
    const url = typeof serverUrl === 'string' ? serverUrl : ''
    const t = typeof token === 'string' ? token : ''
    serverClient.connect({ serverUrl: url, token: t })
    saveServerConfig({ serverUrl: url, token: t })
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.serverDisconnect, () => {
    serverClient.disconnect()
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.serverState, () => serverClient.state)
  ipcMain.handle(IpcChannels.serverGetSettings, () => loadServerConfig())
  ipcMain.handle(IpcChannels.serverSaveSettings, (_e, settings: unknown) =>
    saveServerConfig((settings ?? {}) as Partial<import('../shared/server-types').ServerSettings>)
  )
  ipcMain.handle(IpcChannels.serverSetActiveCompany, (_e, companyId: unknown) => {
    serverClient.setActiveCompany(Number(companyId) || 0)
    return Promise.resolve()
  })

  // 账号
  ipcMain.handle(IpcChannels.serverRegister, (_e, username, password, nick, email, avatarPath, code) =>
    serverClient.register(
      String(username),
      String(password),
      typeof nick === 'string' ? nick : undefined,
      typeof email === 'string' ? email : undefined,
      typeof avatarPath === 'string' && avatarPath ? avatarPath : undefined,
      typeof code === 'string' && code ? code : undefined
    )
  )
  ipcMain.handle(IpcChannels.serverLogin, (_e, username, password, code) =>
    serverClient.login(String(username), String(password ?? ''), typeof code === 'string' && code ? code : undefined)
  )
  ipcMain.handle(IpcChannels.serverSendEmailCode, (_e, email, purpose) =>
    serverClient.sendEmailCode(String(email), purpose === 'login' ? 'login' : 'register')
  )
  ipcMain.handle(IpcChannels.serverSendResetCode, (_e, email) => serverClient.sendResetCode(String(email)))
  ipcMain.handle(IpcChannels.serverSendResetMail, (_e, email, code, baseUrl) =>
    serverClient.sendResetMail(String(email), String(code), String(baseUrl ?? ''))
  )
  ipcMain.handle(IpcChannels.serverLogout, async () => {
    await serverClient.logout()
    saveServerConfig({ token: '' })
  })

  // 登录会话（多端）/ 账号安全
  ipcMain.handle(IpcChannels.serverSessions, () => serverClient.listSessions())
  ipcMain.handle(IpcChannels.serverEndSession, (_e, sessionId) =>
    serverClient.endSession(Number(sessionId) || 0)
  )
  ipcMain.handle(IpcChannels.serverEndAllSessions, () => serverClient.endAllSessions())
  ipcMain.handle(IpcChannels.serverSetSessionDays, (_e, days) => serverClient.setSessionDays(days))

  // 公司 / 部门
  ipcMain.handle(IpcChannels.serverCompanies, () => serverClient.listCompanies())
  ipcMain.handle(IpcChannels.serverCompanyCreate, (_e, name, code) =>
    serverClient.createCompany(String(name), typeof code === 'string' ? code : undefined)
  )
  ipcMain.handle(IpcChannels.serverCompanyJoin, (_e, code) => serverClient.joinCompany(String(code)))
  ipcMain.handle(IpcChannels.serverCompanySearch, (_e, keyword) =>
    serverClient.searchCompanies(typeof keyword === 'string' && keyword ? keyword : undefined)
  )
  ipcMain.handle(IpcChannels.serverCompanyLeave, (_e, companyId) =>
    serverClient.leaveCompany(Number(companyId) || 0)
  )
  ipcMain.handle(IpcChannels.serverCompanySetRole, (_e, companyId, userId, role) =>
    serverClient.setCompanyRole(Number(companyId) || 0, Number(userId) || 0, role === 'owner' || role === 'admin' || role === 'member' ? role : 'member')
  )
  ipcMain.handle(IpcChannels.serverCompanyKick, (_e, companyId, userId) =>
    serverClient.kickCompanyMember(Number(companyId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverCompanyAddMember, (_e, companyId, target, departmentId) =>
    serverClient.addCompanyMember(Number(companyId) || 0, typeof target === 'number' ? target : String(target), typeof departmentId === 'number' ? departmentId : undefined)
  )
  ipcMain.handle(IpcChannels.serverCompanyTransfer, (_e, companyId, userId) =>
    serverClient.companyTransfer(Number(companyId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverCompanyDissolve, (_e, companyId) =>
    serverClient.companyDissolve(Number(companyId) || 0)
  )
  ipcMain.handle(IpcChannels.serverUserSearch, (_e, keyword) =>
    serverClient.searchUsers(typeof keyword === 'string' ? keyword : '')
  )
  ipcMain.handle(IpcChannels.serverDepartmentDelete, (_e, companyId, departmentId) =>
    serverClient.deleteDepartment(Number(companyId) || 0, Number(departmentId) || 0)
  )
  ipcMain.handle(IpcChannels.serverDepartments, (_e, companyId) =>
    serverClient.listDepartments(Number(companyId) || 0)
  )
  ipcMain.handle(IpcChannels.serverDepartmentCreate, (_e, companyId, name, parentId) =>
    serverClient.createDepartment(Number(companyId) || 0, String(name), typeof parentId === 'number' ? parentId : undefined)
  )
  ipcMain.handle(IpcChannels.serverDepartmentAssign, (_e, departmentId, userId) =>
    serverClient.assignDepartment(Number(departmentId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverDepartmentRemoveMember, (_e, departmentId, userId) =>
    serverClient.removeDepartmentMember(Number(departmentId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverMembers, (_e, companyId) =>
    serverClient.companyMembers(Number(companyId) || 0)
  )
  ipcMain.handle(IpcChannels.serverDepartmentMembers, (_e, departmentId) =>
    serverClient.departmentMembers(Number(departmentId) || 0)
  )

  // 群
  ipcMain.handle(IpcChannels.serverGroups, () => serverClient.listGroups())
  ipcMain.handle(IpcChannels.serverGroupCreate, (_e, companyId, name, departmentId) =>
    serverClient.createGroup(Number(companyId) || 0, String(name), typeof departmentId === 'number' ? departmentId : undefined)
  )
  ipcMain.handle(IpcChannels.serverGroupJoin, (_e, code) => serverClient.joinGroup(String(code)))
  ipcMain.handle(IpcChannels.serverGroupSearch, (_e, companyId, keyword) =>
    serverClient.searchGroups(typeof companyId === 'number' ? Number(companyId) : undefined, typeof keyword === 'string' && keyword ? keyword : undefined)
  )
  ipcMain.handle(IpcChannels.serverGroupLeave, (_e, groupId) =>
    serverClient.leaveGroup(Number(groupId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupKick, (_e, groupId, userId) =>
    serverClient.kickGroupMember(Number(groupId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupMembers, (_e, groupId) =>
    serverClient.groupMembers(Number(groupId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupSetAdmin, (_e, groupId, userId) =>
    serverClient.groupSetAdmin(Number(groupId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupUnsetAdmin, (_e, groupId, userId) =>
    serverClient.groupUnsetAdmin(Number(groupId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupMute, (_e, groupId, userId, seconds) =>
    serverClient.groupMute(Number(groupId) || 0, Number(userId) || 0, Number(seconds) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupAdd, (_e, groupId, userId) =>
    serverClient.groupAdd(Number(groupId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupInvite, (_e, groupId, userId) =>
    serverClient.groupInvite(Number(groupId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupAcceptInvite, (_e, groupId) =>
    serverClient.groupAcceptInvite(Number(groupId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupDeclineInvite, (_e, groupId) =>
    serverClient.groupDeclineInvite(Number(groupId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupTransfer, (_e, groupId, userId) =>
    serverClient.groupTransfer(Number(groupId) || 0, Number(userId) || 0)
  )
  ipcMain.handle(IpcChannels.serverGroupDissolve, (_e, groupId) =>
    serverClient.groupDissolve(Number(groupId) || 0)
  )

  // 会话 / 聊天
  ipcMain.handle(IpcChannels.serverConversations, (_e, type) =>
    serverClient.listConversations(type === 'group' || type === 'dm' ? type : undefined)
  )
  ipcMain.handle(IpcChannels.serverConversationPin, (_e, conversationId, pinned) =>
    serverClient.pinConversation(Number(conversationId) || 0, pinned === true)
  )
  ipcMain.handle(IpcChannels.serverConversationRead, (_e, conversationId) =>
    serverClient.markConversationRead(Number(conversationId) || 0)
  )
  ipcMain.handle(IpcChannels.serverChatHistory, (_e, groupId, beforeTs, limit) =>
    serverClient.groupHistory(Number(groupId) || 0, typeof beforeTs === 'number' ? beforeTs : undefined, typeof limit === 'number' ? limit : undefined)
  )
  ipcMain.handle(IpcChannels.serverChatSend, (_e, groupId, content, kind) =>
    serverClient.sendGroupMessage(Number(groupId) || 0, String(content), kind === 'image' || kind === 'file' || kind === 'video' || kind === 'folder' ? kind : 'text')
  )
  ipcMain.handle(IpcChannels.serverDmHistory, (_e, withUserId, beforeTs, limit) =>
    serverClient.dmHistory(Number(withUserId) || 0, typeof beforeTs === 'number' ? beforeTs : undefined, typeof limit === 'number' ? limit : undefined)
  )
  ipcMain.handle(IpcChannels.serverDmSend, (_e, toUserId, content, kind) =>
    serverClient.sendDmMessage(Number(toUserId) || 0, String(content), kind === 'image' || kind === 'file' || kind === 'video' || kind === 'folder' ? kind : 'text')
  )
  ipcMain.handle(IpcChannels.serverMessageDelete, (_e, conversationId, messageId) =>
    serverClient.deleteMessage(Number(conversationId) || 0, String(messageId))
  )
  ipcMain.handle(IpcChannels.serverMessageHardDelete, (_e, conversationId, messageId) =>
    serverClient.hardDeleteMessage(Number(conversationId) || 0, String(messageId))
  )

  // 好友
  ipcMain.handle(IpcChannels.serverFriends, () => serverClient.listFriends())
  ipcMain.handle(IpcChannels.serverHolidays, (_e, year) => serverClient.listHolidays(year ? Number(year) : undefined))
  ipcMain.handle(IpcChannels.serverHolidayAdd, (_e, date, name, type) => serverClient.addHoliday(String(date), String(name), type as 'legal' | 'workday' | 'custom'))
  ipcMain.handle(IpcChannels.serverHolidayRemove, (_e, date) => serverClient.removeHoliday(String(date)))
  ipcMain.handle(IpcChannels.serverHolidayAddMany, (_e, items) => serverClient.addHolidays(items as Array<{ date: string; name: string; type: 'legal' | 'workday' | 'custom' }>))
  ipcMain.handle(IpcChannels.serverHolidayRemoveMany, (_e, dates) => serverClient.removeHolidays((dates as string[]) ?? []))
  ipcMain.handle(IpcChannels.serverHolidayReset, () => serverClient.resetHolidays())
  ipcMain.handle(IpcChannels.serverFriendAdd, (_e, userId) => serverClient.addFriend(Number(userId) || 0))
  ipcMain.handle(IpcChannels.serverFriendRemove, (_e, userId) => serverClient.removeFriend(Number(userId) || 0))

  // 任务流程系统
  ipcMain.handle(IpcChannels.serverTaskProjects, (_e, companyId) => serverClient.taskListProjects(Number(companyId) || 0))
  ipcMain.handle(IpcChannels.serverTaskProjectCreate, (_e, companyId, name) => serverClient.taskCreateProject(Number(companyId) || 0, String(name)))
  ipcMain.handle(IpcChannels.serverTaskProjectDelete, (_e, companyId, projectId) => serverClient.taskDeleteProject(Number(companyId) || 0, Number(projectId) || 0))
  ipcMain.handle(IpcChannels.serverTaskProjectSetRole, (_e, companyId, projectId, userId, role) => serverClient.taskSetProjectRole(Number(companyId) || 0, Number(projectId) || 0, Number(userId) || 0, String(role)))
  ipcMain.handle(IpcChannels.serverTaskProjectMembers, (_e, projectId) => serverClient.taskProjectMembers(Number(projectId) || 0))
  ipcMain.handle(IpcChannels.serverTaskList, (_e, companyId, projectId) => serverClient.taskList(Number(companyId) || 0, projectId ? Number(projectId) : undefined))
  ipcMain.handle(IpcChannels.serverTaskDetail, (_e, taskId) => serverClient.taskDetail(Number(taskId) || 0))
  ipcMain.handle(IpcChannels.serverTaskCreate, (_e, payload) => serverClient.taskCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverTaskUpdate, (_e, payload) => serverClient.taskUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverTaskDelete, (_e, taskId) => serverClient.taskDelete(Number(taskId) || 0))
  ipcMain.handle(IpcChannels.serverTaskSetStatus, (_e, taskId, status, note) => serverClient.taskSetStatus(Number(taskId) || 0, String(status), String(note ?? '')))
  ipcMain.handle(IpcChannels.serverTaskSetReminder, (_e, taskId, y, r) => serverClient.taskSetReminder(Number(taskId) || 0, Number(y) || 0, Number(r) || 0))
  ipcMain.handle(IpcChannels.serverTaskAddAssignment, (_e, taskId, userId, content) => serverClient.taskAddAssignment(Number(taskId) || 0, Number(userId) || 0, String(content ?? '')))
  ipcMain.handle(IpcChannels.serverTaskRemoveAssignment, (_e, id) => serverClient.taskRemoveAssignment(Number(id) || 0))
  ipcMain.handle(IpcChannels.serverTaskSetAssignmentStatus, (_e, id, status) => serverClient.taskSetAssignmentStatus(Number(id) || 0, String(status)))
  ipcMain.handle(IpcChannels.serverTaskComment, (_e, taskId, content) => serverClient.taskComment(Number(taskId) || 0, String(content ?? '')))
  ipcMain.handle(IpcChannels.serverTaskAddIssue, (_e, taskId, title, content) => serverClient.taskAddIssue(Number(taskId) || 0, String(title ?? ''), String(content ?? '')))
  ipcMain.handle(IpcChannels.serverTaskResolveIssue, (_e, issueId) => serverClient.taskResolveIssue(Number(issueId) || 0))
  ipcMain.handle(IpcChannels.serverTaskRequestExtension, (_e, taskId, dt, reason) => serverClient.taskRequestExtension(Number(taskId) || 0, String(dt), String(reason ?? '')))
  ipcMain.handle(IpcChannels.serverTaskDecideExtension, (_e, companyId, taskId, extensionId, approved) => serverClient.taskDecideExtension(Number(companyId) || 0, Number(taskId) || 0, Number(extensionId) || 0, Boolean(approved)))

  // 文件上传
  ipcMain.handle(IpcChannels.serverUpload, (_e, filePath, companyId) =>
    serverClient.uploadFile(String(filePath), Number(companyId) || 0)
  )
  // 分块上传（带进度）：每块完成后向对应窗口推送 uploadProgress 事件
  ipcMain.handle(IpcChannels.serverUploadChunked, (e, filePath, clientId, companyId, relativePath) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return serverClient.uploadFileChunked(String(filePath), (percent) => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IpcEvents.uploadProgress, { clientId, percent })
      }
    }, Number(companyId) || 0, String(relativePath ?? ''))
  })
  // 下载整个文件夹到配置目录（按原结构建目录）
  ipcMain.handle(IpcChannels.serverDownloadFolder, (_e, relPath) =>
    serverClient.downloadFolder(String(relPath), loadServerConfig().downloadDir)
  )

  // RTC 信令
  ipcMain.handle(IpcChannels.rtcCreateMeeting, (_e, opts) => serverClient.rtcCreateMeeting(opts as { title?: string; startAt?: string; password?: string; kind: 'video' | 'voice' }))
  ipcMain.handle(IpcChannels.rtcGetMeeting, (_e, meetingNo) => serverClient.rtcGetMeeting(String(meetingNo)))
  ipcMain.handle(IpcChannels.rtcJoin, (_e, roomId, password, kind) => serverClient.rtcJoin(String(roomId), typeof password === 'string' ? password : undefined, kind === 'voice' ? 'voice' : kind === 'video' ? 'video' : undefined))
  ipcMain.handle(IpcChannels.rtcSignal, (_e, roomId, signal) => serverClient.rtcSignal(String(roomId), signal as import('../shared/server-types').RtcSignalPayload))
  ipcMain.handle(IpcChannels.rtcLeave, (_e, roomId) => serverClient.rtcLeave(String(roomId)))
  ipcMain.handle(IpcChannels.rtcEnd, (_e, roomId) => serverClient.rtcEnd(String(roomId)))
  ipcMain.handle(IpcChannels.rtcDmCall, (_e, userId, kind) => serverClient.rtcDmCall(Number(userId) || 0, kind === 'voice' ? 'voice' : 'video'))
  ipcMain.handle(IpcChannels.rtcDmAnswer, (_e, roomId, accept) => serverClient.rtcDmAnswer(String(roomId), accept === true))
  ipcMain.handle(IpcChannels.rtcGroupCall, (_e, groupId, kind) => serverClient.rtcGroupCall(Number(groupId) || 0, kind === 'voice' ? 'voice' : 'video'))
  ipcMain.handle(IpcChannels.rtcChatSend, (_e, roomId, content) => serverClient.rtcChatMessage(String(roomId), String(content ?? '')))

  // 个人信息
  ipcMain.handle(IpcChannels.userUpdateProfile, (_e, patch) =>
    serverClient.userUpdateProfile(patch as { nick?: string; avatar?: string; phone?: string; extra?: { emergency: Array<{ name: string; phone: string }> } })
  )
  // 修改密码
  ipcMain.handle(IpcChannels.userChangePassword, (_e, oldPassword, newPassword) =>
    serverClient.userChangePassword(String(oldPassword ?? ''), String(newPassword ?? ''))
  )
  ipcMain.handle(IpcChannels.serverGetMainMail, () => serverClient.getMainMailConfig())
  ipcMain.handle(IpcChannels.serverSetMainMail, (_e, cfg: unknown) =>
    serverClient.setMainMailConfig(
      (cfg ?? {}) as Parameters<typeof serverClient.setMainMailConfig>[0]
    )
  )
  // 下载远程文件到本地缓存目录（图片/视频/3D 预览用），返回 {ok,path,fileUrl,error}
  ipcMain.handle(IpcChannels.serverDownloadFile, async (_e, url) => {
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { join, basename } = await import('node:path')
      const { pathToFileURL } = await import('node:url')
      const name = basename(String(url).split('?')[0] ?? '').trim() || 'download.bin'
      const dir = join(app.getPath('userData'), 'file-cache')
      await mkdir(dir, { recursive: true })
      const safe = name.replace(/[\\/:*?"<>|]/g, '_')
      const dest = join(dir, safe)
      const dl = await serverClient.downloadFile(String(url))
      if (!dl.ok || !dl.buf) return { ok: false, error: dl.error || '下载失败' }
      await writeFile(dest, dl.buf)
      // 整条 Windows 路径编码进 URL：避免 `C:` 盘符被 Chromium 解析成 host（app-file://c/...）导致路径丢失
      return { ok: true, path: dest, fileUrl: `app-file:///${encodeURIComponent(dest)}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // 保存通话/会议录制到 {downloadDir}/通话录制/{name}（Document=个人文档目录，默认 文档/麻薯）
  ipcMain.handle(IpcChannels.appSaveRecording, async (_e, payload) => {
    try {
      const p = (payload ?? {}) as { name?: unknown; base64?: unknown }
      const name = String(p.name ?? `通话录制_${Date.now()}.webm`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
      const base64 = String(p.base64 ?? '')
      if (!base64) return { ok: false, error: '没有可保存的录制数据' }
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const dir = join(loadServerConfig().downloadDir, '通话录制')
      await mkdir(dir, { recursive: true })
      const dest = join(dir, name.endsWith('.webm') ? name : `${name}.webm`)
      await writeFile(dest, Buffer.from(base64, 'base64'))
      return { ok: true, path: dest, error: '' }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // 读取本地文件为 ArrayBuffer（3D 模型解析用）
  ipcMain.handle(IpcChannels.serverReadFileBytes, async (_e, filePath) => {
    try {
      const { readFile } = await import('node:fs/promises')
      const buf = await readFile(String(filePath))
      return { ok: true, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // 文件选择框（filter: image/video 限定类型）
  ipcMain.handle(IpcChannels.filePick, async (e, filter) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    let filters: Electron.FileFilter[]
    if (filter === 'image') filters = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
    else if (filter === 'video') filters = [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'flv'] }]
    else if (filter === 'audio') filters = [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma'] }]
    else filters = [{ name: '所有文件', extensions: ['*'] }]
    const res = await dialog.showOpenDialog(win ?? undefined as unknown as BrowserWindow, {
      title: '选择文件',
      properties: ['openFile'],
      filters
    })
    return Promise.resolve(res.canceled ? null : res.filePaths[0] ?? null)
  })

  // 闹钟到点执行用户程序/脚本（Windows: bat/ps1/exe，Linux/macOS: sh/可执行程序；shell 统一执行，兼容三平台）
  ipcMain.handle(IpcChannels.alarmRun, async (_e, command) => {
    const cmd = typeof command === 'string' ? command.trim() : ''
    if (!cmd) return { ok: false, error: '空命令' }
    try {
      const { spawn } = await import('node:child_process')
      const child = spawn(cmd, { shell: true, detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 读取本地音频文件字节（渲染层 blob 播放；绕开 app-file 协议对音频支持不稳的问题）
  ipcMain.handle(IpcChannels.audioReadFile, async (_e, path) => {
    if (typeof path !== 'string' || !path) return { ok: false, error: '路径无效' }
    try {
      const buf = await readFile(path)
      return { ok: true, data: buf.buffer }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 文件夹选择框（用于发送文件夹：遍历其中文件批量发送）
  ipcMain.handle(IpcChannels.filePickFolder, async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const res = await dialog.showOpenDialog(win ?? undefined as unknown as BrowserWindow, {
      title: '选择文件夹',
      properties: ['openDirectory']
    })
    return Promise.resolve(res.canceled ? null : res.filePaths[0] ?? null)
  })

  // 递归枚举文件夹内所有文件（用于发送文件夹）
  ipcMain.handle(IpcChannels.serverListFolderFiles, async (_e, folderPath) => {
    const { readdir, stat } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const out: string[] = []
    const walk = async (dir: string): Promise<void> => {
      let entries: string[] = []
      try {
        entries = await readdir(dir)
      } catch {
        return
      }
      for (const name of entries) {
        const full = join(dir, name)
        try {
          const s = await stat(full)
          if (s.isDirectory()) await walk(full)
          else out.push(full)
        } catch {
          // 忽略无权限条目
        }
      }
    }
    await walk(String(folderPath ?? ''))
    return out
  })

  // 截屏：捕获主显示器全屏，存为临时 PNG 返回路径（用于聊天发送截屏）
  ipcMain.handle(IpcChannels.fileCaptureScreen, async () => {
    try {
      const source = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 }
      })
      if (!source || source.length === 0) return null
      const thumb = source.find((s) => s.name.toLowerCase().includes('screen')) ?? source[0]
      const png = thumb.thumbnail.toPNG()
      const out = join(tmpdir(), `shot-${Date.now()}.png`)
      await writeFile(out, png)
      return out
    } catch {
      return null
    }
  })

  // 窗口
  ipcMain.handle(IpcChannels.winMinimize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.minimize()
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.winToggleMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) win.isMaximized() ? win.unmaximize() : win.maximize()
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.winClose, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    win?.close()
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.winSetMainMode, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) {
      win.setResizable(true)
      win.setMaximizable(true)
      win.setMinimumSize(900, 620)
      win.setSize(1180, 760)
      win.center()
    }
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.winSetLoginMode, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) {
      win.setResizable(false)
      win.setMaximizable(false)
      win.setMinimumSize(480, 638)
      win.setSize(480, 638)
      win.center()
    }
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.appInfo, () => {
    const { app } = require('electron') as typeof import('electron')
    return Promise.resolve({ version: app.getVersion(), name: app.getName() })
  })
  ipcMain.handle(IpcChannels.appOpenFileLocation, (_e, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p)
    return Promise.resolve()
  })

  // 打开独立会议窗口
  ipcMain.handle(IpcChannels.openMeetingWindow, (_e, params) => {
    const p = (params ?? {}) as { mode: 'create' | 'join'; kind?: string; meetingNo?: string; password?: string }
    const win = new BrowserWindow({
      width: 960, height: 646, minWidth: 800, minHeight: 560,
      resizable: true, frame: false, autoHideMenuBar: true, backgroundColor: '#0d1117',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    const query: Record<string, string> = { mode: p.mode }
    if (p.kind) query.kind = p.kind
    if (p.meetingNo) query.meetingNo = p.meetingNo
    if (p.password) query.password = p.password
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/meeting.html?${new URLSearchParams(query).toString()}`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/meeting.html'), { query })
    }
  })
}
