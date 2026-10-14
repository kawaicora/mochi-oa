import { BrowserWindow, Notification } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { flashTray } from './tray'
import { resourceFilePath } from './branding'
import { IpcEvents, type NotifKind, type NotifTarget } from '../shared/ipc'

/** 打开独立会议窗口（create/join，带 meetingNo/password 参数） */
export function openMeetingWindow(p: { mode: 'create' | 'join'; kind?: string; meetingNo?: string; password?: string }): void {
  const win = new BrowserWindow({
    width: 960,
    height: 646,
    minWidth: 800,
    minHeight: 560,
    resizable: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
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
}

let showMainWindow: (() => void) | null = null
let getMainWindow: (() => BrowserWindow | null) | null = null
export function initNotifManager(showMain: () => void, getWin: () => BrowserWindow | null): void {
  showMainWindow = showMain
  getMainWindow = getWin
}

/** 点击通知：按通知携带的目标打开对应窗口 */
export function openTarget(t: NotifTarget): void {
  if (t.kind === 'main') {
    showMainWindow?.()
    // 携带会话参数 → 通知渲染层定位到该会话
    if (t.conversationId) getMainWindow?.()?.webContents.send(IpcEvents.navigateToConversation, t.conversationId)
  } else if (t.kind === 'meeting') {
    openMeetingWindow({ mode: t.mode, kind: t.callType, meetingNo: t.meetingNo, password: t.password })
  }
}

/**
 * 通知管理器统一入口：托盘闪动 + 系统通知，点击 → 打开目标窗口。
 *
 * 按 NotifKind 区分处理（之前漏了类型：来电和普通消息长得一模一样）：
 *   - call / meeting（来电类）：紧急级别，不会几秒后悄悄沉进操作中心，托盘闪动更明显；
 *   - message / task：普通提示；
 *   - alarm：闹钟自己有铃声（utils/alarms.ts 里用户选的铃声），不走这里，避免重复响；
 *   - system：其他系统提示。
 * 提示音不在这里播：渲染层按类型播各自的音（renderer/src/utils/notify-manager.ts），
 * 主进程只负责「看得见的那部分」，所以系统通知始终 silent。
 */
export function notify(o: { kind?: NotifKind; title: string; body: string; target?: NotifTarget; tray?: boolean }): void {
  const kind: NotifKind = o.kind ?? 'system'
  if (kind === 'alarm') return // 闹钟自带播放，不重复
  if (o.tray !== false) flashTray()
  if (!Notification.isSupported()) return
  try {
    const urgent = kind === 'call' || kind === 'meeting'
    const n = new Notification({
      title: o.title,
      body: o.body,
      silent: true,
      urgency: urgent ? 'critical' : 'normal',
      timeoutType: urgent ? 'never' : 'default'
    })
    n.on('click', () => openTarget(o.target ?? { kind: 'main' }))
    n.show()
  } catch (e) {
    console.error('[notif] 系统通知显示失败', kind, o.title, e)
  }
}

/**
 * 解析实际要播放的提示音文件（渲染层来问，主进程负责查文件在不在）。
 *
 * 规则：自定义路径存在就用它；不存在/为空就回退默认（resources/message.wav 或 calling.wav）；
 * 默认也没有才返回失败。这样「设置的音频丢了自动恢复默认」是主进程判定的，
 * 渲染层不用自己去猜路径。
 */
export function resolveSoundFile(kind: NotifKind, customPath?: string): { ok: boolean; path?: string; source?: 'custom' | 'fallback' | 'default'; missing?: string; error?: string } {
  const isCall = kind === 'call' || kind === 'meeting'
  const defName = isCall ? 'calling.wav' : 'message.wav'
  const defPath = resourceFilePath(defName)
  const custom = typeof customPath === 'string' ? customPath.trim() : ''
  if (custom) {
    try {
      if (existsSync(custom)) return { ok: true, path: custom, source: 'custom' }
    } catch {
      /* 路径非法当丢失处理 */
    }
    // 自定义文件丢失 → 自动回退默认，并把丢失的路径回传，界面可提示用户
    if (defPath) return { ok: true, path: defPath, source: 'fallback', missing: custom }
    return { ok: false, error: `自定义音频丢失，且默认音频 ${defName} 不存在` }
  }
  if (defPath) return { ok: true, path: defPath, source: 'default' }
  return { ok: false, error: `默认音频 ${defName} 不存在` }
}
