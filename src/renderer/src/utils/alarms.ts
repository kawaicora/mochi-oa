// 闹钟本地存储与到点触发（纯本地，不联网）
// 存储：localStorage['mochi_alarms']
// 播放：通过应用 app-file:// 协议加载本地音乐文件（规避渲染进程 file:// 被拒）

export type AlarmRepeat = 'once' | 'daily' | 'weekly'
export interface Alarm {
  id: string
  /** HH:MM */
  time: string
  repeat: AlarmRepeat
  /** 仅 weekly：0(日)~6(六) */
  weekdays: number[]
  name: string
  /** 本地音乐文件绝对路径（铃声），可空 */
  ring: string
  /** 到点是否播放铃声（可关闭：用户可能自己写程序播放音乐） */
  useRing: boolean
  /** 到点是否弹系统通知（可关闭：用户程序可能自带提示） */
  notify: boolean
  /** 到点要执行的程序/脚本命令（Windows: exe/bat/ps1，Linux/macOS: 可执行/sh），可空 */
  command: string
  enabled: boolean
}

const STORE_KEY = 'mochi_alarms'
const firedOnce = new Set<string>() // 会话内已响记录，防同一时刻重复触发

const pad = (n: number) => String(n).padStart(2, '0')

function normalize(a: Alarm): Alarm {
  // 兼容旧数据（无 useRing/notify/command 字段）
  return {
    ...a,
    useRing: a.useRing ?? !!a.ring,
    notify: a.notify ?? true,
    command: a.command ?? ''
  }
}

export function loadAlarms(): Alarm[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const list = raw ? (JSON.parse(raw) as Alarm[]) : []
    return Array.isArray(list) ? list.map(normalize) : []
  } catch {
    return []
  }
}
export function saveAlarms(alarms: Alarm[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(alarms))
}
export function newAlarmId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 文件路径 → app-file 协议 URL（供 <audio> 播放） */
export function ringUrl(ring: string): string {
  return ring ? `app-file:///${encodeURIComponent(ring)}` : ''
}

function notify(a: Alarm): void {
  try {
    // eslint-disable-next-line no-new
    new Notification('⏰ 闹钟', {
      body: a.name ? `${a.name} · ${a.time}` : `到点啦，现在是 ${a.time}`,
      silent: true // 关闭系统默认提示音，避免与铃声叠加
    })
  } catch {
    // 通知不可用则静默
  }
}

function playRing(ring: string): void {
  if (!ring) return
  try {
    const audio = new Audio(ringUrl(ring))
    audio.volume = 1
    audio.play().catch(() => {})
  } catch {
    // 播放失败静默（至少已发系统通知）
  }
}

async function runCommand(cmd: string): Promise<void> {
  if (!cmd.trim()) return
  try {
    await window.pantry.runAlarmCommand(cmd)
  } catch {
    // 执行失败静默
  }
}

/** 到点检测：匹配当前时间的闹钟 → 按配置播放铃声 / 系统通知 / 执行程序脚本；一次闹钟触发后自动停用 */
export function fireDueAlarms(): void {
  const now = new Date()
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const weekday = now.getDay()
  const alarms = loadAlarms()
  let changed = false
  for (const a of alarms) {
    if (!a.enabled || a.time !== timeStr) continue
    if (a.repeat === 'weekly' && !a.weekdays.includes(weekday)) continue
    const key = `${a.id}_${dateStr}_${timeStr}`
    if (firedOnce.has(key)) continue
    if (a.useRing && a.ring) playRing(a.ring)
    if (a.notify) notify(a)
    if (a.command && a.command.trim()) void runCommand(a.command)
    if (a.repeat === 'once') {
      a.enabled = false
      changed = true
    }
    firedOnce.add(key)
  }
  if (changed) saveAlarms(alarms)
}
