// 闹钟本地存储与到点触发（纯本地，不联网）
// 存储：localStorage['mochi_alarms']
// 播放：主进程 IPC 读本地音乐文件字节 → blob → Audio（规避渲染进程 file:// 被拒 / app-file 协议音频不稳）

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
  /** 到点后每隔 N 分钟重复响（循环提醒），0 = 仅响一次 */
  repeatMinutes: number
}

const STORE_KEY = 'mochi_alarms'
const firedOnce = new Set<string>() // 会话内已响记录，防同一分钟重复触发
const nextFire = new Map<string, number>() // 重复闹钟：下一次触发时间戳
// 当前正在响铃的 Audio（供通知点击暂停）
const currentRing: { audio: HTMLAudioElement | null; alarmId: string | null } = { audio: null, alarmId: null }

const pad = (n: number) => String(n).padStart(2, '0')

function normalize(a: Alarm): Alarm {
  // 兼容旧数据（无 useRing/notify/command/repeatMinutes 字段）
  return {
    ...a,
    useRing: a.useRing ?? !!a.ring,
    notify: a.notify ?? true,
    command: a.command ?? '',
    repeatMinutes: a.repeatMinutes ?? 10
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

/** 停止当前正在播放的铃声 */
function stopRing(): void {
  if (currentRing.audio) {
    try {
      currentRing.audio.pause()
      currentRing.audio = null
    } catch {
      currentRing.audio = null
    }
  }
  currentRing.alarmId = null
}

/** 弹系统通知；点击通知 = 暂停（停止响铃，repeatMinutes 后重响；无重复则停止本次） */
function notify(a: Alarm): void {
  try {
    const mins = a.repeatMinutes > 0 ? a.repeatMinutes : null
    const body = a.name ? `${a.name} · ${a.time}` : `到点啦，现在是 ${a.time}`
    const n = new Notification('⏰ 闹钟', {
      body: mins ? `${body}（点击暂停 ${mins} 分钟）` : body,
      silent: true // 关闭系统默认提示音，避免与铃声叠加
    })
    n.onclick = () => {
      stopRing()
      if (a.repeatMinutes > 0) {
        nextFire.set(a.id, Date.now() + a.repeatMinutes * 60000) // 延后 N 分钟重响
      } else {
        nextFire.delete(a.id) // 无重复 → 停止本次
      }
    }
  } catch {
    // 通知不可用则静默
  }
}

/** 播放本地音乐：主进程 IPC 读文件字节 → blob → Audio（绕开 app-file 协议对音频支持不稳的问题） */
async function playRing(ring: string): Promise<void> {
  if (!ring) return
  try {
    const r = await window.pantry.readAudioFile(ring)
    if (!r.ok || !r.data) return
    const blob = new Blob([r.data])
    const objUrl = URL.createObjectURL(blob)
    stopRing()
    const audio = new Audio(objUrl)
    audio.volume = 1
    currentRing.audio = audio
    currentRing.alarmId = null
    audio.play().catch(() => {
      if (currentRing.audio === audio) currentRing.audio = null
    })
  } catch {
    // 播放失败静默（至少已发系统通知/执行动作）
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

function trigger(a: Alarm): void {
  if (a.useRing && a.ring) void playRing(a.ring)
  if (a.notify) notify(a)
  if (a.command && a.command.trim()) void runCommand(a.command)
}

/** 到点检测：匹配当前时间的闹钟 → 触发（响铃/通知/执行）；repeatMinutes>0 则循环重响直到被暂停/停止 */
export function fireDueAlarms(): void {
  const now = new Date()
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const weekday = now.getDay()
  const alarms = loadAlarms()
  let changed = false
  for (const a of alarms) {
    if (!a.enabled) continue
    if (a.repeat === 'weekly' && !a.weekdays.includes(weekday)) continue
    const key = `${a.id}_${dateStr}_${timeStr}`
    const nf = nextFire.get(a.id)
    const atTime = a.time === timeStr

    if (atTime && !firedOnce.has(key)) {
      // 首次到点（当日首次）
      trigger(a)
      firedOnce.add(key)
      if (a.repeatMinutes > 0) nextFire.set(a.id, Date.now() + a.repeatMinutes * 60000)
      else nextFire.delete(a.id)
      if (a.repeat === 'once') {
        a.enabled = false
        changed = true
      }
    } else if (a.repeatMinutes > 0 && nf && Date.now() >= nf) {
      // 重复循环 / 通知暂停后的延后重响
      trigger(a)
      nextFire.set(a.id, Date.now() + a.repeatMinutes * 60000)
    }
  }
  if (changed) saveAlarms(alarms)
}
