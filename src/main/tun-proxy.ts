/**
 * TUN 全局代理（sing-box）：创建虚拟网卡接管全部流量（含 UDP，解决游戏/授权不走代理的流量）。
 * 三端支持：Windows/Linux/macOS，二进制随包内置（resources/sing-box/<plat>-<arch>/）。
 * 需要管理员/root 权限创建 TUN 网卡与自动路由：
 *   - Windows：若当前非 elevated，用 Start-Process -Verb RunAs 提权启动（触发 UAC）；停止用 taskkill。
 *   - macOS：用 osascript administrator privileges 提权。
 *   - Linux：要求以 root/sudo 运行客户端；否则尝试 pkexec。
 */
import { spawn, ChildProcess } from 'node:child_process'
import { writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export interface TunTarget { host: string; port: number; username?: string; password?: string }

let tunProc: ChildProcess | null = null
let tunConfigPath = ''
let tunExePath = ''

/** 定位当前平台 sing-box 二进制。打包后从 process.resourcesPath/sing-box 取；开发态从 resources/sing-box 取。 */
function resolveSingBox(): string | null {
  const plat = process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const base = (appResourcesPath())
  let verDir = 'sing-box-1.14.3-' + plat + '-' + arch
  const candidates = [
    path.join(base, 'sing-box', `${plat}-${arch}`, verDir),
    path.join(base, 'sing-box', `${plat}-${arch}`),
    path.join(base, 'sing-box'),
  ]
  for (const d of candidates) {
    const exe = path.join(d, plat === 'win32' ? 'sing-box.exe' : 'sing-box')
    console.log("try get singbox path: " + exe)
    if (existsSync(exe)) { return exe }
  }
  return null
}
function appResourcesPath(): string {
  try {
    if (typeof process !== 'undefined' && (process as any).resourcesPath) { return (process as any).resourcesPath }
  } catch { /* ignore */ }
  return path.join(process.cwd(), 'resources')
}

/** 生成 sing-box TUN 配置：TUN inbound（auto_route 接管全流量含 UDP）+ http 出站指向服务端代理。 */
function buildConfig(t: TunTarget): string {
  const tunAddr = ['172.19.0.1/30']
  return JSON.stringify({
    log: { level: 'info' },
    inbounds: [
      { type: 'tun', tag: 'tun-in', address: tunAddr, auto_route: true, strict_route: true, stack: 'system', mtu: 1500 }
    ],
    outbounds: [
      { type: 'http', tag: 'proxy', server: t.host, server_port: Number(t.port), username: t.username || '', password: t.password || '' },
      { type: 'direct', tag: 'direct' }
    ],
    route: { final: 'proxy', auto_detect_interface: true }
  }, null, 2)
}

/** 启动 TUN 全局代理。Windows 提权（UAC），macOS 提权（osascript），Linux 需 root。 */
export async function startTunProxy(t: TunTarget): Promise<{ ok: boolean; error?: string }> {
  const host = (t.host || '').trim()
  const port = Number(t.port)
  if (!host || !port) return { ok: false, error: '代理地址不完整' }

  stopTunProxy() // 先停旧的

  const exe = resolveSingBox()
  if (!exe) return { ok: false, error: '未找到内置 sing-box 二进制，请确认随包资源完整' }
  tunExePath = exe

  // 配置文件写到临时目录
  const confDir = path.join(os.tmpdir(), 'mochi-tun')
  if (!existsSync(confDir)) mkdirSync(confDir, { recursive: true })
  tunConfigPath = path.join(confDir, 'config.json')
  writeFileSync(tunConfigPath, buildConfig({ host, port, username: t.username, password: t.password }), 'utf8')

  // Linux 需可执行位
  if (process.platform !== 'win32') { try { chmodSync(exe, 0o755) } catch { /* ignore */ } }

  try {
    if (process.platform === 'win32') {
      const elevated = await spawnElevatedWindows(exe, ['run', '-c', tunConfigPath])
      return elevated
    }
    if (process.platform === 'darwin') {
      return await spawnElevatedMac(exe, ['run', '-c', tunConfigPath])
    }
    // Linux：直接 spawn；若无 root 权限，TUN 网卡创建失败会立即报错
    return await spawnDirect(exe, ['run', '-c', tunConfigPath])
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** Windows：若当前非 elevated，用 Start-Process -Verb RunAs 提权（UAC）；否则直接 spawn。 */
function spawnElevatedWindows(exe: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const { execFile } = require('node:child_process') as typeof import('node:child_process')
    execFile('net', ['session'], (err) => {
      const isAdmin = !err
      if (isAdmin) {
        resolve(spawnDirect(exe, args))
        return
      }
      // 非 admin：提权启动（UAC），进程由用户确认；停止用 taskkill
      const argStr = [exe, ...args].map((a) => `"${a.replace(/"/g, '""')}"`).join(' ')
      const { exec } = require('node:child_process') as typeof import('node:child_process')
      exec(`powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList 'run','-c','${tunConfigPath.replace(/'/g, "''")}'"`, (e) => {
        if (e) { console.error('[tun] 提权启动失败（用户可能取消 UAC）', e); resolve({ ok: false, error: '提权启动失败：' + e.message }) }
        else { console.log('[tun] 已发起 UAC 提权启动 sing-box'); resolve({ ok: true }) }
      })
    })
  })
}

/** macOS：用 osascript 以管理员权限运行。 */
function spawnElevatedMac(exe: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const argStr = [exe, ...args].map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')
    const { exec } = require('node:child_process') as typeof import('node:child_process')
    exec(`osascript -e 'do shell script "${argStr}" with administrator privileges'`, (e) => {
      if (e) { console.error('[tun] macOS 提权失败', e); resolve({ ok: false, error: 'macOS 提权失败：' + e.message }) }
      else { console.log('[tun] macOS sing-box 已提权启动'); resolve({ ok: true }) }
    })
  })
}

/** 直接 spawn 并保持句柄（Linux 直连、Windows 已 admin）。 */
function spawnDirect(exe: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const p = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let errBuf = ''
    p.stderr?.on('data', (d) => { errBuf += String(d) })
    p.once('error', (e) => { console.error('[tun] sing-box 启动失败', e, errBuf); resolve({ ok: false, error: 'sing-box 启动失败：' + e.message + (errBuf ? ' / ' + errBuf.slice(0, 200) : '') }) })
    setTimeout(() => {
      if (p.exitCode !== null && p.exitCode !== 0) { resolve({ ok: false, error: 'sing-box 退出码 ' + p.exitCode + (errBuf ? '：' + errBuf.slice(0, 200) : '') }); return }
      if (p.exitCode === 0) { resolve({ ok: false, error: 'sing-box 立即退出' + (errBuf ? '：' + errBuf.slice(0, 200) : '') }); return }
      tunProc = p
      console.log('[tun] sing-box TUN 已启动 pid=' + p.pid)
      resolve({ ok: true })
    }, 1500)
    p.once('exit', () => { if (tunProc === p) tunProc = null })
  })
}

/** 停止 TUN 代理：kill sing-box（Windows 用 taskkill，含提权启动的无句柄进程）。 */
export async function stopTunProxy(): Promise<{ ok: boolean; error?: string }> {
  try {
    if (process.platform === 'win32') {
      const { execFile } = require('node:child_process') as typeof import('node:child_process')
      await new Promise<void>((res) => { execFile('taskkill', ['/IM', 'sing-box.exe', '/F'], () => res()) })
    } else {
      tunProc?.kill('SIGTERM')
    }
    tunProc = null
    if (tunConfigPath && existsSync(tunConfigPath)) { try { rmSync(tunConfigPath, { force: true }) } catch { /* ignore */ } }
    console.log('[tun] 已停止 TUN 代理')
    return { ok: true }
  } catch (e) {
    console.error('[tun] 停止失败', e)
    return { ok: false, error: String(e) }
  }
}

export function getTunActive(): boolean { return !!tunProc }
