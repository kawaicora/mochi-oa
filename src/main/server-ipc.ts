/**
 * Mochi OA - 中心服务器 IPC 通道注册。
 * renderer 经 preload 发起的 server* 请求全部在此落到 serverClient 单例，
 * 并把 serverClient 的推送事件桥接到 renderer。
 */
import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, screen, shell } from 'electron'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { readFile, writeFile, mkdir, stat, readdir, appendFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import * as iconv from 'iconv-lite'
import { IpcChannels, IpcEvents, ScreenshotToolbar, type NotifKind } from '../shared/ipc'
import { serverClient } from './net/server-client'
import { notify as notifyManager, openMeetingWindow, resolveSoundFile } from './notif'
import { loadServerConfig, saveServerConfig } from './server-config'
import { startSysReport, stopSysReport } from './sys-report'
import { decodeUrlName } from './url-name'

/** 上一次已知的登录用户 id（用 有值→无值 的跳变判定「刚退回登录页」） */
let lastUserId: number | undefined

/** 主进程落盘日志（userData/logs/renderer-console.log，与渲染层同文件统一排查） */
function sendToMainWindow(win: BrowserWindow | null, channel: string, payload: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  win.webContents.send(channel, payload)
}

/**
 * 在被控端（本机）执行远程命令。Windows：按 shell 选 cmd.exe / powershell.exe；
 * Linux/macOS：直接默认 /bin/sh。结果经 serverClient.devExecResult 回传服务端转发给控制端。
 */
function execRemote(deviceId: string, shell: string, cmd: string, timeout = 15000): void {
  const win = process.platform === 'win32'
  const isCmd = win && shell === 'cmd'
  const exe = win ? (isCmd ? 'cmd.exe' : 'powershell.exe') : '/bin/sh'
  const args = win
    ? (isCmd ? ['/d', '/s', '/c', cmd] : ['-NoProfile', '-NonInteractive', '-Command', cmd])
    : ['-c', cmd]
  console.log(`[dev-exec] deviceId=${deviceId} shell=${shell} cmd=${cmd}（平台=${process.platform} exe=${exe}）`)
  const child = spawn(exe, args, { windowsHide: true })
  const dec = win ? (b: Buffer) => iconv.decode(b, 'gbk') : (b: Buffer) => b.toString('utf8')
  let stdout = ''
  let stderr = ''
  const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 超时终止 */ } }, timeout)
  child.stdout?.on('data', (b: Buffer) => { stdout += dec(b) })
  child.stderr?.on('data', (b: Buffer) => { stderr += dec(b) })
  child.on('error', (e) => {
    clearTimeout(timer)
    void serverClient.devExecResult(deviceId, { ok: false, exitCode: -1, stdout, stderr: (stderr || '') + (e.message || '') })
  })
  child.on('close', (code) => {
    clearTimeout(timer)
    console.log(`[dev-exec] deviceId=${deviceId} exit=${code ?? 0} stdout=${stdout.length}B stderr=${stderr.length}B`)
    void serverClient.devExecResult(deviceId, { ok: true, exitCode: code ?? 0, stdout, stderr })
  })
}

/** 持久交互终端会话：deviceId → 常驻 shell 子进程（保持 cwd/环境/变量，stdin 写入 / stdout,stderr 实时回传） */
const termSessions = new Map<string, ReturnType<typeof spawn>>()
function termDecode(win: boolean): (b: Buffer) => string {
  return win ? (b) => iconv.decode(b, 'gbk') : (b) => b.toString('utf8')
}
function termOpen(deviceId: string, shell: string): void {
  if (termSessions.has(deviceId)) return
  const win = process.platform === 'win32'
  const isCmd = win && shell === 'cmd'
  const exe = win ? (isCmd ? 'cmd.exe' : 'powershell.exe') : '/bin/sh'
  const args = win ? (isCmd ? ['/Q'] : ['-NoLogo', '-NoProfile', '-NonInteractive']) : ['-i']
  const dec = termDecode(win)
  console.log(`[dev-term] 打开会话 deviceId=${deviceId} shell=${shell} exe=${exe}`)
  const child = spawn(exe, args, { windowsHide: true })
  termSessions.set(deviceId, child)
  const push = (stream: NodeJS.ReadableStream | null, isErr: boolean): void => {
    stream?.on('data', (b: Buffer) => {
      try { void serverClient.devTermOut(deviceId, dec(b), isErr) } catch { /* 忽略 */ }
    })
  }
  push(child.stdout, false)
  push(child.stderr, true)
  child.on('close', (code) => {
    termSessions.delete(deviceId)
    void serverClient.devTermClose(deviceId, code ?? 0)
  })
  child.on('error', (e) => { void serverClient.devTermOut(deviceId, '\r\n[终端错误] ' + (e.message || ''), true) })
}
function termIn(deviceId: string, data: string): void {
  const child = termSessions.get(deviceId)
  if (!child) { void serverClient.devTermOut(deviceId, '\r\n[会话未建立] 请重新打开终端\r\n', true); return }
  try { child.stdin?.write(data) } catch { /* 忽略 */ }
}
function termClose(deviceId: string): void {
  const child = termSessions.get(deviceId)
  termSessions.delete(deviceId)
  if (child) { try { child.kill('SIGKILL') } catch { /* 忽略 */ } }
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerServerIpcHandlers(getMainWindow: () => BrowserWindow | null): void {
  /**
   * 退回登录页时关掉所有附加窗口（会议、任务详情、预览、远程、工具栏…）。
   * 只保留主窗口（登录页与主界面都在主窗口里）。先 close 让各窗口走正常收尾
   * （停流、释放设备），再兜底 destroy 掉少数自己拦了 close 的窗口。
   */
  const closeAuxWindows = (): void => {
    const main = getMainWindow()
    if (!main) return
    const sweep = (force: boolean): void => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w === main || w.isDestroyed()) continue
        try {
          if (force) w.destroy()
          else w.close()
        } catch { /* 已销毁/关闭中被拦，忽略 */ }
      }
    }
    sweep(false)
    setTimeout(() => sweep(true), 800)
  }

  // 推送 → renderer
  serverClient.on('state', (s) => {
    sendToMainWindow(getMainWindow(), IpcEvents.serverState, s)
    void console.log(`state connected=${s.connected} url=${s.serverUrl} user=${s.nick || s.username || ''} token=${s.token ? '有' : '无'}`)
    // 会话丢失（登出/被踢/过期/断线退回登录页）：主界面会切回登录页，
    // 多余的独立窗口（会议、任务详情、预览、远程…）必须一起关掉，否则会留下
    // 「已经退出登录，会议窗口还开着」这种拿着旧会话数据的窗口。
    const hadUser = lastUserId != null
    lastUserId = s.userId
    if (hadUser && s.userId == null) closeAuxWindows()
    // 登录连接后启动本机系统信息上报（被控端）；断开即停
    // 协议：动态包(dev:sys) → 服务端返回 updated（设备完整）/ lost（缺失或基础信息不全）；
    //       lost → 立即重发全量 dev:register → 服务端返回 added → 之后只发动态。
    // 被控端系统上报：只在【已登录】时上报。
    // 未登录（启动停在登录页）、断线、退出登录后都不上报 —— 没登录时设备属于谁都不知道，
    // 上报出去只会给服务端留下一堆无主设备。
    const loggedIn = s.connected && s.userId != null
    if (loggedIn) {
      void console.log(`startSysReport 启动（被控端系统上报）user=${s.username ?? ''} id=${s.userId}`)
      startSysReport(async (p, onAck) => {
        try {
          const ack = await serverClient.devSys(p)
          // 服务端 ack 为 { ok, status }，normalizeAck 会把 status 归入 data，故从 ack.data.status 读取
          const status = (ack as { data?: { status?: string } }).data?.status ?? (ack?.ok ? 'updated' : 'lost')
          onAck?.(status)
          // void console.log(`dev:sys deviceId=${p.deviceId} ack=${status}`)
          if (!ack?.ok || status === 'lost') {
            const info = (p.info ?? {}) as Record<string, unknown>
            const ips = (info.ips as Array<{ name?: string; address?: string; internal?: boolean }> | undefined) ?? []
            const pub = ips.find((x) => !x.internal)?.address ?? ips[0]?.address ?? ''
            const st = serverClient.state
            const regAck = await serverClient.devRegister({
              deviceId: p.deviceId,
              name: String(info.hostname ?? '电脑').slice(0, 64),
              os: `${info.type ?? ''} ${info.release ?? ''}`.trim().slice(0, 128),
              ip: pub,
              username: st.nick || st.username || ''
            })
            void console.log(`服务端返回 ${status}，已重发全量注册 regAck=${(regAck as { data?: { status?: string } }).data?.status ?? (regAck?.ok ? 'ok' : regAck?.error)}`)
          }
        } catch (e) {
          void console.log(`dev:sys 上报异常: ${e instanceof Error ? e.message : String(e)}`)
        }
      })
    } else {
      void console.log(`stopSysReport（${s.connected ? '已连接但未登录' : '未连接'}）`)
      stopSysReport()
    }
  })
  serverClient.on('message', (m) => sendToMainWindow(getMainWindow(), IpcEvents.serverMessage, m))
  serverClient.on('presence', (p) => sendToMainWindow(getMainWindow(), IpcEvents.serverPresence, p))
  serverClient.on('userProfileUpdated', (d) => sendToMainWindow(getMainWindow(), IpcEvents.userProfileUpdated, d))
  serverClient.on('messageDeleted', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverMessageDeleted, d))
  serverClient.on('conversationsUpdated', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverConversationsUpdated, d))
  serverClient.on('chatReadReceipt', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverChatReadReceipt, d))
  serverClient.on('sessionNewDevice', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverSessionNewDevice, d))
  serverClient.on('sessionRevoked', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverSessionRevoked, d))
  // 断线重试失败 → 渲染层提示并回登录页（token 保留，不用清）
  serverClient.on('reconnectGaveUp', (d) => sendToMainWindow(getMainWindow(), IpcEvents.serverReconnectGaveUp, d))

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
  serverClient.on('requirementsUpdated', (d: unknown) => broadcastToAllWindows(IpcEvents.requirementsUpdated, d ?? {}))
  serverClient.on('bugsUpdated', (d: unknown) => broadcastToAllWindows(IpcEvents.bugsUpdated, d ?? {}))
  serverClient.on('plansUpdated', (d: unknown) => broadcastToAllWindows(IpcEvents.plansUpdated, d ?? {}))
  serverClient.on('docsUpdated', (d: unknown) => broadcastToAllWindows(IpcEvents.docsUpdated, d ?? {}))
  serverClient.on('wikiUpdated', (d: unknown) => broadcastToAllWindows(IpcEvents.wikiUpdated, d ?? {}))
  // 日报/周报：服务端到点提醒 → 广播渲染层
  serverClient.on('reportReminder', (d: unknown) => broadcastToAllWindows(IpcEvents.reportReminder, d ?? {}))
  // 远程设备控制：服务端 → 被控端（渲染层 RemoteControl）
  serverClient.on('devView', (d) => broadcastToAllWindows(IpcEvents.devView, d ?? {}))
  serverClient.on('devEnumerate', (d) => broadcastToAllWindows(IpcEvents.devEnumerate, d ?? {}))
  serverClient.on('devStart', (d) => broadcastToAllWindows(IpcEvents.devStart, d ?? {}))
  serverClient.on('devStop', (d) => broadcastToAllWindows(IpcEvents.devStop, d ?? {}))
  serverClient.on('devSignal', (d) => broadcastToAllWindows(IpcEvents.devSignal, d ?? {}))
  // 控制端请求在被控端执行命令：主进程用所选 shell 执行（Windows: cmd/powershell；Linux: 默认 sh），结果回传
  serverClient.on('devExec', (d) => {
    const p = (d ?? {}) as { deviceId?: unknown; shell?: unknown; cmd?: unknown }
    const deviceId = String(p.deviceId ?? '')
    const cmd = typeof p.cmd === 'string' ? p.cmd.trim() : ''
    if (!deviceId || !cmd) { void serverClient.devExecResult(deviceId, { ok: false, exitCode: -1, stdout: '', stderr: '空命令' }); return }
    execRemote(deviceId, String(p.shell ?? 'auto'), cmd)
  })
  // 交互终端：控制端请求在被控端开/读写常驻 shell 会话
  serverClient.on('devTermOpen', (d) => { const p = (d ?? {}) as { deviceId?: unknown; shell?: unknown }; termOpen(String(p.deviceId ?? ''), String(p.shell ?? 'auto')) })
  serverClient.on('devTermIn', (d) => { const p = (d ?? {}) as { deviceId?: unknown; data?: unknown }; termIn(String(p.deviceId ?? ''), String(p.data ?? '')) })
  serverClient.on('devTermClose', (d) => { const p = (d ?? {}) as { deviceId?: unknown }; termClose(String(p.deviceId ?? '')) })

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
    closeAuxWindows()
  })
  /**
   * 切换服务器地址：换服务器=换账号体系，旧 token 清掉，并断开当前会话，
   * 让渲染层拿到 userId=undefined → 回登录页；随后用新地址、不带 token 重连。
   * 顺序很重要：先 disconnect（清 userId → 渲染层立刻回登录页、关掉多余窗口），再 connect。
   */
  ipcMain.handle(IpcChannels.serverChangeUrl, (_e, url) => {
    const cfg = saveServerConfig({ serverUrl: String(url ?? ''), token: '' })
    closeAuxWindows()
    serverClient.disconnect()
    serverClient.connect({ serverUrl: cfg.serverUrl })
    return cfg
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
  ipcMain.handle(IpcChannels.serverConversationRead, (_e, conversationId, lastMessageId) =>
    serverClient.markConversationRead(Number(conversationId) || 0, lastMessageId ? Number(lastMessageId) : null)
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
  ipcMain.handle(IpcChannels.serverMessageDelete, (_e, conversationId, messageId, content) =>
    serverClient.deleteMessage(Number(conversationId) || 0, String(messageId), String(content ?? ''))
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
  ipcMain.handle(IpcChannels.serverTaskComment, (_e, taskId, content, attachments) => serverClient.taskComment(Number(taskId) || 0, String(content ?? ''), Array.isArray(attachments) ? attachments : []))
  ipcMain.handle(IpcChannels.serverTaskAddIssue, (_e, taskId, title, content) => serverClient.taskAddIssue(Number(taskId) || 0, String(title ?? ''), String(content ?? '')))
  ipcMain.handle(IpcChannels.serverTaskResolveIssue, (_e, issueId) => serverClient.taskResolveIssue(Number(issueId) || 0))
  ipcMain.handle(IpcChannels.serverTaskRequestExtension, (_e, taskId, dt, reason) => serverClient.taskRequestExtension(Number(taskId) || 0, String(dt), String(reason ?? '')))
  ipcMain.handle(IpcChannels.serverTaskDecideExtension, (_e, companyId, taskId, extensionId, approved) => serverClient.taskDecideExtension(Number(companyId) || 0, Number(taskId) || 0, Number(extensionId) || 0, Boolean(approved)))

  // TAPD 项目管理
  ipcMain.handle(IpcChannels.serverReqList, (_e, companyId, projectId) => serverClient.reqList(Number(companyId) || 0, projectId ? Number(projectId) : undefined))
  ipcMain.handle(IpcChannels.serverReqCreate, (_e, payload) => serverClient.reqCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReqUpdate, (_e, payload) => serverClient.reqUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReqStatus, (_e, id, status) => serverClient.reqStatus(Number(id) || 0, String(status ?? '')))
  ipcMain.handle(IpcChannels.serverReqDelete, (_e, id) => serverClient.reqDelete(Number(id) || 0))
  ipcMain.handle(IpcChannels.serverReqLinkTasks, (_e, id, taskIds) => serverClient.reqLinkTasks(Number(id) || 0, Array.isArray(taskIds) ? taskIds.map((x: unknown) => Number(x) || 0).filter((n: number) => n > 0) : []))
  ipcMain.handle(IpcChannels.serverBugList, (_e, companyId, projectId) => serverClient.bugList(Number(companyId) || 0, projectId ? Number(projectId) : undefined))
  ipcMain.handle(IpcChannels.serverBugCreate, (_e, payload) => serverClient.bugCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverBugUpdate, (_e, payload) => serverClient.bugUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverBugStatus, (_e, id, status) => serverClient.bugStatus(Number(id) || 0, String(status ?? '')))
  ipcMain.handle(IpcChannels.serverBugDelete, (_e, id) => serverClient.bugDelete(Number(id) || 0))
  ipcMain.handle(IpcChannels.serverPlanList, (_e, companyId, projectId) => serverClient.planList(Number(companyId) || 0, projectId ? Number(projectId) : undefined))
  ipcMain.handle(IpcChannels.serverPlanCreate, (_e, payload) => serverClient.planCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverPlanUpdate, (_e, payload) => serverClient.planUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverPlanDelete, (_e, id) => serverClient.planDelete(Number(id) || 0))
  ipcMain.handle(IpcChannels.serverDocList, (_e, companyId, projectId) => serverClient.docList(Number(companyId) || 0, projectId ? Number(projectId) : undefined))
  ipcMain.handle(IpcChannels.serverDocCreate, (_e, payload) => serverClient.docCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverDocUpdate, (_e, payload) => serverClient.docUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverDocDelete, (_e, id) => serverClient.docDelete(Number(id) || 0))
  ipcMain.handle(IpcChannels.serverWikiList, (_e, companyId, projectId) => serverClient.wikiList(Number(companyId) || 0, projectId ? Number(projectId) : undefined))
  ipcMain.handle(IpcChannels.serverWikiCreate, (_e, payload) => serverClient.wikiCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverWikiUpdate, (_e, payload) => serverClient.wikiUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverWikiDelete, (_e, id) => serverClient.wikiDelete(Number(id) || 0))
  ipcMain.handle(IpcChannels.serverPmDashboard, (_e, companyId, projectId) => serverClient.pmDashboard(Number(companyId) || 0, projectId ? Number(projectId) : undefined))
  ipcMain.handle(IpcChannels.serverPmMemberTracking, (_e, companyId, projectId) => serverClient.pmMemberTracking(Number(companyId) || 0, projectId ? Number(projectId) : undefined))

  // 日报/周报
  ipcMain.handle(IpcChannels.serverReportCurrent, (_e, companyId, type) => serverClient.reportCurrent(Number(companyId) || 0, String(type ?? '')))
  ipcMain.handle(IpcChannels.serverReportCreate, (_e, payload) => serverClient.reportCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReportUpdate, (_e, payload) => serverClient.reportUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReportSubmit, (_e, companyId, id) => serverClient.reportSubmit(Number(companyId) || 0, Number(id) || 0))
  ipcMain.handle(IpcChannels.serverReportDelete, (_e, companyId, id) => serverClient.reportDelete(Number(companyId) || 0, Number(id) || 0))
  ipcMain.handle(IpcChannels.serverReportList, (_e, payload) => serverClient.reportList((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReportInbox, (_e, payload) => serverClient.reportInbox((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReportTemplateList, (_e, companyId) => serverClient.reportTemplateList(Number(companyId) || 0))
  ipcMain.handle(IpcChannels.serverReportTemplateCreate, (_e, payload) => serverClient.reportTemplateCreate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReportTemplateUpdate, (_e, payload) => serverClient.reportTemplateUpdate((payload as Record<string, unknown>) ?? {}))
  ipcMain.handle(IpcChannels.serverReportTemplateDelete, (_e, companyId, id) => serverClient.reportTemplateDelete(Number(companyId) || 0, Number(id) || 0))
  ipcMain.handle(IpcChannels.serverReportStats, (_e, payload) => serverClient.reportStats((payload as Record<string, unknown>) ?? {}))

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
  ipcMain.handle(IpcChannels.serverDownloadFolder, async (_e, relPath) => {
    const t0 = Date.now()
    const r = await serverClient.downloadFolder(String(relPath), loadServerConfig().downloadDir)
    console.log(`[fs:folder] 下载 ${relPath} -> ok=${r.ok} count=${r.count ?? 0} dest=${r.destDir ?? ''} err=${r.error ?? ''} ${Date.now() - t0}ms`)
    return r
  })

  // RTC 信令
  ipcMain.handle(IpcChannels.rtcCreateMeeting, (_e, opts) => serverClient.rtcCreateMeeting(opts as { title?: string; startAt?: string; password?: string; kind: 'video' | 'voice' }))
  ipcMain.handle(IpcChannels.rtcGetMeeting, (_e, meetingNo) => serverClient.rtcGetMeeting(String(meetingNo)))
  ipcMain.handle(IpcChannels.rtcJoin, (_e, roomId, password, kind) => serverClient.rtcJoin(String(roomId), typeof password === 'string' ? password : undefined, kind === 'voice' ? 'voice' : kind === 'video' ? 'video' : undefined))
  ipcMain.handle(IpcChannels.rtcSignal, (_e, roomId, signal) => serverClient.rtcSignal(String(roomId), signal as import('../shared/server-types').RtcSignalPayload))
  ipcMain.handle(IpcChannels.rtcLeave, (_e, roomId) => serverClient.rtcLeave(String(roomId)))
  ipcMain.handle(IpcChannels.rtcEnd, (_e, roomId) => serverClient.rtcEnd(String(roomId)))
  ipcMain.handle(IpcChannels.rtcDmCall, (_e, userId, kind, password) => serverClient.rtcDmCall(Number(userId) || 0, kind === 'voice' ? 'voice' : kind === 'remote' ? 'remote' : 'video', typeof password === 'string' ? password : undefined))
  ipcMain.handle(IpcChannels.rtcDmAnswer, (_e, roomId, accept) => serverClient.rtcDmAnswer(String(roomId), accept === true))
  ipcMain.handle(IpcChannels.rtcGroupCall, (_e, groupId, kind) => serverClient.rtcGroupCall(Number(groupId) || 0, kind === 'voice' ? 'voice' : 'video'))
  ipcMain.handle(IpcChannels.rtcChatSend, (_e, roomId, content) => serverClient.rtcChatMessage(String(roomId), String(content ?? '')))

  // 远程设备控制（被控端）：渲染 → main → serverClient socket
  ipcMain.handle(IpcChannels.devRegister, (_e, payload) => serverClient.devRegister(payload as { deviceId: string; name: string; os: string; ip: string; username: string }))
  ipcMain.handle(IpcChannels.devHeartbeat, (_e, info) => {
    // 心跳携带完整设备信息，服务端按 deviceId upsert（没有就添加，有就更新）
    const p = (info ?? {}) as { deviceId?: unknown; name?: unknown; os?: unknown; ip?: unknown; username?: unknown }
    serverClient.devHeartbeat({
      deviceId: String(p.deviceId ?? ''),
      name: String(p.name ?? ''),
      os: String(p.os ?? ''),
      ip: String(p.ip ?? ''),
      username: String(p.username ?? '')
    })
    return Promise.resolve()
  })
  ipcMain.handle(IpcChannels.devDevices, (_e, deviceId, cams, mics) => serverClient.devDevices(String(deviceId ?? ''), cams as Array<{ id: string; label: string }>, mics as Array<{ id: string; label: string }>))
  ipcMain.handle(IpcChannels.devSignal, (_e, deviceId, signal) => serverClient.devSignal(String(deviceId ?? ''), signal))
  // 本机信息（deviceId/hostname/os/ip），供被控端注册用
  ipcMain.handle(IpcChannels.devGetInfo, () => {
    const os = require('node:os') as typeof import('node:os')
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const idFile = path.join(app.getPath('userData'), 'device-id.json')
    let deviceId = ''
    try {
      if (fs.existsSync(idFile)) deviceId = (JSON.parse(fs.readFileSync(idFile, 'utf8')) as { id?: string }).id ?? ''
      if (!deviceId) {
        deviceId = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
        fs.writeFileSync(idFile, JSON.stringify({ id: deviceId }), 'utf8')
      }
    } catch { deviceId = deviceId || 'dev-' + Math.random().toString(36).slice(2, 10) }
    const nets = os.networkInterfaces()
    let ip = ''
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n && n.family === 'IPv4' && !n.internal) { ip = n.address; break }
      }
      if (ip) break
    }
    return {
      deviceId,
      hostname: os.hostname(),
      os: os.type() + ' ' + os.release(),
      ip: ip || '127.0.0.1'
    }
  })

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
  // 下载远程文件到本地存储路径（图片/视频/3D 预览用），返回 {ok,path,fileUrl,error}
  //
  // 下载期间向发起窗口推送 downloadProgress：大文件（几十 MB 的 Office 文档/视频）
  // 纯下载要好几秒到几十秒，界面上没有任何反馈会被当成「点了没反应」的 bug。
  ipcMain.handle(IpcChannels.serverDownloadFile, async (e, url) => {
    const t0 = Date.now()
    const win = BrowserWindow.fromWebContents(e.sender)
    const urlStr = String(url)
    // 节流：>=120ms 或整数百分比变化才推一次，避免大文件把 IPC 打满
    let lastAt = 0
    let lastPct = Number.NaN
    const onProgress = (received: number, total: number): void => {
      const pct = total > 0 ? Math.floor((received / total) * 100) : -1
      const now = Date.now()
      if (now - lastAt < 120 && pct === lastPct) return
      lastAt = now
      lastPct = pct
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(IpcEvents.downloadProgress, { url: urlStr, received, total, percent: pct })
      }
    }
    try {
      const rawUrl = String(url)
      const safeUrl = (u: string): string => String(u).replace(/token=[^&]+/g, 'token=***')
      // URL 里的文件名可能是百分号编码（如 %E7%8E%84...xlsx），落盘前必须还原成中文，
      // 否则保存下来的文件名会是一串 %XX，且同名去重会叠成 "xxx (6) (6).xlsx" 这种乱名。
      const name = decodeUrlName(basename(rawUrl.split('?')[0] ?? '').trim()) || 'download.bin'
      // 统一下载到设置里的存储路径（downloadDir），与手动下载一致
      const dir = loadServerConfig().downloadDir
      await mkdir(dir, { recursive: true })
      console.log(`[fs:download] 开始 url=${safeUrl(rawUrl)} name=${name} dir=${dir}`)
      const safe = name.replace(/[\\/:*?"<>|]/g, '_')
      let dest = join(dir, safe)
      // 同名去重：已存在则追加 (n)，避免覆盖已有文件
      let n = 1
      for (;;) {
        try {
          await stat(dest)
          const m = safe.match(/^(.+?)(\.[a-z0-9]+)?$/i)
          const stem = m?.[1] ?? safe
          const ext = m?.[2] ?? ''
          dest = join(dir, `${stem} (${n})${ext}`)
          n += 1
        } catch {
          break
        }
      }
      const dl = await serverClient.downloadFile(rawUrl, onProgress)
      if (!dl.ok || !dl.buf) {
        console.log(`[fs:download] 失败 url=${safeUrl(rawUrl)} err=${dl.error ?? ''} ${Date.now() - t0}ms`)
        return { ok: false, error: dl.error || '下载失败' }
      }
      await writeFile(dest, dl.buf)
      console.log(`[fs:download] 完成 -> ${dest} ${dl.buf.length}B ${Date.now() - t0}ms`)
      // 整条 Windows 路径编码进 URL：避免 `C:` 盘符被 Chromium 解析成 host（app-file://c/...）导致路径丢失
      return { ok: true, path: dest, fileUrl: `app-file:///${encodeURIComponent(dest)}` }
    } catch (err) {
      console.log(`[fs:download] 异常 ${err instanceof Error ? err.message : String(err)} ${Date.now() - t0}ms`)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // 保存通话/会议录制到 {downloadDir}/通话录制/{name}（Document=个人文档目录，默认 文档/麻薯）
  ipcMain.handle(IpcChannels.appSaveRecording, async (_e, payload) => {
    const t0 = Date.now()
    try {
      const p = (payload ?? {}) as { name?: unknown; base64?: unknown }
      const name = String(p.name ?? `通话录制_${Date.now()}.webm`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
      const base64 = String(p.base64 ?? '')
      if (!base64) return { ok: false, error: '没有可保存的录制数据' }
      const dir = join(loadServerConfig().downloadDir, '通话录制')
      await mkdir(dir, { recursive: true })
      const dest = join(dir, name.endsWith('.webm') ? name : `${name}.webm`)
      const buf = Buffer.from(base64, 'base64')
      await writeFile(dest, buf)
      console.log(`[fs:save] 录制 ${name} -> ${dest} ${buf.length}B ${Date.now() - t0}ms`)
      return { ok: true, path: dest, error: '' }
    } catch (err) {
      console.log(`[fs:save] 录制失败 ${err instanceof Error ? err.message : String(err)} ${Date.now() - t0}ms`)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // 读取本地文件为 ArrayBuffer（3D 模型解析用）
  ipcMain.handle(IpcChannels.serverReadFileBytes, async (_e, filePath) => {
    try {
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

  ipcMain.handle(IpcChannels.filePickMulti, async (e, filter) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    let filters: Electron.FileFilter[]
    if (filter === 'image') filters = [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'] }]
    else if (filter === 'video') filters = [{ name: '视频', extensions: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'flv'] }]
    else if (filter === 'audio') filters = [{ name: '音频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac', 'wma'] }]
    else filters = [{ name: '所有文件', extensions: ['*'] }]
    const res = await dialog.showOpenDialog(win ?? undefined as unknown as BrowserWindow, {
      title: '选择文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters
    })
    return Promise.resolve(res.canceled ? [] : res.filePaths ?? [])
  })

  // 递归枚举文件夹内所有文件（用于发送文件夹）
  ipcMain.handle(IpcChannels.serverListFolderFiles, async (_e, folderPath) => {
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

  // 截屏：捕获主显示器全屏（物理分辨率），返回 dataURL + 尺寸（渲染层做框选/编辑）
  ipcMain.handle(IpcChannels.fileCaptureScreen, async () => {
    try {
      const disp = screen.getPrimaryDisplay()
      const dpr = disp.scaleFactor || 1
      const w = Math.round(disp.size.width * dpr)
      const h = Math.round(disp.size.height * dpr)
      const source = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: w, height: h }
      })
      if (!source || source.length === 0) {
        return null
      }
      const thumb = source.find((s) => s.name.toLowerCase().includes('screen')) ?? source[0]
      const dataUrl = thumb.thumbnail.toDataURL()
      return { dataUrl, width: w, height: h }
    } catch {
      return null
    }
  })

  // 把编辑后的 dataUrl 写为临时 PNG，返回文件路径（供 sendFile 上传发送）
  ipcMain.handle(IpcChannels.fileWriteTempImage, async (_e, dataUrl: unknown) => {
    try {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const buf = Buffer.from(b64, 'base64')
      const out = join(tmpdir(), `shot-${Date.now()}.png`)
      await writeFile(out, buf)
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
  // 解析通知提示音文件：自定义路径存在就用它；丢失/为空自动回退 resources 里的默认
  // （message.wav / calling.mp3）。判定放主进程，渲染层不用猜路径。
  ipcMain.handle(IpcChannels.appResolveNotifySound, (_e, opts) => {
    const o = (opts ?? {}) as { kind?: unknown; customPath?: unknown }
    const kind = (typeof o.kind === 'string' ? o.kind : 'message') as NotifKind
    return resolveSoundFile(kind, typeof o.customPath === 'string' ? o.customPath : undefined)
  })
  ipcMain.handle(IpcChannels.appInfo, () => {
    const { app } = require('electron') as typeof import('electron')
    return Promise.resolve({ version: app.getVersion(), name: app.getName() })
  })
  ipcMain.handle(IpcChannels.appOpenFileLocation, (_e, p) => {
    if (typeof p === 'string' && p) shell.showItemInFolder(p)
    return Promise.resolve()
  })
  /**
   * 用系统默认程序打开本地文件。
   * 聊天里不能内嵌预览的文件（txt / zip / exe / psd…）都走这里，而不是给渲染层一个
   * app-file:// 链接让浏览器 target=_blank 打开 —— 那样只会弹「获取打开此"about"的应用」。
   * shell.openPath 三平台通用（Windows ShellExecute / macOS open / Linux xdg-open）：
   * 成功返回空串；没有关联程序时由系统自己弹「选择打开方式」，和双击文件行为一致。
   */
  ipcMain.handle(IpcChannels.appOpenPath, async (_e, p) => {
    const file = typeof p === 'string' ? p : ''
    if (!file) return { ok: false, error: '缺少文件路径' }
    if (!existsSync(file)) return { ok: false, error: '文件不存在（可能已被移动或删除）' }
    try {
      const err = await shell.openPath(file)
      if (err) {
        console.log(`[openPath] 系统打开失败 file=${file} err=${err}`)
        return { ok: false, error: err }
      }
      return { ok: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.log(`[openPath] 系统打开异常 file=${file} err=${msg}`)
      return { ok: false, error: msg }
    }
  })
  // 写系统剪贴板：用 Electron clipboard（渲染层的 navigator.clipboard 依赖页面聚焦与安全上下文，
  // 打包后走 file:// 时不稳），消息右键「复制」走这里。
  ipcMain.handle(IpcChannels.appClipboardWriteText, (_e, text) => {
    try {
      const { clipboard } = require('electron') as typeof import('electron')
      clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
      return { ok: true }
    } catch (err) {
      console.log(`[clipboard] 写入文本失败 ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // 把本地图片文件写进系统剪贴板（右键图片消息「复制图片」）：
  // 剪贴板放进的是图片本身（不是路径/URL），可以直接粘到微信、Word 等任何地方。
  ipcMain.handle(IpcChannels.appClipboardWriteImage, (_e, filePath) => {
    try {
      const { clipboard, nativeImage } = require('electron') as typeof import('electron')
      const p = typeof filePath === 'string' ? filePath : ''
      if (!p) return { ok: false, error: '缺少图片路径' }
      const img = nativeImage.createFromPath(p)
      if (img.isEmpty()) return { ok: false, error: '图片读取失败（文件不存在或格式不支持）' }
      clipboard.writeImage(img)
      return { ok: true }
    } catch (err) {
      console.log(`[clipboard] 写入图片失败 ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  // 把一段二进制落成临时文件并返回路径：粘贴剪贴板图片时渲染层只能拿到 blob，
  // 而上传链路全是按「本地文件路径」走的，所以先落临时文件再复用 serverUploadChunked。
  ipcMain.handle(IpcChannels.appWriteTempFile, async (_e, payload) => {
    try {
      const p = (payload ?? {}) as { name?: unknown; data?: unknown }
      const buf = Buffer.from(p.data as ArrayBuffer)
      if (buf.length === 0) return { ok: false, error: '内容为空' }
      const rawName = String(p.name ?? `paste_${Date.now()}.png`)
      const safe = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || `paste_${Date.now()}.png`
      const { app } = require('electron') as typeof import('electron')
      const dir = join(app.getPath('temp'), 'mochi-oa-paste')
      await mkdir(dir, { recursive: true })
      const dest = join(dir, `${Date.now()}_${safe}`)
      await writeFile(dest, buf)
      console.log(`[paste] 临时文件 ${dest} ${buf.length}B`)
      return { ok: true, path: dest }
    } catch (err) {
      console.log(`[paste] 写临时文件失败 ${err instanceof Error ? err.message : String(err)}`)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
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

  // 打开独立任务详情窗口
  ipcMain.handle(IpcChannels.openTaskWindow, (_e, taskId) => {
    const win = new BrowserWindow({
      width: 1100, height: 760, minWidth: 860, minHeight: 600,
      resizable: true, autoHideMenuBar: true, backgroundColor: '#ffffff',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    const query: Record<string, string> = { taskId: String(taskId ?? 0) }
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/task.html?${new URLSearchParams(query).toString()}`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/task.html'), { query })
    }
  })

  // 打开独立 Office 预览窗口（PDF / Word / Excel）：复用 ChatWindow 内嵌预览组件的渲染逻辑，
  // 仅改为独立 BrowserWindow 承载（组件以 standalone 模式隐藏弹窗外壳、全屏渲染）。
  ipcMain.handle(IpcChannels.openPreviewWindow, (_e, params) => {
    const p = (params ?? {}) as { kind?: unknown; path?: unknown; name?: unknown }
    const kind = String(p.kind ?? '')
    const path = String(p.path ?? '')
    const name = String(p.name ?? '')
    if (kind !== 'pdf' && kind !== 'word' && kind !== 'excel') return { ok: false, error: '未知预览类型: ' + kind }
    if (!path) return { ok: false, error: '缺少本地文件路径' }
    const win = new BrowserWindow({
      width: 1100, height: 820, minWidth: 700, minHeight: 520,
      resizable: true, frame: false, autoHideMenuBar: true, backgroundColor: '#f0f2f5',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    const query: Record<string, string> = { kind, path, name }
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/preview.html?${new URLSearchParams(query).toString()}`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/preview.html'), { query })
    }
    return { ok: true }
  })

  // 打开独立远程控制窗口（控制端）：无边框 + 主窗口样式 + 可缩放。
  // 会话参数先暂存，远程窗口 ready 后经 remoteGetParams 取回，再由远程窗口内建 WebRTC 会话。
  let pendingRemote: { room: string; iceServers: unknown[]; mode: string; peerId: number; peerName: string; meId: number } | null = null
  ipcMain.handle(IpcChannels.openRemoteWindow, (_e, params) => {
    const p = (params ?? {}) as { room?: unknown; iceServers?: unknown; mode?: unknown; peerId?: unknown; peerName?: unknown; meId?: unknown }
    const room = String(p.room ?? '')
    if (!room) return { ok: false, error: '缺少会话标识' }
    pendingRemote = {
      room,
      iceServers: Array.isArray(p.iceServers) ? p.iceServers : [],
      mode: p.mode === 'local' ? 'local' : 'remote',
      peerId: Number(p.peerId) || 0,
      peerName: String(p.peerName ?? ''),
      meId: Number(p.meId) || 0
    }
    const win = new BrowserWindow({
      width: 1240, height: 820, minWidth: 800, minHeight: 560,
      resizable: true, frame: false, autoHideMenuBar: true, backgroundColor: '#0e0f12',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/remote.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/remote.html'))
    }
    // 兜底：远程窗口被关掉（任务栏 X / Alt+F4 / 系统关闭）时，渲染层可能已经来不及发 bye
    // ——那样被控端会一直挂着「正在被 [对方] 控制」。这里在主进程补一发：
    // 信令 bye（让被控端立刻收场）+ rtc:leave（把本端移出房间，对端还会收到 peerLeft）。
    win.on('closed', () => {
      console.log(`[remote] 远程窗口已关闭 room=${room} → 补发 bye 信令 + rtc:leave`)
      void serverClient.rtcSignal(room, { type: 'bye' } as never).catch(() => { /* 已断开就算了 */ })
      void serverClient.rtcLeave(room).catch(() => { /* 已断开就算了 */ })
    })
    return { ok: true }
  })
  ipcMain.handle(IpcChannels.remoteGetParams, () => pendingRemote)

  // 打开独立全屏截屏窗口（固定、不可调整）——先把截图数据暂存，截图窗口 ready 后再取
  // 同时打开独立工具栏窗口（框选时用）；全屏编辑时隐藏独立窗口、工具栏内嵌在编辑窗口内部
  let pendingScreenshot: { dataUrl: string; width: number; height: number } | null = null
  let screenshotWin: BrowserWindow | null = null
  let screenshotToolbarWin: BrowserWindow | null = null
  const openScreenshotToolbar = (): void => {
    const tw = new BrowserWindow({
      alwaysOnTop: true,
      frame: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#1b1b1f',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    // 工具栏固定到主屏顶部中央，置顶在截图窗口之上、不可移动
    const disp = screen.getPrimaryDisplay()
    const TW = ScreenshotToolbar.WIDTH
    const TH = ScreenshotToolbar.HEIGHT
    tw.setAlwaysOnTop(true, 'screen-saver')
    tw.setBounds({ x: Math.round((disp.workArea.width - TW) / 2), y: 0, width: TW, height: TH })
    tw.once('ready-to-show', () => {
      tw.show()
      tw.moveTop()
    })
    if (process.env['ELECTRON_RENDERER_URL']) {
      void tw.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/toolbar.html`)
    } else {
      void tw.loadFile(join(__dirname, '../renderer/toolbar.html'))
    }
    screenshotToolbarWin = tw
    tw.on('closed', () => {
      if (screenshotToolbarWin === tw) screenshotToolbarWin = null
    })
  }
  ipcMain.handle(IpcChannels.openScreenshotWindow, (_e, payload) => {
    const p = (payload ?? {}) as { dataUrl?: unknown; width?: unknown; height?: unknown }
    if (typeof p.dataUrl !== 'string') return { ok: false, error: 'no data' }
    pendingScreenshot = {
      dataUrl: p.dataUrl,
      width: Number(p.width) || 0,
      height: Number(p.height) || 0
    }
    const win = new BrowserWindow({
      alwaysOnTop: true,
      frame: false,
      resizable: false,
      maximizable: false,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#000000',
      webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    // 捕获窗口全程置顶（screen-saver 最高级别）：覆盖任务栏、不被任何窗口（含工具栏）覆盖
    win.setAlwaysOnTop(true, 'screen-saver')
    // 框选之前：窗口铺满整个显示器（含任务栏区域）、置顶、无边框
    win.once('ready-to-show', () => {
      win.setBounds(screen.getPrimaryDisplay().bounds)
      win.show()
      win.moveTop()
      const tw = screenshotToolbarWin
      if (tw && !tw.isDestroyed()) tw.moveTop()
    })
    win.on('closed', () => {
      if (screenshotWin === win) screenshotWin = null
      if (screenshotToolbarWin && !screenshotToolbarWin.isDestroyed()) screenshotToolbarWin.close()
      screenshotToolbarWin = null
    })
    screenshotWin = win
    // 工具栏窗口创建失败不得阻断截图窗口（否则截图窗口不会 loadURL/show → 黑屏）
    try {
      openScreenshotToolbar()
    } catch {
      /* 静默：截图窗口仍正常打开 */
    }
    if (process.env['ELECTRON_RENDERER_URL']) {
      void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/screenshot.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/screenshot.html'))
    }
    return { ok: true }
  })
  // 工具栏窗口命令 → 转发到当前截图窗口（驱动编辑器）
  ipcMain.on(IpcChannels.screenshotToolbarCommand, (_e, cmd: unknown) => {
    if (screenshotWin && !screenshotWin.isDestroyed()) {
      screenshotWin.webContents.send(IpcEvents.screenshotToolbarCommand, cmd ?? {})
    }
  })
  // 截图窗口 → 显示/隐藏独立工具栏窗口（全屏编辑隐藏→内嵌工具栏；框选显示）
  ipcMain.handle(IpcChannels.screenshotToolbarVisible, (_e, visible: unknown) => {
    const tw = screenshotToolbarWin
    if (!tw || tw.isDestroyed()) return { ok: false }
    if (visible) {
      tw.show()
      tw.moveTop()
    } else {
      tw.hide()
    }
    return { ok: true }
  })
  // 截图窗口 → 移动独立工具栏窗口到目标位置（框选：区域外侧，上下空间就近；置顶不可移动，程序化 setBounds）
  ipcMain.handle(IpcChannels.screenshotToolbarPos, (_e, pos: unknown) => {
    const tw = screenshotToolbarWin
    if (!tw || tw.isDestroyed()) return { ok: false }
    const p = (pos ?? {}) as { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
    const x = Number(p.x)
    const y = Number(p.y)
    const width = Number(p.width)
    const height = Number(p.height)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return { ok: false }
    tw.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) })
    tw.show()
    tw.moveTop()
    return { ok: true }
  })
  // 截图窗口 → 已进入编辑：通知工具栏窗口切换为完整工具/颜色/保存（选择阶段只显示全屏/取消）
  ipcMain.on(IpcChannels.screenshotToolbarEdit, (_e) => {
    const tw = screenshotToolbarWin
    if (tw && !tw.isDestroyed()) tw.webContents.send(IpcEvents.screenshotToolbarEdit)
  })
  ipcMain.handle(IpcChannels.screenshotGetPending, () => {
    const p = pendingScreenshot
    pendingScreenshot = null
    return p
  })
  ipcMain.handle(IpcChannels.screenshotSave, async (_e, dataUrl: unknown) => {
    try {
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return { ok: false, error: 'invalid dataUrl' }
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const buf = Buffer.from(b64, 'base64')
      const out = join(tmpdir(), `shot-${Date.now()}.png`)
      await writeFile(out, buf)
      if (screenshotWin && !screenshotWin.isDestroyed()) screenshotWin.close()
      sendToMainWindow(getMainWindow(), IpcEvents.screenshotSaved, out)
      return { ok: true, path: out }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })

  // 截屏窗口按框选区域缩放定位：窗口 bounds=选框（框选时工具栏为独立窗口，无需留空间），冻结画面跟随选框
  ipcMain.handle(IpcChannels.screenshotResize, (_e, sel: unknown) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win || win.isDestroyed()) return { ok: false }
    const s = (sel ?? {}) as { x?: unknown; y?: unknown; w?: unknown; h?: unknown }
    const x = Number(s.x)
    const y = Number(s.y)
    const w = Number(s.w)
    const h = Number(s.h)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return { ok: false }
    const scale = screen.getPrimaryDisplay().scaleFactor || 1
    if (win.isFullScreen()) win.setFullScreen(false)
    win.setBounds({ x: Math.round(x / scale), y: Math.round(y / scale), width: Math.round(w / scale), height: Math.round(h / scale) })
    return { ok: true }
  })
}
