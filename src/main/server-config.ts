/**
 * Mochi OA - 服务器地址/端口配置持久化。
 * 落盘 userData/server-config.json。登录/连接成功后回写 serverUrl 与 token。
 */
import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FileTransferMode, ServerSettings } from '../shared/server-types'
import { readBranding } from './branding'

const FALLBACK_SERVER_URL = 'http://127.0.0.1:3000'

/** 默认服务器地址：优先 brand.json 的 defaultServerUrl，否则内置兜底 */
function defaultServerUrl(): string {
  const fromBrand = readBranding().defaultServerUrl
  return fromBrand || FALLBACK_SERVER_URL
}

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
    serverUrl: defaultServerUrl(),
    token: '',
    fileTransferMode: 'local',
    downloadDir: defaultDownloadDir(),
    autoDownload: true,
    audioSampleRate: 48000,
    audioChannels: 2,
    notifySound: true,
    callSound: true,
    messageSoundFile: '',
    callSoundFile: '',
    dnd: false,
    dndConvs: [],
    convRings: {},
    rememberPassword: false,
    savedAccount: '',
    savedPassword: '',
    passwordEnc: false
  }
}

/**
 * 「记住密码」的落盘加密。
 * safeStorage 在 Windows 走 DPAPI、macOS 走钥匙串、Linux 走 libsecret/kwallet；
 * 系统不支持时（如没装密钥环的 Linux）退化为明文，并把 passwordEnc 置 false，
 * 读取时按该标志决定要不要解密 —— 自己加密自己解，跨机器读不了是预期行为。
 */
function encryptPassword(pw: string): { savedPassword: string; passwordEnc: boolean } {
  if (!pw) return { savedPassword: '', passwordEnc: false }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { savedPassword: safeStorage.encryptString(pw).toString('base64'), passwordEnc: true }
    }
  } catch (err) {
    console.warn('[mochi-oa] 密码加密失败，回退明文保存：', err)
  }
  return { savedPassword: pw, passwordEnc: false }
}

function decryptPassword(stored: string, enc: boolean): string {
  if (!stored) return ''
  if (!enc) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch (err) {
    // 换机器/换用户后 DPAPI 解不开：当没记住处理，别让登录页崩掉
    console.warn('[mochi-oa] 记住的密码解密失败（可能换了机器/用户），已忽略：', err)
    return ''
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
          : defaultServerUrl(),
      token: typeof parsed.token === 'string' ? parsed.token : '',
      fileTransferMode: normalizeMode(parsed.fileTransferMode),
      downloadDir: typeof parsed.downloadDir === 'string' && parsed.downloadDir.trim() ? parsed.downloadDir.trim() : fallback.downloadDir,
      autoDownload: typeof parsed.autoDownload === 'boolean' ? parsed.autoDownload : true,
      audioSampleRate: typeof parsed.audioSampleRate === 'number' && parsed.audioSampleRate > 0 ? parsed.audioSampleRate : 48000,
      audioChannels: parsed.audioChannels === 1 || parsed.audioChannels === 2 ? parsed.audioChannels : 2,
      notifySound: typeof parsed.notifySound === 'boolean' ? parsed.notifySound : true,
      callSound: typeof parsed.callSound === 'boolean' ? parsed.callSound : true,
      messageSoundFile: typeof parsed.messageSoundFile === 'string' ? parsed.messageSoundFile : '',
      callSoundFile: typeof parsed.callSoundFile === 'string' ? parsed.callSoundFile : '',
      dnd: typeof parsed.dnd === 'boolean' ? parsed.dnd : false,
      dndConvs: Array.isArray(parsed.dndConvs)
        ? parsed.dndConvs.filter((x): x is string => typeof x === 'string')
        : [],
      convRings:
        parsed.convRings && typeof parsed.convRings === 'object' && !Array.isArray(parsed.convRings)
          ? Object.fromEntries(
              Object.entries(parsed.convRings as Record<string, unknown>).filter(
                (e): e is [string, string] => typeof e[1] === 'string'
              )
            )
          : {},
      rememberPassword: parsed.rememberPassword === true,
      savedAccount: typeof parsed.savedAccount === 'string' ? parsed.savedAccount : '',
      savedPassword: decryptPassword(
        typeof parsed.savedPassword === 'string' ? parsed.savedPassword : '',
        parsed.passwordEnc === true
      ),
      passwordEnc: parsed.passwordEnc === true
    }
  } catch (err) {
    console.warn('[mochi-oa] 读取服务器配置失败，使用默认：', err)
    return fallback
  }
}

/** 合并 patch 后整体写回；返回最新配置。写盘失败仅告警。 */
export function saveServerConfig(patch: Partial<ServerSettings>): ServerSettings {
  const current = loadServerConfig()
  // 「记住密码」：渲染层给的是明文，落盘前统一加密一次（传空串=立即清除，这里会得到空密文）
  const pw = typeof patch.savedPassword === 'string' ? encryptPassword(patch.savedPassword) : null
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
        : current.audioChannels,
    notifySound:
      typeof patch.notifySound === 'boolean' ? patch.notifySound : current.notifySound,
    callSound: typeof patch.callSound === 'boolean' ? patch.callSound : current.callSound,
    messageSoundFile:
      typeof patch.messageSoundFile === 'string' ? patch.messageSoundFile : current.messageSoundFile,
    callSoundFile:
      typeof patch.callSoundFile === 'string' ? patch.callSoundFile : current.callSoundFile,
    dnd: typeof patch.dnd === 'boolean' ? patch.dnd : current.dnd,
    dndConvs: Array.isArray(patch.dndConvs)
      ? patch.dndConvs.filter((x): x is string => typeof x === 'string')
      : current.dndConvs,
    convRings:
      patch.convRings && typeof patch.convRings === 'object' && !Array.isArray(patch.convRings)
        ? Object.fromEntries(
            Object.entries(patch.convRings as Record<string, unknown>).filter(
              (e): e is [string, string] => typeof e[1] === 'string'
            )
          )
        : current.convRings,
    rememberPassword:
      typeof patch.rememberPassword === 'boolean' ? patch.rememberPassword : current.rememberPassword,
    // 渲染层传的是明文（读配置时已解密），落盘前重新加密；
    // 取消勾选时渲染层会同时传空串 → 这里立刻清掉，不是等下次登录才清
    savedAccount:
      typeof patch.savedAccount === 'string' ? patch.savedAccount : current.savedAccount,
    savedPassword: pw ? pw.savedPassword : current.savedPassword,
    passwordEnc: pw ? pw.passwordEnc : current.passwordEnc
  }
  try {
    writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[mochi-oa] 写回服务器配置失败：', err)
  }
  return next
}
