/**
 * Mochi OA - 系统托盘常驻。
 * 关窗最小化到托盘而非退出；单击唤起主窗；菜单提供「打开 Mochi OA」与「退出」。
 */
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readBranding, brandingIconPath } from './branding'

export interface TrayDeps {
  showWindow: () => void
  quit: () => void
}

let tray: Tray | null = null
let normalTrayIcon: ReturnType<typeof nativeImage.createFromPath> | ReturnType<typeof nativeImage.createFromBuffer> | null = null
let flashTimer: NodeJS.Timeout | null = null

/**
 * 托盘图标：优先用 resources 内新增的应用图标（icon_256/icon_64），
 * 兼容打包(process.resourcesPath)与开发(app.getAppPath())两种路径；
 * 全部缺失则退化为纯色 16x16 占位。
 */
function createTrayIcon(): ReturnType<typeof nativeImage.createFromPath> | ReturnType<typeof nativeImage.createFromBuffer> {
  // 优先品牌自定义图标（userData/brand.json iconPath）
  const brandIcon = brandingIconPath()
  if (brandIcon) {
    try {
      const img = nativeImage.createFromPath(brandIcon)
      if (!img.isEmpty()) return img
    } catch {
      /* 用内置 */
    }
  }
  const candidates = [
    join(process.resourcesPath, 'resources', 'icon_256.png'),
    join(process.resourcesPath, 'icon_256.png'),
    join(app.getAppPath(), 'resources', 'icon_256.png'),
    join(process.resourcesPath, 'resources', 'tray.png'),
    join(app.getAppPath(), 'resources', 'tray.png')
  ]
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    } catch {
      /* 尝试下一个 */
    }
  }
  // 16x16 蓝色占位
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0x16
    buf[i * 4 + 1] = 0x77
    buf[i * 4 + 2] = 0xff
    buf[i * 4 + 3] = 0xff
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/** 初始化托盘；桌面环境不支持时返回 false，调用方据此降级关窗行为。 */
export function setupTray(deps: TrayDeps): boolean {
  try {
    const brandName = readBranding().name
    tray = new Tray(createTrayIcon())
    tray.setToolTip(brandName)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `打开 ${brandName}`, click: deps.showWindow },
        { type: 'separator' },
        { label: '退出', click: deps.quit }
      ])
    )
    tray.on('click', deps.showWindow)
    return true
  } catch (err) {
    console.warn('[mochi-oa] 托盘不可用，关窗将直接退出：', err)
    return false
  }
}

/** 16x16 高亮（红色）图标：与普通图标交替实现托盘闪动提醒 */
function makeAlertIcon(): ReturnType<typeof nativeImage.createFromBuffer> {
  const size = 16
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = 0xff
    buf[i * 4 + 1] = 0x53
    buf[i * 4 + 2] = 0x4d
    buf[i * 4 + 3] = 0xff
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

/** 托盘图标闪动（收到新消息时）；窗口聚焦 / 唤起后停止 */
export function flashTray(): void {
  if (!tray) return
  normalTrayIcon = createTrayIcon()
  const alert = makeAlertIcon()
  stopFlashTray()
  let on = false
  flashTimer = setInterval(() => {
    if (!tray) return
    on = !on
    tray.setImage(on ? alert : normalTrayIcon!)
  }, 400)
}

export function stopFlashTray(): void {
  if (flashTimer) {
    clearInterval(flashTimer)
    flashTimer = null
  }
  if (tray && normalTrayIcon) tray.setImage(normalTrayIcon)
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
