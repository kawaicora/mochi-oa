/**
 * 渲染进程权限处理器（摄像头 / 麦克风 / 通知等）。
 *
 * Electron 若不显式注册权限处理器，非 Windows 端 getUserMedia 等媒体请求
 * 可能被默认拦截，请求到不了系统授权弹窗。这里明确放行通话所需的媒体类权限，
 * 其余一律拒绝并记日志。
 *
 * 说明：摄像头 / 麦克风采集在三平台都不需要 root / 管理员提权，通话链路不做提权；
 * 本处理器只决定「Electron 是否把媒体请求交给系统」，不改动 Windows 既有行为。
 */
import { session } from 'electron'

/** 放行的权限清单（Electron permission 字符串） */
const GRANTED = new Set<string>([
  'media', // getUserMedia：摄像头 + 麦克风
  'audioCapture',
  'videoCapture',
  'notifications',
  'fullscreen',
  'clipboard-read',
  'clipboard-sanitized-write'
])

function allow(permission: string): boolean {
  return GRANTED.has(permission)
}

export function registerPermissionHandlers(): void {
  // Windows 既有行为保持不变：不覆盖默认放行；处理器只在 macOS / Linux 落地媒体权限放行。
  if (process.platform === 'win32') return
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const ok = allow(permission)
    console.log(`[permission] request "${permission}" → ${ok ? 'allow' : 'deny'}`)
    callback(ok)
  })
  ses.setPermissionCheckHandler((_wc, permission) => {
    const ok = allow(permission)
    console.log(`[permission] check "${permission}" → ${ok ? 'allow' : 'deny'}`)
    return ok
  })
}
