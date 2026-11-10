/**
 * 开机自启动：三个平台各用各的原生做法，不依赖第三方包。
 *
 * 为什么不用 Electron 的 app.setLoginItemSettings 一把梭：
 *   - Linux 上它是【空实现】（官方文档只支持 Windows/macOS），调了完全没反应；
 *   - Windows 上它写的是 HKCU 的 Run 键，但默认拿 process.execPath，开发模式下会把
 *     electron.exe 注册进去（开机启动一个空 Electron），且不好带自己的启动参数；
 *   - macOS 需要额外的 openAsHidden/args 处理。
 * 所以这里按平台自己实现，行为可预期、可自查：
 *   - Windows：HKCU\Software\Microsoft\Windows\CurrentVersion\Run 写一条 REG_SZ
 *              （直接用系统自带 reg.exe，能看到、能删、不引第三方依赖）
 *   - Linux：写 XDG 自启动项 ~/.config/autostart/mochi-oa.desktop（桌面环境登录后拉起）；
 *            有 systemd 用户会话时再顺手放一个 user unit 并 enable（无桌面/精简发行版也能自启）
 *   - macOS：Electron 官方 API（LaunchAgent / SMAppService），带 openAsHidden
 *
 * 三平台统一带 --hidden：开机静默启动到托盘，不弹窗打扰。
 */
import { app } from 'electron'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readBranding } from './branding'
import { runElevated, isElevated } from './elevate'

const execFileAsync = promisify(execFile)

/** 开机自启时附带的参数：静默启动（只进托盘，不弹窗） */
export const HIDDEN_ARG = '--hidden'

/** 注册表值名 / 自启动项名：固定 ASCII，避免中文在 reg.exe 与桌面环境里的编码差异 */
const ENTRY_NAME = 'MochiOA'

export interface AutoLaunchState {
  ok: boolean
  /** 当前是否已设为开机自启 */
  enabled: boolean
  /** 实际使用的方式（排查用）：windows-registry / linux-xdg-autostart / macos-login-item */
  method: string
  error?: string
}

export function autoLaunchMethod(): string {
  if (process.platform === 'win32') return 'windows-registry'
  if (process.platform === 'darwin') return 'macos-login-item'
  return 'linux-xdg-autostart'
}

/** 该用什么命令拉起自己。开发模式（未打包）跑的是 electron.exe，必须把工程目录一起带上 */
function launchCommand(): { exe: string; args: string[] } {
  if (app.isPackaged) return { exe: process.execPath, args: [HIDDEN_ARG] }
  return { exe: process.execPath, args: [app.getAppPath(), HIDDEN_ARG] }
}

// ─── Windows：注册表 Run 键 ──────────────────────────────
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const REG_EXE = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'reg.exe')
  : 'reg.exe'

async function winGet(): Promise<boolean> {
  console.log(`[auto-launch] winGet 查询注册表 ${REG_EXE} query ${WIN_RUN_KEY} /v ${ENTRY_NAME}`)
  try {
    const { stdout } = await execFileAsync(REG_EXE, ['query', WIN_RUN_KEY, '/v', ENTRY_NAME], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    const found = new RegExp(ENTRY_NAME, 'i').test(stdout)
    console.log(`[auto-launch] winGet 结果 found=${found}, stdout=${JSON.stringify(stdout.trim())}`)
    return found
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`[auto-launch] winGet 查询失败（值不存在）: ${msg}`)
    return false
  }
}

async function winSet(enabled: boolean): Promise<void> {
  const { exe, args } = launchCommand()
  const value = `"${exe}"${args.length ? ' ' + args.join(' ') : ''}`
  console.log(`[auto-launch] winSet enabled=${enabled}, exe=${exe}, args=${JSON.stringify(args)}, value=${value}`)
  if (enabled) {
    try {
      const { stdout } = await execFileAsync(REG_EXE, ['add', WIN_RUN_KEY, '/v', ENTRY_NAME, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 5000 })
      console.log(`[auto-launch] winSet 写入成功, stdout=${stdout}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const stderr = (e as { stderr?: string }).stderr
      console.warn(`[auto-launch] winSet 写入失败: ${msg}, stderr=${stderr}`)
      throw new Error(`HKCU 写入失败：${msg}`)
    }
    return
  }
  try {
    const { stdout } = await execFileAsync(REG_EXE, ['delete', WIN_RUN_KEY, '/v', ENTRY_NAME, '/f'], { windowsHide: true, timeout: 5000 })
    console.log(`[auto-launch] winSet 删除成功, stdout=${stdout}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`[auto-launch] winSet 删除失败（值不存在）: ${msg}`)
  }
}

// ─── Linux：XDG autostart（+ systemd 用户服务兜底）────────
function xdgAutostartFile(): string {
  const base = process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config')
  return join(base, 'autostart', `${ENTRY_NAME.toLowerCase()}.desktop`)
}

function systemdUserUnitFile(): string {
  const base = process.env['XDG_CONFIG_HOME']?.trim() || join(homedir(), '.config')
  return join(base, 'systemd', 'user', `${ENTRY_NAME.toLowerCase()}.service`)
}

function linuxGet(): boolean {
  return existsSync(xdgAutostartFile())
}

function linuxSet(enabled: boolean): void {
  const desktop = xdgAutostartFile()
  const unit = systemdUserUnitFile()
  const { exe, args } = launchCommand()
  const name = readBranding().name || '麻薯'

  if (!enabled) {
    try { if (existsSync(desktop)) rmSync(desktop, { force: true }) } catch { /* 忽略 */ }
    try {
      if (existsSync(unit)) {
        // 先 disable 再删文件，避免留下 enable 的软链
        try { execFileSync('systemctl', ['--user', 'disable', `${ENTRY_NAME.toLowerCase()}.service`], { timeout: 5000 }) } catch { /* 没有 systemd 会话 */ }
        rmSync(unit, { force: true })
      }
    } catch { /* 忽略 */ }
    console.log('[auto-launch] 已关闭 Linux 开机自启')
    return
  }

  // 1) XDG 自启动项：所有桌面环境（GNOME/KDE/XFCE…）登录后都会执行
  mkdirSync(dirname(desktop), { recursive: true })
  writeFileSync(
    desktop,
    [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${name}`,
      `Comment=${name} 开机自启（静默启动到托盘）`,
      `Exec="${exe}"${args.length ? ' ' + args.join(' ') : ''}`,
      'Terminal=false',
      'StartupNotify=false',
      'X-GNOME-Autostart-enabled=true',
      ''
    ].join('\n'),
    'utf-8'
  )
  console.log(`[auto-launch] 已写入 XDG 自启动项：${desktop}`)

  // 2) systemd 用户服务兜底：没有桌面环境（纯 systemd）时靠它
  try {
    mkdirSync(dirname(unit), { recursive: true })
    writeFileSync(
      unit,
      [
        '[Unit]',
        `Description=${name}`,
        'After=graphical-session.target network-online.target',
        'Wants=network-online.target',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart="${exe}"${args.length ? ' ' + args.join(' ') : ''}`,
        'Restart=on-failure',
        'RestartSec=5',
        '',
        '[Install]',
        'WantedBy=graphical-session.target',
        ''
      ].join('\n'),
      'utf-8'
    )
    execFileSync('systemctl', ['--user', 'daemon-reload'], { timeout: 5000 })
    execFileSync('systemctl', ['--user', 'enable', `${ENTRY_NAME.toLowerCase()}.service`], { timeout: 5000 })
    console.log(`[auto-launch] 已注册 systemd 用户服务：${unit}`)
  } catch (e) {
    // 没有 systemd 用户会话（容器/精简发行版）→ 只靠 XDG 自启动项，不算失败
    console.log(`[auto-launch] systemd 用户服务注册跳过：${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── macOS：Electron 官方登录项 ───────────────────────────
function macGet(): boolean {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

function macSet(enabled: boolean): void {
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: [HIDDEN_ARG]
  })
  console.log(`[auto-launch] macOS 登录项 openAtLogin=${enabled}`)
}

// ─── 对外 API ────────────────────────────────────────────
export async function getAutoLaunch(): Promise<AutoLaunchState> {
  console.log(`[auto-launch] getAutoLaunch 开始, platform=${process.platform}`)
  try {
    let enabled: boolean
    if (process.platform === 'win32') {
      enabled = await winGet()
    } else if (process.platform === 'darwin') {
      enabled = macGet()
    } else {
      enabled = linuxGet()
    }
    console.log(`[auto-launch] getAutoLaunch 结果 enabled=${enabled}`)
    return { ok: true, enabled, method: autoLaunchMethod() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[auto-launch] getAutoLaunch 失败: ${msg}`)
    return { ok: false, enabled: false, method: autoLaunchMethod(), error: msg }
  }
}

export async function setAutoLaunch(enabled: boolean): Promise<AutoLaunchState> {
  console.log(`[auto-launch] setAutoLaunch 开始, enabled=${enabled}, platform=${process.platform}`)
  try {
    if (process.platform === 'win32') {
      try {
        await winSet(enabled)
      } catch (e) {
        // HKCU 失败 → 提权重试
        console.warn(`[auto-launch] 直接写入失败，请求管理员权限：${e instanceof Error ? e.message : e}`)
        const { exe, args } = launchCommand()
        const value = `"${exe}"${args.length ? ' ' + args.join(' ') : ''}`
        if (enabled) {
          const r = await runElevated([REG_EXE, 'add', WIN_RUN_KEY, '/v', ENTRY_NAME, '/t', 'REG_SZ', '/d', value, '/f'])
          console.log(`[auto-launch] 提权写入结果: ok=${r.ok}, cancelled=${r.cancelled}, error=${r.error}`)
          if (!r.ok && !r.cancelled) throw new Error(r.error || '提权写入失败')
        } else {
          const r = await runElevated([REG_EXE, 'delete', WIN_RUN_KEY, '/v', ENTRY_NAME, '/f'])
          console.log(`[auto-launch] 提权删除结果: ok=${r.ok}, cancelled=${r.cancelled}, error=${r.error}`)
          if (!r.ok && !r.cancelled) throw new Error(r.error || '提权删除失败')
        }
      }
    } else if (process.platform === 'darwin') {
      macSet(enabled)
    } else {
      linuxSet(enabled)
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[auto-launch] setAutoLaunch 失败 enabled=${enabled}：${msg}`)
    return { ok: false, enabled: false, method: autoLaunchMethod(), error: msg }
  }
  // 写完后回读，确认真的生效
  const result = await getAutoLaunch()
  console.log(`[auto-launch] setAutoLaunch 完成, 最终 enabled=${result.enabled}`)
  return result
}

/** 当前进程是否由「开机自启」拉起（启动参数带 --hidden） */
export function launchedHidden(): boolean {
  return process.argv.includes(HIDDEN_ARG)
}

/** 是否真的存在自启动项文件（供 Linux/macOS 排查用） */
export function autoLaunchEntryPath(): string {
  if (process.platform === 'linux') return xdgAutostartFile()
  return ''
}

/** 读取自启动项文件内容（排查用，没有返回空串） */
export function readAutoLaunchEntry(): string {
  const p = autoLaunchEntryPath()
  if (!p || !existsSync(p)) return ''
  try {
    return readFileSync(p, 'utf-8')
  } catch {
    return ''
  }
}
