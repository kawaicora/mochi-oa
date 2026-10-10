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
import { any } from 'three/tsl';

// systeminformation 是 CommonJS 包，方法挂在 module.exports 上；ESM 的 import * as / default 在打包后
// 都可能取不到方法（此前 import * as 与 import default 均导致 si.motherboard is not a function）。
// 主进程是 Node 环境，直接用 require 拿 module.exports 最稳。d.ts 仅声明命名空间接口，此处显式声明形状。

const si:any = require("systeminformation");
export interface SysReportPayload {
  deviceId: string
  info: Record<string, unknown>
  perf: Record<string, unknown>
}

let timer: NodeJS.Timeout | null = null
let stopped = false


let mb: { manufacturer: string; model: string } | undefined
let memLayout: {
    size?: number | undefined;
    clockSpeed?: number | undefined;
    type?: string | undefined;
    manufacturer?: string | undefined;
}[] | undefined
let graphics: {
  controllers: {
  vendor?: string | undefined;
  model?: string | undefined;
  vram?: number | undefined;
  driverVersion?: string | undefined;
  utilizationGpu?: number | undefined;
  }[];
} | undefined
let disks:{
    device: string ,
    type: string ,
    name: string ,
    vendor: string,
    size: number,
    bytesPerSector: number,
    totalCylinders: number,
    totalHeads: number,
    totalSectors: number,
    totalTracks: number,
    tracksPerCylinder: number,
    sectorsPerTrack: number,
    firmwareRevision: string,
    serialNum: string,
    interfaceType: string,
    smartStatus: string,

}[] | undefined
let nets: {
iface?: string | undefined;
mac?: string | undefined;
ip4?: string | undefined;
operstate?: string | undefined;
}[] | undefined
let fsSizes: {
  mount?: string | undefined;
  used?: number | undefined;
  size?: number | undefined;
  use?: number | undefined;
  }[] | undefined
let devices:any = null
let procs: {
  all: {
  pid?: number | undefined;
  name?: string | undefined;
  cpu?: number | undefined;
  mem_rss?: number | undefined;
  }[];
  } | undefined
let data:any = null
let isStartGetData: boolean = false
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
  const nets = os.networkInterfaces() || {}
  const out: Array<{ name: string; address: string; internal: boolean }> = []
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n && n.family === 'IPv4') out.push({ name, address: n.address, internal: !!n.internal })
    }
  }
  return out
}

function getStaticData(callback?: (data: any) => void): Promise<any> {
  return new Promise((resolve) => {
    process.nextTick(() => {
      const data:any = {};

      data.version = si.version();

      Promise.all([
        si.system(),
        si.bios(),
        si.baseboard(),
        si.chassis(),
        si.osInfo(),
        si.uuid(),
        si.versions(),
        si.cpu(),
        si.cpuFlags(),
        si.graphics(),
        si.networkInterfaces(),
        si.memLayout(),
        si.diskLayout(),
        si.audio(),
        si.bluetoothDevices(),
        si.usb(),
        si.printer(),
        si.fsSize()
      ]).then((res) => {
        data.system = res[0];
        data.bios = res[1];
        data.baseboard = res[2];
        data.chassis = res[3];
        data.os = res[4];
        data.uuid = res[5];
        data.versions = res[6];
        data.cpu = res[7];
        data.cpu.flags = res[8];
        data.graphics = res[9];
        data.net = res[10];
        data.memLayout = res[11];
        data.diskLayout = res[12];
        data.audio = res[13];
        data.bluetooth = res[14];
        data.usb = res[15];
        data.printer = res[16];
        data.fsSize = res[17];
        if (callback) {
          callback(data);
        }
        resolve(data);
      });
    });
  });
}
// ── 静态硬件缓存──────────────────────────
let staticInfo: {
  board: string
  memDetail: Array<Record<string, unknown>>
  gpuInfo: Array<Record<string, unknown>>
  disk: string
  fs: Array<{ mount: string; used: number; size: number; use: number }>
  processes: Array<Record<string, unknown>>
  gpus: Array<{ name: string; load: number }>
} = { board: '未知', memDetail: [], gpuInfo: [], disk: '', fs: [], processes: [], gpus: [] }
let lastStatic = 0
let gpuLoadTimer: NodeJS.Timeout | null = null

function gpuName(c: { vendor?: string; model?: string }): string {
  return [c.vendor, c.model].filter(Boolean).join(' ').trim() || 'GPU'
}
let isTryGetStaticData: boolean = false
async function refreshStatic(): Promise<void> {
  try {
    if (!isTryGetStaticData) {
      isTryGetStaticData = true
      getStaticData((res:any) => {
        // Handle the static data
        data = res;
      })
    }
    
    
    if(data === null) {
      console.info(`数据未准备好，等待下一次刷新`)
      return
    }
      mb = data.baseboard;
      memLayout = data.memLayout;
      graphics = data.graphics;
      disks = data.diskLayout;
      nets = data.networkInterfaces;
      fsSizes = data.fsSize;
      procs = data.processes;
      staticInfo.board = mb ? ([mb.manufacturer, mb.model].filter(Boolean).join(' ').trim() || '未知') : staticInfo.board
      if (memLayout) {
        staticInfo.memDetail = memLayout.map((m) => ({
          capacity: m.size ? Math.round(m.size / 1e9) + 'GB' : '',
          speed: m.clockSpeed ? String(m.clockSpeed) + 'MHz' : '',
          manufacturer: m.manufacturer || '',
          type: m.type || ''
        }))
      }
      if (graphics && graphics.controllers) {
        staticInfo.gpuInfo = graphics.controllers.map((c) => ({
          name: gpuName(c),
          vram: c.vram ? c.vram + 'GB' : '',
          driver: c.driverVersion || ''
        }))
        staticInfo.gpus = graphics.controllers.map((c) => ({
          name: gpuName(c),
          load: c.utilizationGpu != null ? Math.min(100, Math.max(0, Math.round(c.utilizationGpu))) : 0
        }))
      }
      
      if (fsSizes) {
        staticInfo.disk = fsSizes.map((f) => `${f.mount}: ${Math.round((f.used ?? 0) / 1e9)}GB/${Math.round((f.size ?? 0) / 1e9)}GB(${f.use || 0}%)`).join('\n')
        staticInfo.fs = fsSizes.map((f) => ({ mount: f.mount || '', used: f.used || 0, size: f.size || 0, use: f.use || 0 }))
      }
      if (procs && procs.all) {
        staticInfo.processes = procs.all.slice().sort((a, b) => (b.mem_rss || 0) - (a.mem_rss || 0)).slice(0, 40).map((p) => ({
          pid: p.pid,
          name: p.name || '',
          mem: p.mem_rss ? Math.round(p.mem_rss / 1e6) : 0,
          cpu: p.cpu != null ? Math.round(p.cpu) : 0
        }))
      }
  } catch (e) {
    console.error(`[sys-report] refreshStatic 异常: ${e instanceof Error ? e.message : String(e)}`)
  }
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
  const baseInfoUpdateCDTime = 30 * 1_000
  const tickUpdateCDTime = 1 * 1_000
  

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const now = Date.now()
      void refreshStatic()
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
        disk: staticInfo.disk,
        fs: staticInfo.fs,
        processes: staticInfo.processes
      }
      const perf: Record<string, unknown> = {
        cpu: cpuUsage(),
        memPercent: totalMem > 0 ? Math.max(0, Math.round(100 * (totalMem - free) / totalMem)) : 0,
        memUsed: totalMem - free,
        memTotal: totalMem,
        gpus: staticInfo.gpus
      }
      try { emit({ deviceId: did, info, perf }) } catch (e) { console.error(`[sys-report] emit 失败: ${e instanceof Error ? e.message : String(e)}`) }
    } catch (e) {
      console.error(`[sys-report] tick 异常: ${e instanceof Error ? e.message + '\n' + (e.stack ?? '') : String(e)}`)
    }
  }

  void tick()
  timer = setInterval(() => void tick(), tickUpdateCDTime)
}

export function stopSysReport(): void {
  stopped = true
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
