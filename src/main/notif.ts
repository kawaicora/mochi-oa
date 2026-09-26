import { BrowserWindow, Notification } from 'electron'
import { join } from 'node:path'
import { flashTray } from './tray'
import type { NotifTarget } from '../shared/ipc'

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
export function initNotifManager(showMain: () => void): void {
  showMainWindow = showMain
}

/** 点击通知：按通知携带的目标打开对应窗口 */
export function openTarget(t: NotifTarget): void {
  if (t.kind === 'main') showMainWindow?.()
  else if (t.kind === 'meeting') {
    openMeetingWindow({ mode: t.mode, kind: t.callType, meetingNo: t.meetingNo, password: t.password })
  }
}

/** 通知管理器统一入口：托盘闪动 + 系统通知，点击 → 打开目标窗口 */
export function notify(o: { title: string; body: string; target: NotifTarget; tray?: boolean }): void {
  if (o.tray) flashTray()
  const n = new Notification({ title: o.title, body: o.body, silent: true })
  n.on('click', () => openTarget(o.target))
}
