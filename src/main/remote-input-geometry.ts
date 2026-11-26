/**
 * 远程输入：显示器几何与坐标换算纯逻辑（不碰 Electron / 子进程，便于单测）。
 *
 * 坐标模型：每块屏使用「本地坐标」（屏自身左上为 0,0），注入时再叠加该屏在
 * 虚拟桌面内的偏移。各平台注入 API 的坐标口径不同：
 *  - Windows：物理像素。本地物理像素 + 物理屏偏移（DIP 偏移 × scaleFactor）。
 *  - macOS：CGPoint 为全局点坐标，叠加 bounds 点偏移，Retina 不乘系数。
 *  - Linux：uinput 虚拟设备不区分屏幕，保持本地坐标。
 */

export interface RemoteDisplayInfo {
  id: string
  label: string
  /** 虚拟桌面内 DIP 偏移（左上原点，多屏时可为负） */
  x: number
  y: number
  /** DIP 逻辑尺寸 */
  w: number
  h: number
  /** DPI 缩放系数（Windows 物理像素 = DIP × 系数；macOS CGPoint 仍用点，不乘） */
  scaleFactor: number
  primary: boolean
}

export type InputPlatform = 'win32' | 'linux' | 'darwin'

/** 注入侧使用的屏幕尺寸口径：Windows 取物理像素，其余平台取逻辑点。 */
export function displayPhysicalSize(d: RemoteDisplayInfo, platform: InputPlatform): { w: number; h: number } {
  if (platform === 'win32') {
    const sf = d.scaleFactor || 1
    return { w: Math.round(d.w * sf), h: Math.round(d.h * sf) }
  }
  return { w: d.w, h: d.h }
}

/** 把「活动屏本地物理坐标」换算成注入 API 使用的全局物理坐标。 */
export function transformPoint(
  d: RemoteDisplayInfo,
  x: number,
  y: number,
  platform: InputPlatform
): { x: number; y: number } {
  if (platform === 'win32') {
    const sf = d.scaleFactor || 1
    // 入参 x/y 已是本地物理像素；只叠加物理屏偏移（DIP 偏移 × 系数），不再二次缩放。
    return { x: Math.round(d.x * sf + x), y: Math.round(d.y * sf + y) }
  }
  if (platform === 'darwin') {
    return { x: Math.round(d.x + x), y: Math.round(d.y + y) }
  }
  return { x, y }
}
