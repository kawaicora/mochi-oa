/**
 * Mochi OA - 品牌配置中心（随安装包打包，运行时只读）。
 * 配置文件固定在 resources/brand.json，electron-builder 的 extraResources 会把整个
 * resources 目录打进安装包（落位 process.resourcesPath/resources/），因此品牌配置随包分发：
 *   {
 *     "name": "麻薯OA",                  // 软件显示名（窗口标题/托盘/渲染标题）
 *     "iconPath": "brand.png",           // 自定义图标：resources 目录下的文件名；留空用内置图标
 *     "defaultServerUrl": ""             // 默认服务器地址；UI 可改，未改时默认用它
 *   }
 * 要换品牌：改 resources/brand.json（及放入图标）→ 重新打包 → 安装包内的名称/图标/默认地址随之变化。
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Branding {
  name: string
  iconPath: string | null
  defaultServerUrl: string | null
}

const DEFAULTS: Branding = { name: '麻薯OA', iconPath: null, defaultServerUrl: null }

let cached: Branding | null = null

/** 品牌资源目录：打包后 = process.resourcesPath/resources；开发 = 项目根 resources/ */
function resourcesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'resources')
  return join(app.getAppPath(), 'resources')
}

function configPath(): string {
  return join(resourcesDir(), 'brand.json')
}

/** 自定义图标：brand.json 中 iconPath 为 resources 目录下文件名；找不到返回 null */
export function brandingIconPath(): string | null {
  const b = readBranding()
  if (!b.iconPath) return null
  const p = join(resourcesDir(), b.iconPath)
  try {
    if (existsSync(p)) return p
  } catch {
    /* ignore */
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
      if (typeof raw['defaultServerUrl'] === 'string' && String(raw['defaultServerUrl']).trim()) {
        cached.defaultServerUrl = String(raw['defaultServerUrl']).trim().slice(0, 512)
      }
    }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}
