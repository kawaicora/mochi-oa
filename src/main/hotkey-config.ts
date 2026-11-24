/**
 * 全局快捷键配置持久化（主进程）。
 * 落盘 userData/hotkey-config.json；文件缺失/损坏/字段缺失时回退默认值，不抛错。
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_HOTKEY_CONFIG,
  HOTKEY_ACTIONS,
  normalizeAccelerator,
  type HotkeyAction,
  type HotkeyConfig,
  type HotkeyConflict,
  type HotkeyItem
} from '../shared/hotkey'

function configPath(): string {
  return join(app.getPath('userData'), 'hotkey-config.json')
}

function normalizeItem(raw: unknown, fallback: HotkeyItem): HotkeyItem {
  const o = (raw ?? {}) as Partial<HotkeyItem>
  return {
    enabled: typeof o.enabled === 'boolean' ? o.enabled : fallback.enabled,
    accelerator: typeof o.accelerator === 'string' ? o.accelerator.trim() : fallback.accelerator
  }
}

/** 读取配置；合并默认值补齐新增动作/缺失字段。 */
export function loadHotkeyConfig(): HotkeyConfig {
  const fallback = DEFAULT_HOTKEY_CONFIG
  try {
    const file = configPath()
    if (!existsSync(file)) return structuredClone(fallback)
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<Record<HotkeyAction, unknown>>
    const out = {} as HotkeyConfig
    for (const a of HOTKEY_ACTIONS) {
      out[a] = normalizeItem(parsed[a], fallback[a])
    }
    return out
  } catch (err) {
    console.warn('[hotkey] 读取快捷键配置失败，使用默认：', err)
    return structuredClone(fallback)
  }
}

/** 合并 patch 后整体写回；写盘失败仅告警。返回最新配置。 */
export function saveHotkeyConfig(patch: Partial<Record<HotkeyAction, Partial<HotkeyItem>>>): HotkeyConfig {
  const current = loadHotkeyConfig()
  const next = structuredClone(current)
  for (const a of HOTKEY_ACTIONS) {
    const p = patch?.[a]
    if (!p) continue
    if (typeof p.enabled === 'boolean') next[a].enabled = p.enabled
    if (typeof p.accelerator === 'string') next[a].accelerator = p.accelerator.trim()
  }
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[hotkey] 写回快捷键配置失败：', err)
  }
  return next
}

/**
 * 配置内部撞键检测：两个及以上启用且组合键相同（规范化后）即冲突。
 * 不包含「被系统/其他应用占用」——那一项由 globalShortcut.register 结果判定。
 */
export function detectInternalConflicts(cfg: HotkeyConfig): HotkeyConflict[] {
  const byCombo = new Map<string, HotkeyAction[]>()
  for (const a of HOTKEY_ACTIONS) {
    const it = cfg[a]
    if (!it.enabled || !it.accelerator.trim()) continue
    const combo = normalizeAccelerator(it.accelerator)
    const list = byCombo.get(combo) ?? []
    list.push(a)
    byCombo.set(combo, list)
  }
  const conflicts: HotkeyConflict[] = []
  for (const [combo, actions] of byCombo) {
    if (actions.length < 2) continue
    for (const a of actions) {
      conflicts.push({
        action: a,
        accelerator: cfg[a].accelerator,
        reason: '与其他快捷键冲突',
        conflicts: actions.filter((x) => x !== a)
      })
    }
  }
  return conflicts
}
