/**
 * 客户端系统信息采集 + 定时上报（被控端）
 *
 * 服务端"已登录电脑控制"面板既能看服务器本机（sys:* 事件，保留），也能看远程客户端电脑
 * —— 远程电脑的信息由客户端上报（本模块）。
 *
 * 采集字段对齐服务端 sys:info + sys:perf 结构：
 *   info: { hostname, platform, type, release, arch, uptime, cpuModel, cpuCores, totalMem, freeMem, ips, board, gpu, disk }
 *   perf: { cpu, memPercent, memUsed, memTotal }
 *
 * 由 server-ipc 在登录连接后启动、断开时停止；定时（约 5s）经 dev:sys 上报给服务端。
 * board/gpu/disk 采集较重（spawn 外部命令），约每 30s 刷新一次缓存。
 */
import { app } from 'electron'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { exec } from 'node:child_process'

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

function execCmd(cmd: string, timeout = 12000): Promise<string> {
  return new Promise((resolve) => {
    try {
      exec(cmd, { timeout, windowsHide: true }, (err, stdout) => {
        resolve(err ? '' : String(stdout ?? '').trim())
      })
    } catch { resolve('') }
  })
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

let boardGpuDisk = { board: '', gpu: '', disk: '' }
let lastBgD = 0

async function refreshBoardGpuDisk(): Promise<void> {
  try {
    if (os.platform() === 'win32') {
      const [board, gpu] = await Promise.all([
        execCmd('powershell -NoProfile -Command "Get-CimInstance Win32_BaseBoard | Select-Object -ExpandProperty Manufacturer; Get-CimInstance Win32_BaseBoard | Select-Object -ExpandProperty Product"'),
        execCmd('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"')
      ])
      const disk = await execCmd('powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Free -ne $null} | ForEach-Object { \'$($_.Name) 总:$([math]::Round($_.Used/1GB,1))GB 余:$([math]::Round($_.Free/1GB,1))GB\' }"')
      boardGpuDisk = {
        board: board.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ') || '未知',
        gpu: gpu.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ') || '未知',
        disk: disk.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('\n')
      }
    } else {
      const [board, gpu, disk] = await Promise.all([
        execCmd('dmidecode -t baseboard 2>/dev/null | grep -E "Manufacturer|Product Name" | head -4'),
        execCmd('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || lspci 2>/dev/null | grep -iE "vga|3d|display" | head -4'),
        execCmd('df -h --output=target,size,used,avail,pcent 2>/dev/null || df -h')
      ])
      boardGpuDisk = {
        board: board.split(/\r?\n/).map((s) => s.replace(/^\s*\w+:\s*/, '').trim()).filter(Boolean).join(' / ') || '未知',
        gpu: gpu.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join(' / ') || '未知',
        disk: disk.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12).join('\n')
      }
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

export function startSysReport(emit: (payload: SysReportPayload) => void): void {
  if (timer) return
  const did = deviceId()
  stopped = false
  lastCpu = os.cpus()
  void refreshBoardGpuDisk()
  lastBgD = Date.now()

  const tick = async (): Promise<void> => {
    if (stopped) return
    const now = Date.now()
    if (now - lastBgD > 30_000) {
      await refreshBoardGpuDisk()
      lastBgD = now
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
      board: boardGpuDisk.board,
      gpu: boardGpuDisk.gpu,
      disk: boardGpuDisk.disk
    }
    const perf: Record<string, unknown> = {
      cpu: cpuUsage(),
      memPercent: totalMem > 0 ? Math.max(0, Math.round(100 * (totalMem - free) / totalMem)) : 0,
      memUsed: totalMem - free,
      memTotal: totalMem
    }
    try { emit({ deviceId: did, info, perf }) } catch { /* 忽略单次失败 */ }
  }

  void tick()
  timer = setInterval(() => void tick(), 5000)
}

export function stopSysReport(): void {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
