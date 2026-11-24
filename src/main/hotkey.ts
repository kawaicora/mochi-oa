/**
 * 全局快捷键管理器（主进程）。
 * 基于 Electron globalShortcut；配置来自 hotkey-config，动作回调由主进程接线。
 * registerAll 会先解绑上一轮全部注册，再按当前配置重新登记；
 * 内部撞键跳过注册并回报，系统/其他应用占用同样回报，不抛错。
 */
import { globalShortcut } from 'electron'
import {
  detectInternalConflicts,
} from './hotkey-config'
import {
  normalizeAccelerator,
  type HotkeyAction,
  type HotkeyConfig,
  type HotkeyConflict
} from '../shared/hotkey'

type Dispatch = (action: HotkeyAction) => void

class HotkeyManager {
  /** 当前已注册的动作 → 组合键（便于排查/解绑） */
  private bound = new Map<HotkeyAction, string>()

  /** 解绑全部已注册快捷键。 */
  unbindAll(): void {
    globalShortcut.unregisterAll()
    this.bound.clear()
  }

  /**
   * 按配置全量重绑。
   * @returns 冲突/占用清单（内部撞键 + 系统占用）；空数组表示全部注册成功。
   */
  registerAll(cfg: HotkeyConfig, dispatch: Dispatch): { conflicts: HotkeyConflict[] } {
    this.unbindAll()
    const conflicts = detectInternalConflicts(cfg)
    const conflictActions = new Set(conflicts.map((c) => c.action))

    for (const action of Object.keys(cfg) as HotkeyAction[]) {
      const item = cfg[action]
      if (!item.enabled || !item.accelerator.trim()) continue
      // 内部撞键：跳过不注册，避免抢同一个组合键
      if (conflictActions.has(action)) continue

      const accelerator = item.accelerator.trim()
      const ok = globalShortcut.register(accelerator, () => dispatch(action))
      if (ok) {
        this.bound.set(action, accelerator)
      } else {
        conflicts.push({
          action,
          accelerator,
          reason: '快捷键已被系统或其他应用占用，请换一个组合键'
        })
        console.warn(`[hotkey] 注册失败（占用）：${action} → ${accelerator}`)
      }
    }
    return { conflicts }
  }

  /** 当前是否已注册指定动作。 */
  isRegistered(action: HotkeyAction): boolean {
    return this.bound.has(action)
  }

  /** 取某动作当前已登记的规范化组合键（排查用）。 */
  boundAccelerator(action: HotkeyAction): string | undefined {
    return this.bound.get(action)
  }

  /** 规范化比较辅助（导出供主进程/测试复用）。 */
  normalize(acc: string): string {
    return normalizeAccelerator(acc)
  }
}

export const hotkey = new HotkeyManager()
