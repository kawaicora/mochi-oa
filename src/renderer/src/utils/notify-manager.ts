/**
 * 渲染层「通知管理器」：消息/来电类事件到达时，统一决定
 *   ① 要不要弹系统通知   ② 要不要播提示音   ③ 播哪个音
 *
 * 之前这块逻辑散在各处（app.ts 的 notifyIfUnfocused、rtc.ts 的 maybeNotify、
 * TaskView/RtcCallRoom 各写一份），而且**没有区分通知类型**——来电和普通消息待遇一样。
 * 分流规则（唯一口径，调用方不参与选音）：
 *
 *   │ 分组                │ 类型                          │ 提示音                     │ 免打扰           │
 *   │ 通话类              │ call / meeting                │ calling.mp3 循环铃声        │ 否（来电优先）   │
 *   │ 非通话类（其余全部）│ message / task / company / system │ message.wav 单次提示音  │ 是（全局/会话）  │
 *   │ 不走这里            │ alarm                         │ 闹钟自带播放                │ —                │
 *
 * 即：只要进管理器的非通话事件，统一播消息提示音；只有通话类播铃声。

 * 音频文件丢失自动回退默认：由主进程 resolveNotifySound 判定（自定义不存在 →
 * resources/message.wav 或 calling.mp3），渲染层不用猜路径。
 * 播放失败（文件损坏/被删/格式不支持）会清缓存重解析一次，再失败就静默放弃——
 * 绝不能因为提示音出问题影响消息收发本身。
 */
import { ref, computed } from 'vue'
import type { NotifKind, NotifTarget } from '@shared/ipc'
import { sanitizeHtml, escapeHtml } from './html-sanitize'

/** 通知归属范围：个人私聊 / 群 / 公司（审批类走公司） */
export type NotifyScopeKind = 'dm' | 'group' | 'company'
export interface NotifyScope {
  kind: NotifyScopeKind
  id: number
}
export type SoundType = 'message' | 'ring'
/** 单个范围的自定义音效覆盖：消息提示音 / 来电铃声 */
export interface SoundOverride {
  message?: string
  ring?: string
}

/** 会话 key：群/私聊统一成 group:<conversationId> / dm:<conversationId>，本地设置用它当键 */
export function convKey(type: string, conversationId: number): string {
  return `${type === 'dm' ? 'dm' : 'group'}:${conversationId}`
}

/** 范围 key：dm:<userId> / group:<groupId> / company:<companyId> */
export function scopeKey(scope: NotifyScope | undefined): string {
  return scope ? `${scope.kind}:${scope.id}` : ''
}

/**
 * 通知设置（持久化到本地 server-config.json）。
 * 读写、静音/免打扰、铃声/消息音选择全部由本管理器负责，调用方与设置面板不直接碰存储。
 */
export interface NotifyConfig {
  /** 消息提示音开关（非通话类事件） */
  notifySound: boolean
  /** 来电/会议铃声开关（通话类事件） */
  callSound: boolean
  /** 全局自定义消息提示音（绝对路径，空=用 resources/message.wav） */
  messageSoundFile: string
  /** 全局自定义来电铃声（绝对路径，空=用 resources/calling.mp3） */
  callSoundFile: string
  /** 全局免打扰（只静音消息类；来电照响） */
  dnd: boolean
  /** 单独免打扰的会话 key */
  dndConvs: string[]
  /** 兼容旧版：每个会话的来电铃声（key=会话 key，value=路径）；新代码用 soundOverrides */
  convRings: Record<string, string>
  /** 按范围覆盖音效：key=scopeKey，value={ message?, ring? }；缺省回退全局 */
  soundOverrides: Record<string, SoundOverride>
}

const DEFAULT_CFG: NotifyConfig = {
  notifySound: true,
  callSound: true,
  messageSoundFile: '',
  callSoundFile: '',
  dnd: false,
  dndConvs: [],
  convRings: {},
  soundOverrides: {}
}

/** 响应式配置：设置面板直接绑定；决策、持久化、缓存失效都在本管理器内完成 */
export const notifyCfg = ref<NotifyConfig>({ ...DEFAULT_CFG })

/** 去掉 Vue 响应式 Proxy，产出可安全走 IPC 结构化克隆的纯数据 */
function plainCfg(): NotifyConfig {
  const c = notifyCfg.value
  return {
    notifySound: c.notifySound,
    callSound: c.callSound,
    messageSoundFile: c.messageSoundFile,
    callSoundFile: c.callSoundFile,
    dnd: c.dnd,
    dndConvs: [...c.dndConvs],
    convRings: { ...c.convRings },
    soundOverrides: JSON.parse(JSON.stringify(c.soundOverrides)) as Record<string, SoundOverride>
  }
}

/** 启动时载入通知设置；失败保持默认，不阻塞登录 */
export async function loadNotifyCfg(): Promise<void> {
  try {
    const s = await window.pantry.serverGetSettings()
    const soundOverrides = s.soundOverrides && typeof s.soundOverrides === 'object'
      ? (s.soundOverrides as Record<string, SoundOverride>)
      : {}
    // 旧版 convRings 迁移到 soundOverrides.ring（仅当新表为空时）
    const legacy = s.convRings && typeof s.convRings === 'object' ? s.convRings : {}
    if (Object.keys(soundOverrides).length === 0 && Object.keys(legacy).length > 0) {
      for (const [k, v] of Object.entries(legacy)) {
        soundOverrides[k] = { ring: v as string }
      }
    }
    notifyCfg.value = {
      notifySound: s.notifySound !== false,
      callSound: s.callSound !== false,
      messageSoundFile: s.messageSoundFile ?? '',
      callSoundFile: s.callSoundFile ?? '',
      dnd: s.dnd === true,
      dndConvs: Array.isArray(s.dndConvs) ? s.dndConvs : [],
      convRings: { ...legacy },
      soundOverrides
    }
  } catch (e) {
    console.warn('[notify] 读取通知设置失败', e)
  }
}

/** 变更通知设置：更新本地响应式配置 → 持久化；音频文件变更时清播放缓存 */
const AUDIO_CFG_KEYS = ['messageSoundFile', 'callSoundFile', 'convRings', 'soundOverrides'] as const

export async function saveNotifyCfg(patch: Partial<NotifyConfig>): Promise<void> {
  notifyCfg.value = { ...notifyCfg.value, ...patch }
  try {
    await window.pantry.serverSaveSettings(plainCfg())
  } catch (e) {
    console.warn('[notify] 保存通知设置失败', e)
  }
  if (AUDIO_CFG_KEYS.some((k) => k in patch)) invalidateSoundCache()
}

/**
 * 解析某范围某类型最终使用的音频路径。
 * 优先级：范围覆盖（个人/群/公司）→ 全局默认；空串表示用 resources 下默认音。
 */
export function resolveSoundPath(scope: NotifyScope | undefined, type: SoundType): string {
  const ov = notifyCfg.value.soundOverrides[scopeKey(scope)]
  if (ov) {
    const p = type === 'ring' ? ov.ring : ov.message
    if (p) return p
  }
  return type === 'ring' ? notifyCfg.value.callSoundFile : notifyCfg.value.messageSoundFile
}

/** 设置某范围的自定义音效；传空串清除该类型覆盖 */
export async function setScopeSound(scope: NotifyScope, type: SoundType, file: string): Promise<void> {
  const key = scopeKey(scope)
  const next = { ...notifyCfg.value.soundOverrides }
  const cur = { ...(next[key] ?? {}) }
  if (file) cur[type] = file
  else delete cur[type]
  if (Object.keys(cur).length === 0) delete next[key]
  else next[key] = cur
  await saveNotifyCfg({ soundOverrides: next })
}

/** 读取某范围的自定义音效路径（未设置返回空串） */
export function scopeSoundOf(scope: NotifyScope | undefined, type: SoundType): string {
  return notifyCfg.value.soundOverrides[scopeKey(scope)]?.[type] ?? ''
}


/** 会话是否免打扰 */
export function isConvMuted(key: string): boolean {
  return notifyCfg.value.dndConvs.includes(key)
}

/** 切换会话免打扰 */
export async function setConvMuted(key: string, muted: boolean): Promise<void> {
  const list = notifyCfg.value.dndConvs.filter((k) => k !== key)
  if (muted) list.push(key)
  await saveNotifyCfg({ dndConvs: list })
}

/** 会话自定义铃声（空串=清除，回到全局来电铃声） */
export function convRingOf(key: string): string {
  return notifyCfg.value.convRings[key] ?? ''
}

export async function setConvRing(key: string, file: string): Promise<void> {
  const next = { ...notifyCfg.value.convRings }
  if (file) next[key] = file
  else delete next[key]
  await saveNotifyCfg({ convRings: next })
}

/** 统一通知按钮 */
export interface NotifyButton {
  text: string
  role?: 'primary' | 'danger' | 'default'
  /** 点击后执行；条目先关闭，再触发回调 */
  onClick?: () => unknown | Promise<unknown>
}

/** 应用内统一通知条目（标题 + 正文 + 按钮列表） */
export interface NotifyItem {
  id: number
  kind: NotifKind
  title: string
  /** 已消毒后的正文（html=true 时是安全 HTML，否则是转义后的纯文本） */
  content: string
  /** 正文是否按 HTML 渲染 */
  html: boolean
  /** 触发方用户 id（申请/邀请/消息来源） */
  fromId?: number
  /** 音效覆盖归属范围（个人/群/公司） */
  scope?: NotifyScope
  target?: NotifTarget
  buttons: NotifyButton[]
  /** 无按钮条目自动消失毫秒数；0/缺省不自动消失 */
  autoDismiss?: number
}

/** 通知上下文 */
export interface NotifyContext {
  kind: NotifKind
  title: string
  body: string
  /** 正文是否按 HTML 渲染（默认纯文本；开启后经消毒再上屏） */
  html?: boolean
  /** 触发方用户 id */
  fromId?: number
  /** 音效覆盖归属范围（个人/群/公司） */
  scope?: NotifyScope
  /** 该事件所属会话（有会话的通知才有免打扰/自定义铃声的概念） */
  convKey?: string
  /** 该会话是否正是当前打开着的会话（窗口聚焦时这类事件完全不打扰） */
  inCurrentConv?: boolean
  /** 高风险事件（远程控制请求等）：无论聚焦与否都发系统通知 */
  force?: boolean
  target?: NotifTarget
  /** 携带按钮时进入应用内面板；按钮列表 */
  buttons?: NotifyButton[]
  /** 无按钮条目自动消失毫秒数；缺省 8000 */
  autoDismiss?: number
  /** 是否进入应用内统一队列（缺省 true；false 时只响铃 + 系统通知，不挂卡片） */
  panel?: boolean
}

// ─── 应用内统一通知队列 ───

const notifyQueue = ref<NotifyItem[]>([])
let notifySeq = 1

/** 当前待展示的第一条通知（面板逐条弹出） */
export const currentNotify = computed(() => notifyQueue.value[0] ?? null)

/** 推入一条应用内通知；正文按 html 标记消毒/转义后存储 */
export function pushNotify(ctx: NotifyContext): number {
  const id = notifySeq++
  const content = ctx.html ? sanitizeHtml(ctx.body) : escapeHtml(ctx.body)
  const buttons = ctx.buttons ?? []
  notifyQueue.value.push({
    id,
    kind: ctx.kind,
    title: ctx.title,
    content,
    html: ctx.html === true,
    fromId: ctx.fromId,
    scope: ctx.scope,
    target: ctx.target,
    buttons,
    autoDismiss: ctx.autoDismiss
  })
  // 无按钮的轻提示按 autoDismiss（缺省 8 秒）自动消失；带按钮的条目等待点击
  if (buttons.length === 0) {
    const ms = ctx.autoDismiss ?? 8000
    window.setTimeout(() => dismissNotify(id), ms)
  }
  return id
}

/** 关闭指定通知 */
export function dismissNotify(id: number): void {
  notifyQueue.value = notifyQueue.value.filter((n) => n.id !== id)
}

/** 点击某条目按钮：关闭后执行回调 */
export function resolveNotify(id: number, buttonIndex: number): void {
  const item = notifyQueue.value.find((n) => n.id === id)
  const handler = item?.buttons[buttonIndex]?.onClick
  dismissNotify(id)
  if (handler) void Promise.resolve().then(() => handler())
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
 * 通知管理器统一入口。消息、来电、会议、任务提醒、系统提示都走这里。
 * 分流规则（逻辑唯一口径）：
 *   - call / meeting：通话类，播循环来电铃声（calling.mp3，可自定义）；
 *   - 其余一切（message / task / company / system）：非通话类，统一播一次消息提示音
 *     （message.wav，可自定义）；
 *   - alarm：闹钟自带播放，不走这里。
 * 注意：调用方不要再自己去判聚焦/免打扰，全部交给这里，避免各处规则不一致。
 */
export async function notifyEvent(ctx: NotifyContext): Promise<void> {
  const kind = ctx.kind
  if (kind === 'alarm') return

  const isCallKind = kind === 'call' || kind === 'meeting'
  const conv = ctx.convKey ?? ''
  const cfg = notifyCfg.value
  const muted = !!conv && cfg.dndConvs.includes(conv)
  // 免打扰只静音消息类；来电优先（静音了来电会漏接）
  const silenced = !isCallKind && (cfg.dnd || muted)

  const focused = await windowFocused()
  // 正在看这个会话就不打扰：既不用弹系统通知，也不用响
  const viewingIt = focused && !!ctx.inCurrentConv

  // 音效归属范围：个人/群/公司覆盖 → 全局默认；通话类取 ring，其余取 message
  const soundType: SoundType = isCallKind ? 'ring' : 'message'
  const soundPath = resolveSoundPath(ctx.scope, soundType)

  if (!silenced && !viewingIt) {
    if (isCallKind) {
      if (cfg.callSound) await startRing(soundPath)
    } else if (cfg.notifySound) {
      // 非通话类统一用消息提示音；kind 只影响系统通知的级别/文案，不影响选音
      await playOnce('message', soundPath)
    }
  }

  // 系统通知：原来只在「窗口没聚焦」时弹；现在改成「没在正看这个会话」就弹，
  // 这样你聚焦着别的会话时也能看到提示（和你正在看的那个会话才完全不打扰）。
  if (silenced) return
  const shouldNotify = ctx.force || !viewingIt
  if (!shouldNotify) return
  await window.pantry.notify({ kind, title: ctx.title, body: ctx.body, target: ctx.target }).catch(() => {})

  // 应用内统一条目：通话类由来电弹窗承接，其余进入统一队列（可带按钮/HTML 正文）
  if (!isCallKind && ctx.panel !== false) pushNotify(ctx)
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
