/**
 * 客户端系统信息采集 + 定时上报（被控端）
 *
 * 服务端"已登录电脑控制"面板既能看服务器本机（sys:* 事件，保留），也能看远程客户端电脑
 * —— 远程电脑的信息由客户端上报（本模块）。
 *
 * 采集字段（对齐 AIDA64 粒度，跨平台 win/linux/mac）：
 *   info: {
 *     hostname, platform, type, release, arch, uptime,
 *     cpuModel, cpuCores, totalMem, freeMem, ips,
 *     board,                     // 主板厂商 + 型号
 *     memDetail,                 // 每根内存条 { capacity, speed, manufacturer, type }
 *     gpuInfo,                   // 每 GPU { name, vram, driver }
 *     devices,                   // 网卡 / 磁盘 / 声卡 / 显示器 设备摘要
 *     disk,                      // 逻辑分区占用
 *     processes                  // 进程快照（前 40，按内存降序）{ pid, name, mem, cpu }
 *   }
 *   perf: { cpu, memPercent, memUsed, memTotal, gpus:[{name, load}] }  // 每 GPU 实时使用率
 *
 * 实时字段（cpu/mem）每 5s；静态硬件（board/memDetail/gpuInfo/devices/processes）与 GPU 使用率约每 30s 刷新缓存。
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

function execCmd(cmd: string, timeout = 20000): Promise<string> {
  return new Promise((resolve) => {
    try {
      exec(cmd, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 * 8 }, (err, stdout) => {
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

// ── 静态硬件缓存（约 30s 刷新一次，避免频繁 spawn 外部命令）────────────────
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

function memTypeName(t: number): string {
  const map: Record<number, string> = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 28: 'DDR5', 34: 'DDR5', 0: '未知' }
  return map[t] ?? ('类型' + t)
}

async function refreshStaticWindows(): Promise<void> {
  // 一条 PowerShell：主板/内存/GPU/网卡/磁盘/声卡/分区/进程 → ConvertTo-Json
  const cmd =
    "powershell -NoProfile -Command \"" +
    "$o=@{};" +
    "$o.board=((Get-CimInstance Win32_BaseBoard | % {\\\"$($_.Manufacturer) $($_.Product)\\\"}) -join ' / ');" +
    "$o.mem=(Get-CimInstance Win32_PhysicalMemory | % {[pscustomobject]@{cap=[math]::Round($_.Capacity/1GB);speed=$_.Speed;manu=$_.Manufacturer;type=$_.MemoryType}});" +
    "$o.gpu=(Get-CimInstance Win32_VideoController | % {[pscustomobject]@{name=$_.Name;vram=[math]::Round($_.AdapterRAM/1GB);driver=$_.DriverVersion}});" +
    "$o.nic=(Get-CimInstance Win32_NetworkAdapter | ? {$_.PhysicalAdapter} | % {[pscustomobject]@{name=$_.Name;mac=$_.MACAddress}});" +
    "$o.disk=(Get-CimInstance Win32_DiskDrive | % {[pscustomobject]@{model=$_.Model;size=[math]::Round($_.Size/1GB)}});" +
    "$o.snd=(Get-CimInstance Win32_SoundDevice | % {$_.Name});" +
    "$o.mon=(Get-CimInstance Win32_DesktopMonitor -EA SilentlyContinue | % {$_.Name} | Select -Unique);" +
    "$o.disk2=(Get-PSDrive -PSProvider FileSystem | ? {$_.Free -ne $null} | % {\\\"$($_.Name):$([math]::Round($_.Used/1GB,1))GB/$([math]::Round($_.Free/1GB,1))GB\\\"});" +
    "$o.proc=(Get-Process | Sort WorkingSet -Desc | Select -First 40 | % {[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;mem=[math]::Round($_.WorkingSet/1MB);cpu=[math]::Round($_.CPU)}});" +
    "$o | ConvertTo-Json -Compress -Depth 3\""
  const raw = await execCmd(cmd)
  if (!raw) return
  let j: Record<string, unknown>
  try { j = JSON.parse(raw) } catch { return }
  const board = String(j.board ?? '').trim() || '未知'
  const memDetail = Array.isArray(j.mem) ? (j.mem as Array<Record<string, unknown>>) : []
  const gpuInfo = Array.isArray(j.gpu) ? (j.gpu as Array<Record<string, unknown>>) : []
  const nic = Array.isArray(j.nic) ? (j.nic as Array<Record<string, unknown>>) : []
  const diskDrv = Array.isArray(j.disk) ? (j.disk as Array<Record<string, unknown>>) : []
  const snd = Array.isArray(j.snd) ? (j.snd as unknown[]) : []
  const mon = Array.isArray(j.mon) ? (j.mon as unknown[]) : []
  const disk = Array.isArray(j.disk2) ? (j.disk2 as string[]).join('\n') : ''
  const processes = Array.isArray(j.proc) ? (j.proc as Array<Record<string, unknown>>) : []
  const devices: Array<Record<string, unknown>> = []
  for (const n of nic) devices.push({ type: '网卡', name: String(n.name ?? ''), mac: String(n.mac ?? '') })
  for (const d of diskDrv) devices.push({ type: '磁盘', name: String(d.model ?? ''), size: String(d.size ?? '') + 'GB' })
  for (const s of snd) devices.push({ type: '声卡', name: String(s) })
  for (const m of mon) if (String(m).trim()) devices.push({ type: '显示器', name: String(m) })
  staticInfo.board = board
  staticInfo.memDetail = memDetail.map((m) => ({
    capacity: String(m.cap ?? '') + 'GB',
    speed: String(m.speed ?? '') + 'MHz',
    manufacturer: String(m.manu ?? ''),
    type: memTypeName(Number(m.type ?? 0))
  }))
  staticInfo.gpuInfo = gpuInfo.map((g) => ({
    name: String(g.name ?? ''),
    vram: String(g.vram ?? '') + 'GB',
    driver: String(g.driver ?? '')
  }))
  staticInfo.devices = devices
  staticInfo.disk = disk
  staticInfo.processes = processes
}

async function refreshStaticLinux(): Promise<void> {
  const [boardRaw, memRaw, gpuRaw, diskRaw, procRaw, pciRaw] = await Promise.all([
    execCmd('dmidecode -t baseboard 2>/dev/null | grep -E "Manufacturer|Product Name" | head -4'),
    execCmd('cat /proc/meminfo 2>/dev/null | grep -E "^MemTotal" | head -1'),
    execCmd('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null || lspci 2>/dev/null | grep -iE "vga|3d|display" | head -4'),
    execCmd('df -h --output=target,size,used,avail,pcent 2>/dev/null || df -h'),
    execCmd("ps -eo pid,comm,rss,pcpu --sort=-rss 2>/dev/null | head -40"),
    execCmd('lspci 2>/dev/null | head -20')
  ])
  staticInfo.board = boardRaw.split(/\r?\n/).map((s) => s.replace(/^\s*\w+:\s*/, '').trim()).filter(Boolean).join(' / ') || '未知'
  staticInfo.memDetail = []
  const mt = /MemTotal:\s+(\d+)/.exec(memRaw)
  if (mt) staticInfo.memDetail.push({ capacity: String(Math.round(Number(mt[1]) / 1024 / 1024)) + 'GB', speed: '', manufacturer: '', type: '' })
  staticInfo.gpuInfo = gpuRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s, i) => ({ name: s, vram: '', driver: '', index: i }))
  staticInfo.devices = pciRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => ({ type: 'PCI', name: s }))
  staticInfo.disk = diskRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 12).join('\n')
  staticInfo.processes = procRaw.split(/\r?\n/).slice(1).map((s) => {
    const p = s.trim().split(/\s+/)
    return { pid: p[0] ?? '', name: p[1] ?? '', mem: p[2] ? Math.round(Number(p[2]) / 1024) : '', cpu: p[3] ?? '' }
  }).filter((r) => r.pid && r.name)
}

async function refreshStaticMac(): Promise<void> {
  const [boardRaw, memRaw, gpuRaw, diskRaw, procRaw] = await Promise.all([
    execCmd('system_profiler SPHardwareDataType 2>/dev/null | grep -iE "Model Name|Model Identifier" | head -2'),
    execCmd('sysctl -n hw.memsize 2>/dev/null'),
    execCmd('system_profiler SPDisplaysDataType 2>/dev/null | grep -iE "Chipset Model" | head -2'),
    execCmd('df -h 2>/dev/null | head -12'),
    execCmd('ps -eo pid,comm,rss,pcpu -r 2>/dev/null | head -40')
  ])
  staticInfo.board = boardRaw.split(/\r?\n/).map((s) => s.replace(/^\s*\w+\s*:\s*/, '').trim()).filter(Boolean).join(' / ') || '未知'
  staticInfo.memDetail = []
  const mm = memRaw.trim()
  if (mm) staticInfo.memDetail.push({ capacity: String(Math.round(Number(mm) / 1024 / 1024 / 1024)) + 'GB', speed: '', manufacturer: 'Apple', type: '' })
  staticInfo.gpuInfo = gpuRaw.split(/\r?\n/).map((s) => s.replace(/^\s*\w+\s*:\s*/, '').trim()).filter(Boolean).map((s) => ({ name: s, vram: '', driver: '' }))
  staticInfo.devices = []
  staticInfo.disk = diskRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('\n')
  staticInfo.processes = procRaw.split(/\r?\n/).slice(1).map((s) => {
    const p = s.trim().split(/\s+/)
    return { pid: p[0] ?? '', name: p[1] ?? '', mem: p[2] ? Math.round(Number(p[2]) / 1024) : '', cpu: p[3] ?? '' }
  }).filter((r) => r.pid && r.name)
}

async function refreshStatic(): Promise<void> {
  try {
    if (os.platform() === 'win32') await refreshStaticWindows()
    else if (os.platform() === 'linux') await refreshStaticLinux()
    else await refreshStaticMac()
  } catch { /* 保留旧值 */ }
}

// ── GPU 使用率（所有 GPU）────────────────────────────────────
async function refreshGpuLoad(): Promise<void> {
  const loads: Array<{ name: string; load: number }> = []
  if (os.platform() === 'win32') {
    // 优先 nvidia-smi（含名称/显存/使用率）
    const nv = await execCmd('nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null || (echo __NO_NV__)')
    if (!/__NO_NV__/.test(nv) && nv.trim()) {
      for (const line of nv.split(/\r?\n/)) {
        const p = line.split(',').map((s) => s.trim())
        if (p.length >= 4) loads.push({ name: p[0], load: Math.min(100, Math.max(0, Number(p[1] ?? 0) || 0)) })
      }
    } else {
      // 通用 GPU Engine 计数器：按 luid 分组聚合各引擎使用率
      const raw = await execCmd(
        "powershell -NoProfile -Command \"(Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -EA SilentlyContinue).CounterSamples | Group-Object {($_.InstanceName -split '_')[3]} | ForEach-Object {[pscustomobject]@{load=[math]::Round(($_.Group|Measure-Object CookedValue -Sum).Sum)}} | ConvertTo-Json -Compress\""
      )
      if (raw.trim()) {
        try {
          const arr = JSON.parse(raw)
          const list: Array<{ load: number }> = Array.isArray(arr) ? arr : [arr]
          const names = staticInfo.gpuInfo.map((g) => String(g.name ?? '')).filter(Boolean)
          list.forEach((g, i) => {
            loads.push({ name: names[i] || ('GPU ' + (i + 1)), load: Math.min(100, Math.max(0, g.load ?? 0)) })
          })
        } catch { /* 保留旧值 */ }
      }
    }
  } else if (os.platform() === 'linux') {
    const nv = await execCmd('nvidia-smi --query-gpu=name,utilization.gpu --format=csv,noheader,nounits 2>/dev/null || (echo __NO_NV__)')
    if (!/__NO_NV__/.test(nv) && nv.trim()) {
      for (const line of nv.split(/\r?\n/)) {
        const p = line.split(',').map((s) => s.trim())
        if (p.length >= 2) loads.push({ name: p[0], load: Math.min(100, Math.max(0, Number(p[1] ?? 0) || 0)) })
      }
    }
  } else if (os.platform() === 'darwin') {
    // macOS 无通用 GPU 使用率接口，名称来自静态
    staticInfo.gpuInfo.forEach((g) => loads.push({ name: String(g.name ?? 'GPU'), load: 0 }))
  }
  if (loads.length) staticInfo.gpus = loads
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
  lastStatic = Date.now()
  void refreshStatic()
  void refreshGpuLoad()
  gpuLoadTimer = setInterval(() => void refreshGpuLoad(), 30_000)

  const tick = async (): Promise<void> => {
    if (stopped) return
    const now = Date.now()
    if (now - lastStatic > 30_000) {
      await refreshStatic()
      lastStatic = now
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
    try { emit({ deviceId: did, info, perf }) } catch { /* 忽略单次失败 */ }
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
