/**
 * Mochi OA - 品牌配置中心（main 进程集中管理）。
 * 配置项集中在 userData/brand.json，改一处全局生效（主窗口标题/图标、托盘、渲染标题）。
 * {
 *   "name": "麻薯OA",          // 软件显示名
 *   "iconPath": "brand.png"    // 自定义图标：绝对路径，或相对 userData 目录的文件名；留空用内置图标
 * }
 * 安装包结构不变：不改打包配置，仅运行时读取该配置文件。
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'

export interface Branding {
  name: string
  iconPath: string | null
}

const DEFAULTS: Branding = { name: '麻薯OA', iconPath: null }

let cached: Branding | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'brand.json')
}

/** 图标候选：iconPath 为绝对路径直接用；相对路径按相对 userData 解析；找不到返回 null */
export function brandingIconPath(): string | null {
  const b = readBranding()
  if (!b.iconPath) return null
  const candidates = isAbsolute(b.iconPath) ? [b.iconPath] : [join(app.getPath('userData'), b.iconPath), b.iconPath]
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  return null
}

/** 读取品牌配置（带内存缓存；配置缺失/损坏用默认值） */
export function readBranding(): Branding {
  if (cached) return cached
  cached = { ...DEFAULTS }
  try {
    const p = configPath()
    if (!existsSync(p)) return cached
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
    if (raw && typeof raw === 'object') {
      if (typeof raw['name'] === 'string' && String(raw['name']).trim()) {
        cached.name = String(raw['name']).trim().slice(0, 64)
      }
      if (typeof raw['iconPath'] === 'string' && String(raw['iconPath']).trim()) {
        cached.iconPath = String(raw['iconPath']).trim().slice(0, 1024)
      }
    }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

/** 写入品牌配置（保存后立即生效；后续启动/重开窗口应用） */
export function saveBranding(partial: Partial<Branding>): Branding {
  const next: Branding = {
    name: (partial.name && partial.name.trim()) ? partial.name.trim().slice(0, 64) : readBranding().name,
    iconPath: partial.iconPath !== undefined ? (partial.iconPath && partial.iconPath.trim() ? partial.iconPath.trim().slice(0, 1024) : null) : readBranding().iconPath
  }
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* 写入失败静默 */
  }
  cached = next
  return next
}

/** 强制重读（清缓存） */
export function refreshBranding(): Branding {
  cached = null
  return readBranding()
}
