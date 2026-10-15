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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readBranding } from './branding'

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

function winGet(): boolean {
  try {
    const out = execFileSync('reg', ['query', WIN_RUN_KEY, '/v', ENTRY_NAME], { encoding: 'utf8', windowsHide: true })
    return new RegExp(ENTRY_NAME, 'i').test(out)
  } catch {
    // 值不存在时 reg query 返回非 0 退出码
    return false
  }
}

function winSet(enabled: boolean): void {
  if (enabled) {
    const { exe, args } = launchCommand()
    // 值形如："C:\path\app.exe" --hidden（路径带空格必须加引号，否则开机启动会失败）
    const value = `"${exe}"${args.length ? ' ' + args.join(' ') : ''}`
    execFileSync('reg', ['add', WIN_RUN_KEY, '/v', ENTRY_NAME, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true })
    console.log(`[auto-launch] 已写入注册表 Run：${ENTRY_NAME} = ${value}`)
    return
  }
  try {
    execFileSync('reg', ['delete', WIN_RUN_KEY, '/v', ENTRY_NAME, '/f'], { windowsHide: true })
    console.log(`[auto-launch] 已删除注册表 Run：${ENTRY_NAME}`)
  } catch {
    // 本来就没有 → 视为已关闭
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
export function getAutoLaunch(): AutoLaunchState {
  try {
    const enabled = process.platform === 'win32' ? winGet() : process.platform === 'darwin' ? macGet() : linuxGet()
    return { ok: true, enabled, method: autoLaunchMethod() }
  } catch (e) {
    return { ok: false, enabled: false, method: autoLaunchMethod(), error: e instanceof Error ? e.message : String(e) }
  }
}

export function setAutoLaunch(enabled: boolean): AutoLaunchState {
  try {
    if (process.platform === 'win32') winSet(enabled)
    else if (process.platform === 'darwin') macSet(enabled)
    else linuxSet(enabled)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error(`[auto-launch] 设置失败 enabled=${enabled}：${msg}`)
    return { ok: false, enabled: false, method: autoLaunchMethod(), error: msg }
  }
  // 写完后回读，确认真的生效（注册表被策略拦/自启动文件没权限时能立刻发现）
  return getAutoLaunch()
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
