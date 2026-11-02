
import { globalShortcut, BrowserWindow } from 'electron'

type HotkeyCallback = (event: {
  key: string
}) => void

class HotkeyManager {
  private bindings = new Map<string, HotkeyCallback>()

  /**
   * 注册全局快捷键
   */
  bindKey(key: string, ipc: HotkeyCallback): boolean {
    if (this.bindings.has(key)) {
      console.warn(`[Hotkey] Key already registered: ${key}`)
      return false
    }

    const success = globalShortcut.register(key, () => {
      ipc({ key })
    })

    if (!success) {
      console.error(`[Hotkey] Failed to register: ${key}`)
      return false
    }

    this.bindings.set(key, ipc)
    return true
  }

  /**
   * 解除快捷键
   */
  unbindKey(key: string): boolean {
    if (!this.bindings.has(key)) return false

    globalShortcut.unregister(key)
    this.bindings.delete(key)
    return true
  }

  /**
   * 解除所有快捷键
   */
  unbindAll(): void {
    globalShortcut.unregisterAll()
    this.bindings.clear()
  }
}

export const hotkey = new HotkeyManager()
