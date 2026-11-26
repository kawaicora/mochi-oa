/**
 * 全局快捷键配置（跨主/渲染进程共享类型）。
 * 落盘 userData/hotkey-config.json，首次启动缺失时生成默认值。
 */

/** 快捷键动作：
 *  - remoteRelease：释放卡住的鼠标/按键（补发抬起事件，防止粘连）。
 *    不锁定/冻结鼠标边界，不改动光标可见性，也不存在「锁定被控端鼠标」这一行为。
 *  - screenshot  ：主窗口触发「截图并进入截图编辑器」（截图发送链路）
 */
export type HotkeyAction = 'remoteRelease' | 'screenshot'

export interface HotkeyItem {
  /** 是否启用；关闭后即使填了组合键也不注册 */
  enabled: boolean
  /** Electron accelerator，如 Ctrl+Enter；空串表示未设置 */
  accelerator: string
}

export type HotkeyConfig = Record<HotkeyAction, HotkeyItem>

/** 冲突/占用提示：conflicts 为同配置内与谁撞键；reason 为人话原因 */
export interface HotkeyConflict {
  action: HotkeyAction
  accelerator: string
  reason: string
  conflicts?: HotkeyAction[]
}

export const HOTKEY_ACTIONS: HotkeyAction[] = ['remoteRelease', 'screenshot']

/** 默认快捷键：释放卡住的输入 = Ctrl+Enter；截图发送默认不启用 */
export const DEFAULT_HOTKEY_CONFIG: HotkeyConfig = {
  remoteRelease: { enabled: true, accelerator: 'Ctrl+Enter' },
  screenshot: { enabled: false, accelerator: '' }
}

/** 规范化组合键比较口径：去空白、统一大小写分隔，避免 Ctrl+Enter / ctrl+enter 被当成两个 */
export function normalizeAccelerator(acc: string): string {
  return acc
    .split('+')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .join('+')
}
