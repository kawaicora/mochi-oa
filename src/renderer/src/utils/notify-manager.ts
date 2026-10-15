/**
 * 渲染层「通知管理器」：消息/来电类事件到达时，统一决定
 *   ① 要不要弹系统通知   ② 要不要播提示音   ③ 播哪个音
 *
 * 之前这块逻辑散在各处（app.ts 的 notifyIfUnfocused、rtc.ts 的 maybeNotify、
 * TaskView/RtcCallRoom 各写一份），而且**没有区分通知类型**——来电和普通消息待遇一样。
 * 现在统一收拢到这里，按 NotifKind 分类型处理：
 *
 *   │ 类型      │ 免打扰是否静音 │ 提示音                     │ 何时打扰                    │
 *   │ message   │ 是（全局/会话）│ message.wav（可自定义）      │ 非「正在看这个会话」时      │
 *   │ task      │ 是（全局）      │ message.wav                │ 同上                        │
 *   │ call      │ 否（来电优先）  │ calling.mp3（可自定义）      │ 非「正在看这个会话」时      │
 *   │ meeting   │ 否（来电优先）  │ calling.mp3（可自定义）      │ 同上                        │
 *   │ alarm     │ —              │ 闹钟自带播放，不走这里        │ —                           │
 *
 * 音频文件丢失自动回退默认：由主进程 resolveNotifySound 判定（自定义不存在 →
 * resources/message.wav 或 calling.mp3），渲染层不用猜路径。
 * 播放失败（文件损坏/被删/格式不支持）会清缓存重解析一次，再失败就静默放弃——
 * 绝不能因为提示音出问题影响消息收发本身。
 */
import type { NotifKind, NotifTarget } from '@shared/ipc'

/** 通知策略（来自本地设置 userData/server-config.json） */
export interface NotifyPolicy {
  /** 消息提示音开关 */
  sound: boolean
  /** 来电/会议铃声开关 */
  callSound: boolean
  /** 全局免打扰（只静音消息类；来电照响） */
  dnd: boolean
  /** 单独免打扰的会话 key */
  dndConvs: string[]
  /** 自定义消息提示音（绝对路径，空=用 resources/message.wav） */
  messageSoundFile: string
  /** 自定义来电铃声（绝对路径，空=用 resources/calling.mp3） */
  callSoundFile: string
  /** 每个会话的自定义铃声：key=会话 key，value=绝对路径 */
  convRings: Record<string, string>
}

/** 会话 key：群/私聊统一成 group:<conversationId> / dm:<conversationId>，本地设置用它当键 */
export function convKey(type: string, conversationId: number): string {
  return `${type === 'dm' ? 'dm' : 'group'}:${conversationId}`
}

/**
 * 当前策略（由 app store 在启动/保存设置时同步进来）。
 * 放在模块内而不是每次调用传参：rtc / task / 聊天各处都能直接调 notifyEvent，
 * 不必各自去 import app store，避免 store 之间循环依赖。
 */
let policy: NotifyPolicy = {
  sound: true,
  callSound: true,
  dnd: false,
  dndConvs: [],
  messageSoundFile: '',
  callSoundFile: '',
  convRings: {}
}

/** 同步设置（app store 载入/保存通知设置后调用） */
export function setNotifyPolicy(p: NotifyPolicy): void {
  policy = { ...p }
}

/** 读当前策略（设置面板展示用） */
export function getNotifyPolicy(): NotifyPolicy {
  return policy
}

/** 通知上下文 */
export interface NotifyContext {
  kind: NotifKind
  title: string
  body: string
  /** 该事件所属会话（有会话的通知才有免打扰/自定义铃声的概念） */
  convKey?: string
  /** 该会话是否正是当前打开着的会话（窗口聚焦时这类事件完全不打扰） */
  inCurrentConv?: boolean
  /** 高风险事件（远程控制请求等）：无论聚焦与否都发系统通知 */
  force?: boolean
  target?: NotifTarget
}

// ─── 音频播放 ───

interface LoadedSound {
  path: string
  audio: HTMLAudioElement
  url: string | null
  /** 该音频是否来自 readAudioFile 的 blob（需要 revoke） */
  blob: boolean
}

const loaded = new Map<string, LoadedSound>()
/** 解析结果缓存：key = `${kind}|${customPath}` */
const resolved = new Map<string, string | null>()
/** 已经提示过「自定义铃声丢失」的文件路径，避免每次响铃都弹一次 */
const warnedMissing = new Set<string>()

function toAppFileUrl(p: string): string {
  // 整条路径编码进 URL：避免 Windows 盘符 `C:` 被 Chromium 当 host（app-file://c/...）丢掉路径
  return `app-file:///${encodeURIComponent(p)}`
}

/** 解析该类型该自定义路径最终要播的文件；失败返回 null */
async function resolvePath(kind: NotifKind, customPath: string): Promise<string | null> {
  const key = `${kind}|${customPath}`
  if (resolved.has(key)) return resolved.get(key) ?? null
  try {
    const r = await window.pantry.resolveNotifySound({ kind, customPath: customPath || undefined })
    if (!r.ok || !r.path) {
      console.warn('[notify] 提示音不可用：' + (r.error || '未知原因'))
      resolved.set(key, null)
      return null
    }
    if (r.source === 'fallback' && r.missing && !warnedMissing.has(r.missing)) {
      warnedMissing.add(r.missing)
      console.warn(`[notify] 自定义音频丢失，已回退默认：${r.missing}`)
    }
    resolved.set(key, r.path)
    return r.path
  } catch (e) {
    console.warn('[notify] 解析提示音失败', e)
    resolved.set(key, null)
    return null
  }
}

/** 兜底 blob 播放时按扩展名给 MIME，否则 Chromium 可能按 wav 解 mp3 导致无声 */
function mimeFor(path: string): string {
  const ext = (path.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/ogg',
    weba: 'audio/webm',
    wma: 'audio/x-ms-wma'
  }
  return map[ext] || 'audio/mpeg'
}

/** 加载音频元素（优先 app-file 流式播放；失败再退回读字节 + blob） */
async function loadSound(kind: NotifKind, customPath: string): Promise<LoadedSound | null> {
  const path = await resolvePath(kind, customPath)
  if (!path) return null
  const hit = loaded.get(path)
  if (hit) return hit

  // 首选：直接用 app-file:// 交给 Chromium 流式播放（大文件关键：铃声可能有几十上百 MB，
  // 读成 ArrayBuffer 再转 blob 会一次吃掉等量内存）
  const streamUrl = toAppFileUrl(path)
  const el = new Audio()
  el.preload = 'auto'
  el.src = streamUrl
  const ok = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (v: boolean): void => {
      if (done) return
      done = true
      resolve(v)
    }
    el.addEventListener('canplaythrough', () => finish(true), { once: true })
    el.addEventListener('loadeddata', () => finish(true), { once: true })
    el.addEventListener('error', () => finish(false), { once: true })
    el.load()
    setTimeout(() => finish(true), 1500) // 加载慢也别卡住，先认为可用（真正 play 时会再报错）
  })
  if (ok) {
    const s: LoadedSound = { path, audio: el, url: null, blob: false }
    loaded.set(path, s)
    return s
  }

  // 兜底：app-file 协议读不了（历史上有音频支持不稳的情况）→ 走主进程读字节 + blob
  try {
    const r = await window.pantry.readAudioFile(path)
    if (!r.ok || !r.data) return null
    const url = URL.createObjectURL(new Blob([r.data], { type: mimeFor(path) }))
    const a = new Audio(url)
    const s: LoadedSound = { path, audio: a, url, blob: true }
    loaded.set(path, s)
    return s
  } catch (e) {
    console.warn('[notify] 提示音兜底加载失败', e)
    return null
  }
}

/** 播放一次（失败会清缓存并重解析一次，仍失败就放弃） */
async function playOnce(kind: NotifKind, customPath: string, ringGen?: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await loadSound(kind, customPath)
    if (!s) return
    // 加载音频是异步的：等文件加载完可能已经接听/拒接了，这时绝不能再响（否则"挂了还在响"）
    if (ringGen != null && ringGen !== ringGeneration) return
    try {
      s.audio.currentTime = 0
      await s.audio.play()
      if (kind === 'call') {
        if (ringGen != null && ringGen !== ringGeneration) {
          try { s.audio.pause() } catch { /* ignore */ }
          return
        }
        ringAudioEl = s.audio
      }
      return
    } catch (e) {
      // 第一遍失败：可能文件被删/损坏 → 清掉缓存与解析结果，重来一次（会拿到默认音）
      const stale = loaded.get(s.path)
      if (stale) {
        if (stale.blob && stale.url) URL.revokeObjectURL(stale.url)
        loaded.delete(s.path)
      }
      resolved.delete(`${kind}|${customPath}`)
      if (attempt === 1) console.warn('[notify] 提示音播放失败', kind, e)
    }
  }
}

// ─── 来电铃声（循环，直到接听/拒绝/超时） ───

let ringTimer: ReturnType<typeof setInterval> | null = null
let ringing = false
/** 正在播放的铃声元素：stopRing 必须把它停掉，光停定时器声音会一直播到文件结尾 */
let ringAudioEl: HTMLAudioElement | null = null
/** 铃声代数：stopRing 自增 → 在途的"加载完就播"作废，避免停了又被异步回调响起来 */
let ringGeneration = 0

/**
 * 开始来电铃声：循环播放，最长 45 秒自动停（避免没人接一直响）。
 * 重复调用只会重置计时，不会叠加多路铃声。
 */
export async function startRing(customRing?: string): Promise<void> {
  stopRing()
  const gen = ++ringGeneration
  ringing = true
  const play = (): void => {
    if (!ringing || gen !== ringGeneration) return
    // 还在响就别从头再来：铃声可能是几十秒的曲子，每 3 秒重置只会一直听开头那几秒
    if (ringAudioEl && !ringAudioEl.paused) return
    void playOnce('call', customRing ?? '', gen)
  }
  play()
  ringTimer = setInterval(play, 3000)
  setTimeout(() => { if (gen === ringGeneration) stopRing() }, 45_000)
}

/**
 * 停止来电铃声（接听、拒绝、挂断、超时都要调）。
 * 注意必须【真的把音频停掉】——只清定时器的话，当前这一遍会继续播到文件结束：
 * 铃声文件如果是几十秒的曲子（比如 calling.mp3），接听后还能听见它响一分钟。
 */
export function stopRing(): void {
  ringing = false
  ringGeneration++ // 让在途的 loadSound/play 作废
  if (ringTimer) {
    clearInterval(ringTimer)
    ringTimer = null
  }
  if (ringAudioEl) {
    try {
      ringAudioEl.pause()
      ringAudioEl.currentTime = 0
    } catch { /* ignore */ }
    ringAudioEl = null
  }
}

// ─── 统一入口 ───

async function windowFocused(): Promise<boolean> {
  try {
    const st = await window.pantry.getWindowState()
    return !!st?.focused
  } catch {
    return false
  }
}

/**
 * 通知管理器统一入口。消息、来电、会议、任务提醒都走这里。
 * 注意：调用方不要再自己去判聚焦/免打扰，全部交给这里，避免各处规则不一致。
 */
export async function notifyEvent(ctx: NotifyContext): Promise<void> {
  const kind = ctx.kind
  if (kind === 'alarm' || kind === 'system') {
    // 闹钟自己响；系统提示只弹通知不响音
    if (kind === 'system') {
      await window.pantry.notify({ kind, title: ctx.title, body: ctx.body, target: ctx.target }).catch(() => {})
    }
    return
  }

  const isCallKind = kind === 'call' || kind === 'meeting'
  const conv = ctx.convKey ?? ''
  const muted = !!conv && policy.dndConvs.includes(conv)
  // 免打扰只静音消息/任务；来电优先（静音了来电会漏接）
  const silenced = !isCallKind && (policy.dnd || muted)

  const focused = await windowFocused()
  // 正在看这个会话就不打扰：既不用弹系统通知，也不用响
  const viewingIt = focused && !!ctx.inCurrentConv

  if (!silenced && !viewingIt) {
    if (isCallKind) {
      if (policy.callSound) await startRing(policy.convRings[conv] || policy.callSoundFile)
    } else if (policy.sound) {
      await playOnce(kind, policy.messageSoundFile)
    }
  }

  // 系统通知：原来只在「窗口没聚焦」时弹；现在改成「没在正看这个会话」就弹，
  // 这样你聚焦着别的会话时也能看到提示（和你正在看的那个会话才完全不打扰）。
  if (silenced) return
  const shouldNotify = ctx.force || !viewingIt
  if (!shouldNotify) return
  await window.pantry.notify({ kind, title: ctx.title, body: ctx.body, target: ctx.target }).catch(() => {})
}

/** 清掉全部音频缓存（设置里换了音频文件后调用，让新文件立即生效） */
export function invalidateSoundCache(): void {
  for (const s of loaded.values()) {
    if (s.blob && s.url) URL.revokeObjectURL(s.url)
  }
  loaded.clear()
  resolved.clear()
  warnedMissing.clear()
}
