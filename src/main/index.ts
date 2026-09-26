import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, screen, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { registerServerIpcHandlers } from './server-ipc'
import { IpcChannels, type NotifTarget } from '../shared/ipc'
import { serverClient } from './net/server-client'
import { loadServerConfig } from './server-config'
import { setupTray, destroyTray, stopFlashTray } from './tray'
import { notify as notifyManager, initNotifManager } from './notif'

/** 应用图标：优先打包目录(resourcesPath)，其次开发目录(项目根 resources/)。任务栏/窗口用。 */
function resolveAppIcon(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'resources', 'icon_256.png'), // 打包后 extraResources 落位
    join(process.resourcesPath, 'icon_256.png'),
    join(app.getAppPath(), 'resources', 'icon_256.png'), // 开发模式
    join(app.getAppPath(), 'resources', 'icon_64.png')
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return undefined
}

// 本地文件协议：渲染层可通过 app-file:///绝对路径 加载磁盘文件（规避 file:// 被渲染进程拒绝）
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

let mainWindow: BrowserWindow | null = null
let trayEnabled = false
let isQuitting = false

// 单实例锁：避免重复启动（用户数据隔离靠 PANTRY_USER_DATA 环境变量）
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

function showMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  stopFlashTray()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    // 登录窗口：固定 480x638，不可缩放、可拖动、圆角
    width: 480,
    height: 638,
    resizable: false,
    maximizable: false,
    show: false,
    autoHideMenuBar: true,
    frame: false,
    roundedCorners: true,
    backgroundColor: '#ffffff',
    icon: resolveAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  // 窗口聚焦 → 停止托盘闪动
  mainWindow.on('focus', () => stopFlashTray())
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 关窗：有托盘则最小化到托盘，否则退出
  mainWindow.on('close', (e) => {
    if (!isQuitting && trayEnabled) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** 登录成功 → 切换为主窗口模式：可缩放、恢复大尺寸、居中 */
function switchToMainMode(): void {
  if (!mainWindow) return
  mainWindow.setResizable(true)
  mainWindow.setMaximizable(true)
  mainWindow.setMinimumSize(900, 620)
  mainWindow.setSize(1180, 760)
  mainWindow.center()
}

app.whenReady().then(() => {
  // WebRTC 屏幕共享：让渲染层 navigator.mediaDevices.getDisplayMedia 走系统桌面源采集
  // （Electron 渲染进程默认不接 desktopCapturer，直接调用会抛错）
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 0, height: 0 }
        })
        const primaryId = String(screen.getPrimaryDisplay().id)
        const match =
          sources.find((s) => s.display_id === primaryId && s.name.toLowerCase().includes('screen')) ||
          sources.find((s) => s.display_id === primaryId) ||
          sources[0]
        if (match) callback({ video: match })
        else callback({})
      } catch {
        callback({})
      }
    }
    // 注：不使用 useSystemPicker（跨版本兼容），默认共享主屏画面
  )

  // app-file:///C:/Users/... → 磁盘文件（解码 pathname 后去掉盘符前导 /；兼容旧版 Electron 用 registerFileProtocol）
  protocol.registerFileProtocol('app-file', (request, callback) => {
    try {
      console.log('[app-file] request.url =', request.url)
      const u = new URL(request.url)
      let p = u.pathname
      if (p.startsWith('/')) p = p.slice(1)
      const path = decodeURIComponent(p)
      console.log('[app-file] path =', path, 'exists =', require('node:fs').existsSync(path))
      callback({ path })
    } catch (e) {
      console.error('[app-file] error =', e)
      callback({ error: -2 })
    }
  })

  // 通知管理器：所有通知进这里，托盘闪动 + Windows 通知；点击 → 按目标打开对应窗口
  ipcMain.handle(IpcChannels.notify, (_e, opts: { title: string; body: string; target?: NotifTarget; tray?: boolean }) => {
    const fromWin = BrowserWindow.fromWebContents(_e.sender)
    if (fromWin && !fromWin.isDestroyed() && fromWin.isFocused()) return
    notifyManager({ title: opts.title ?? '', body: opts.body ?? '', target: opts.target ?? { kind: 'main' }, tray: opts.tray ?? true })
    return { ok: true }
  })
  ipcMain.handle(IpcChannels.getWindowState, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    return {
      focused: w ? w.isFocused() : false,
      visible: w ? w.isVisible() : false,
      minimized: w ? w.isMinimized() : false
    }
  })
  ipcMain.handle(IpcChannels.focusWindow, (e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
    }
    return { ok: true }
  })

  registerServerIpcHandlers(getMainWindow)
  createWindow()
  initNotifManager(showMainWindow, getMainWindow)

  // 托盘常驻
  trayEnabled = setupTray({
    showWindow: showMainWindow,
    quit: () => {
      isQuitting = true
      app.quit()
    }
  })

  // 启动即连接已保存的服务器地址（带 token 则自动恢复会话）
  const cfg = loadServerConfig()
  if (cfg.serverUrl) {
    serverClient.connect({ serverUrl: cfg.serverUrl, token: cfg.token })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      showMainWindow()
    }
  })
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  // 有托盘时关窗已隐藏，不触发；若托盘不可用则直接退出
  if (!trayEnabled) app.quit()
})

app.on('will-quit', () => {
  destroyTray()
})
