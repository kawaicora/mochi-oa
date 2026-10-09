/**
 * 客户端系统信息采集 + 定时上报（被控端）
 *
 * 跨平台（win / linux / mac）统一用 systeminformation 库采集，一套 API 封装了
 * WMI / dmidecode / sysctl / nvidia-smi 等，避免手写脆弱的外部命令拼接。
 *
 * 采集字段（AIDA64 粒度）：
 *   info: {
 *     hostname, platform, type, release, arch, uptime,
 *     cpuModel, cpuCores, totalMem, freeMem, ips,
 *     board,          // 主板厂商 + 型号
 *     memDetail,      // 每根内存条 { capacity, speed, manufacturer, type }
 *     gpuInfo,        // 每 GPU { name, vram, driver }
 *     devices,        // 网卡(含MAC) / 磁盘 设备摘要
 *     disk,           // 分区占用
 *     processes       // 进程快照（前 40，按内存降序）{ pid, name, mem, cpu }
 *   }
 *   perf: { cpu, memPercent, memUsed, memTotal, gpus:[{name, load}] }  // 每 GPU 实时使用率
 *
 * 实时字段（cpu/mem）每 5s；静态硬件 + GPU 使用率约每 30s 刷新（systeminformation 采集较重）。
 */
import { app } from 'electron'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as si from 'systeminformation'

export interface SysReportPayload {
  deviceId: string
  info: Record<string, unknown>
  perf: Record<string, unknown>
}

let timer: NodeJS.Timeout | null = null
let stopped = false

function deviceId(): string {
  const f = path.join(app.getPath('userData'), 'device-id.json')
  try {
    if (fs.existsSync(f)) {
      const id = (JSON.parse(fs.readFileSync(f, 'utf8')) as { id?: string }).id
      if (id) return id
    }
  } catch { /* ignore */ }
  return 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

function networkIps(): Array<{ name: string; address: string; internal: boolean }> {
  const nets = os.networkInterfaces()
  const out: Array<{ name: string; address: string; internal: boolean }> = []
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n && n.family === 'IPv4') out.push({ name, address: n.address, internal: !!n.internal })
    }
  }
  return out
}

// ── 静态硬件缓存（约 30s 刷新）──────────────────────────
let staticInfo: {
  board: string
  memDetail: Array<Record<string, unknown>>
  gpuInfo: Array<Record<string, unknown>>
  devices: Array<Record<string, unknown>>
  disk: string
  processes: Array<Record<string, unknown>>
  gpus: Array<{ name: string; load: number }>
} = { board: '未知', memDetail: [], gpuInfo: [], devices: [], disk: '', processes: [], gpus: [] }
let lastStatic = 0
let gpuLoadTimer: NodeJS.Timeout | null = null

function gpuName(c: { vendor?: string; model?: string }): string {
  return [c.vendor, c.model].filter(Boolean).join(' ').trim() || 'GPU'
}

async function refreshStatic(): Promise<void> {
  try {
    const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T | undefined> =>
      Promise.race([p, new Promise<undefined>((res) => setTimeout(() => res(undefined), ms))])
    const [mb, memLayout, graphics, disks, nets, fsSizes, procs] = await Promise.all([
      withTimeout(si.motherboard(), 4000),
      withTimeout(si.memLayout(), 4000),
      withTimeout(si.graphics(), 4000),
      withTimeout(si.diskLayout(), 4000),
      withTimeout(si.networkInterfaces(), 4000),
      withTimeout(si.fsSize(), 4000),
      withTimeout(si.processes(), 6000)
    ])
    staticInfo.board = mb ? ([mb.manufacturer, mb.model].filter(Boolean).join(' ').trim() || '未知') : staticInfo.board
    if (memLayout) staticInfo.memDetail = (memLayout as Array<Record<string, unknown>>).map((m) => ({
      capacity: (m as { size?: number }).size ? Math.round((m as { size: number }).size / 1e9) + 'GB' : '',
      speed: (m as { clockSpeed?: number }).clockSpeed ? String((m as { clockSpeed: number }).clockSpeed) + 'MHz' : '',
      manufacturer: (m as { manufacturer?: string }).manufacturer || '',
      type: (m as { type?: string }).type || ''
    }))
    if (graphics) {
      const controllers = (graphics as { controllers?: Array<Record<string, unknown>> }).controllers || []
      staticInfo.gpuInfo = controllers.map((c) => ({
        name: gpuName(c),
        vram: (c as { vram?: number }).vram ? (c as { vram: number }).vram + 'GB' : '',
        driver: (c as { driverVersion?: string }).driverVersion || ''
      }))
      staticInfo.gpus = controllers.map((c) => ({
        name: gpuName(c),
        load: (c as { utilizationGpu?: number }).utilizationGpu != null ? Math.min(100, Math.max(0, Math.round((c as { utilizationGpu: number }).utilizationGpu))) : 0
      }))
    }
    const devices: Array<Record<string, unknown>> = []
    if (nets) {
      for (const name of Object.keys(nets as Record<string, unknown>)) {
        const n = (nets as Record<string, { mac?: string; operstate?: string; ip4?: string }>)[name]
        if (n && n.mac && n.mac !== '00:00:00:00:00:00' && n.operstate !== 'down') {
          devices.push({ type: '网卡', name, mac: n.mac, ip: n.ip4 || '' })
        }
      }
    }
    if (disks) {
      for (const d of disks as Array<{ name?: string; device?: string; size?: number }>) {
        devices.push({ type: '磁盘', name: d.name || d.device || '', size: d.size ? Math.round(d.size / 1e9) + 'GB' : '' })
      }
    }
    staticInfo.devices = devices
    if (fsSizes) staticInfo.disk = (fsSizes as Array<{ mount?: string; used?: number; size?: number; use?: number }>).map((f) => `${f.mount}: ${Math.round((f.used ?? 0) / 1e9)}GB/${Math.round((f.size ?? 0) / 1e9)}GB(${f.use || 0}%)`).join('\n')
    if (procs && (procs as { all?: Array<Record<string, unknown>> }).all) {
      const all = (procs as { all: Array<Record<string, unknown>> }).all.slice().sort((a, b) => ((b as { mem_rss?: number }).mem_rss || 0) - ((a as { mem_rss?: number }).mem_rss || 0)).slice(0, 40)
      staticInfo.processes = all.map((p) => ({
        pid: (p as { pid?: number }).pid,
        name: (p as { name?: string }).name || '',
        mem: (p as { mem_rss?: number }).mem_rss ? Math.round((p as { mem_rss: number }).mem_rss / 1e6) : 0,
        cpu: (p as { cpu?: number }).cpu != null ? Math.round((p as { cpu: number }).cpu) : 0
      }))
    }
  } catch { /* 保留旧值 */ }
}

let lastCpu = os.cpus()

function cpuUsage(): number {
  const cur = os.cpus()
  let idle = 0
  let total = 0
  for (let i = 0; i < cur.length; i++) {
    const o = lastCpu[i]
    const n = cur[i]
    if (!o) continue
    const ti = n.times.idle - o.times.idle
    const tt =
      (n.times.user + n.times.nice + n.times.sys + n.times.idle + n.times.irq) -
      (o.times.user + o.times.nice + o.times.sys + o.times.idle + o.times.irq)
    idle += ti
    total += tt
  }
  lastCpu = cur
  return total > 0 ? Math.max(0, Math.round(100 * (1 - idle / total))) : 0
}

export function startSysReport(emit: (payload: SysReportPayload, onAck?: (status: string) => void) => void): void {
  if (timer) return
  const did = deviceId()
  stopped = false
  lastCpu = os.cpus()
  lastStatic = Date.now()
  void refreshStatic()
  gpuLoadTimer = setInterval(() => void refreshStatic(), 30_000) // GPU 使用率随静态一起刷新

  const tick = async (): Promise<void> => {
    if (stopped) return
    const now = Date.now()
    if (now - lastStatic > 30_000) {
      lastStatic = now
      void refreshStatic() // 静态采集异步后台刷新，绝不阻塞上报（此前 await 卡住导致 dev:sys 从不发出）
    }
    const totalMem = os.totalmem()
    const free = os.freemem()
    const cpus = os.cpus()
    const info: Record<string, unknown> = {
      hostname: os.hostname(),
      platform: os.platform(),
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      uptime: Math.round(os.uptime()),
      cpuModel: (cpus[0]?.model ?? '').trim(),
      cpuCores: cpus.length,
      totalMem,
      freeMem: free,
      ips: networkIps(),
      board: staticInfo.board,
      memDetail: staticInfo.memDetail,
      gpuInfo: staticInfo.gpuInfo,
      devices: staticInfo.devices,
      disk: staticInfo.disk,
      processes: staticInfo.processes
    }
    const perf: Record<string, unknown> = {
      cpu: cpuUsage(),
      memPercent: totalMem > 0 ? Math.max(0, Math.round(100 * (totalMem - free) / totalMem)) : 0,
      memUsed: totalMem - free,
      memTotal: totalMem,
      gpus: staticInfo.gpus
    }
    try { emit({ deviceId: did, info, perf }, onAck) } catch { /* 忽略单次失败 */ }
  }

  void tick()
  timer = setInterval(() => void tick(), 5000)
}

export function stopSysReport(): void {
  stopped = true
  if (gpuLoadTimer) { clearInterval(gpuLoadTimer); gpuLoadTimer = null }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
