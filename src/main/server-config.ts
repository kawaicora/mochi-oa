/**
 * Mochi OA - 服务器地址/端口配置持久化。
 * 落盘 userData/server-config.json。登录/连接成功后回写 serverUrl 与 token。
 */
import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileTransferMode, ServerSettings } from '../shared/server-types'

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000'

function configPath(): string {
  return join(app.getPath('userData'), 'server-config.json')
}

/** 默认下载目录：Documents/麻薯 */
function defaultDownloadDir(): string {
  try {
    return join(app.getPath('documents'), '麻薯')
  } catch {
    return join(app.getPath('home'), '麻薯')
  }
}

function defaultConfig(): ServerSettings {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    token: '',
    fileTransferMode: 'local',
    downloadDir: defaultDownloadDir(),
    autoDownload: true,
    audioSampleRate: 48000,
    audioChannels: 2
  }
}

function normalizeMode(value: unknown): FileTransferMode {
  return value === 'server' ? 'server' : 'local'
}

/** 读取持久化配置；文件缺失/损坏回退默认值（不抛错）。 */
export function loadServerConfig(): ServerSettings {
  const fallback = defaultConfig()
  try {
    const file = configPath()
    if (!existsSync(file)) return fallback
    const raw = readFileSync(file, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<Record<keyof ServerSettings, unknown>>
    return {
      serverUrl:
        typeof parsed.serverUrl === 'string' && parsed.serverUrl.trim()
          ? parsed.serverUrl.trim()
          : DEFAULT_SERVER_URL,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      fileTransferMode: normalizeMode(parsed.fileTransferMode),
      downloadDir: typeof parsed.downloadDir === 'string' && parsed.downloadDir.trim() ? parsed.downloadDir.trim() : fallback.downloadDir,
      autoDownload: typeof parsed.autoDownload === 'boolean' ? parsed.autoDownload : true,
      audioSampleRate: typeof parsed.audioSampleRate === 'number' && parsed.audioSampleRate > 0 ? parsed.audioSampleRate : 48000,
      audioChannels: parsed.audioChannels === 1 || parsed.audioChannels === 2 ? parsed.audioChannels : 2
    }
  } catch (err) {
    console.warn('[mochi-oa] 读取服务器配置失败，使用默认：', err)
    return fallback
  }
}

/** 合并 patch 后整体写回；返回最新配置。写盘失败仅告警。 */
export function saveServerConfig(patch: Partial<ServerSettings>): ServerSettings {
  const current = loadServerConfig()
  const next: ServerSettings = {
    serverUrl:
      typeof patch.serverUrl === 'string' && patch.serverUrl.trim()
        ? patch.serverUrl.trim()
        : current.serverUrl,
    token: typeof patch.token === 'string' ? patch.token : current.token,
    fileTransferMode:
      patch.fileTransferMode === 'local' || patch.fileTransferMode === 'server'
        ? patch.fileTransferMode
        : current.fileTransferMode,
    downloadDir:
      typeof patch.downloadDir === 'string' && patch.downloadDir.trim()
        ? patch.downloadDir.trim()
        : current.downloadDir,
    autoDownload:
      typeof patch.autoDownload === 'boolean' ? patch.autoDownload : current.autoDownload,
    audioSampleRate:
      typeof patch.audioSampleRate === 'number' && patch.audioSampleRate > 0
        ? patch.audioSampleRate
        : current.audioSampleRate,
    audioChannels:
      patch.audioChannels === 1 || patch.audioChannels === 2
        ? patch.audioChannels
        : current.audioChannels
  }
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[mochi-oa] 写回服务器配置失败：', err)
  }
  return next
}
