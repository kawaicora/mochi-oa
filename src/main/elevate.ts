/**
 * 跨平台管理员/root 提权：在需要高权限时弹出系统级授权提示。
 *
 * - Windows：用 PowerShell Start-Process -Verb RunAs 弹 UAC
 * - Linux：用 pkexec（桌面环境 Polkit），无桌面时退回 sudo
 * - macOS：用 osascript 弹系统授权对话框
 *
 * 用法：
 *   const r = await runElevated(['reg', 'add', ...])
 *   if (!r.ok) // 用户取消或失败
 */
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { writeFileSync, unlinkSync } from 'node:fs'

const execFileAsync = promisify(execFile)

export interface ElevatedResult {
  ok: boolean
  stdout?: string
  stderr?: string
  /** 用户取消了 UAC / 认证对话框 */
  cancelled?: boolean
  error?: string
}

/** 检查当前进程是否已有管理员/root 权限 */
export function isElevated(): boolean {
  if (process.platform === 'win32') {
    try {
      // net session 只有管理员能跑（用完整路径避免 PATH 缺失）
      const netExe = process.env.SystemRoot
        ? `${process.env.SystemRoot}\\System32\\net.exe`
        : 'net.exe'
      execFileSync(netExe, ['session'], { windowsHide: true, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  // Linux / macOS：uid 0 即 root
  return process.getuid?.() === 0
}

/**
 * 以管理员/root 权限执行命令。
 * 返回 Promise，不阻塞主进程。
 */
export async function runElevated(args: string[], opts?: { cwd?: string }): Promise<ElevatedResult> {
  if (process.platform === 'win32') return winElevated(args, opts)
  if (process.platform === 'darwin') return macElevated(args, opts)
  return linuxElevated(args, opts)
}

// ─── Windows：PowerShell Start-Process -Verb RunAs ──────
async function winElevated(args: string[], opts?: { cwd?: string }): Promise<ElevatedResult> {
  // 把命令包装成 PowerShell 脚本，用 -Verb RunAs 提权
  // Start-Process -Wait 等待结束，-PassThru 返回进程对象
  const quoted = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')
  const psScript = `
$p = Start-Process -FilePath '${args[0]}' -ArgumentList ${quoted} -Verb RunAs -Wait -PassThru -WindowStyle Hidden
exit $p.ExitCode
`.trim()
  try {
    await execFileAsync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
      cwd: opts?.cwd,
      windowsHide: true,
      timeout: 30000
    })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 用户点了"否"取消 UAC
    if (/cancel|操作已被用户取消|running this command/i.test(msg)) {
      return { ok: false, cancelled: true, error: '用户取消了管理员授权' }
    }
    return { ok: false, error: msg }
  }
}

// ─── Linux：pkexec（桌面 Polkit）/ sudo ──────────────────
async function linuxElevated(args: string[], opts?: { cwd?: string }): Promise<ElevatedResult> {
  // 优先 pkexec（有图形授权对话框）
  try {
    await execFileAsync('pkexec', args, { cwd: opts?.cwd, timeout: 30000 })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/authentication cancelled|没在策略中/i.test(msg)) {
      return { ok: false, cancelled: true, error: '用户取消了授权' }
    }
    // 没有 pkexec，退回 sudo
    try {
      await execFileAsync('sudo', args, { cwd: opts?.cwd, timeout: 30000 })
      return { ok: true }
    } catch (e2) {
      const msg2 = e2 instanceof Error ? e2.message : String(e2)
      return { ok: false, error: msg2 || msg }
    }
  }
}

// ─── macOS：osascript with administrator privileges ──────
async function macElevated(args: string[], opts?: { cwd?: string }): Promise<ElevatedResult> {
  // osascript -e 'do shell script "..." with administrator privileges'
  // 会弹出系统密码对话框
  const cmd = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' ')
  const cwdPart = opts?.cwd ? `cd "${opts.cwd}" && ` : ''
  const script = `do shell script "${cwdPart}${cmd.replace(/"/g, '\\"')}" with administrator privileges`
  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 30000 })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/User canceled|127/i.test(msg)) {
      return { ok: false, cancelled: true, error: '用户取消了授权' }
    }
    return { ok: false, error: msg }
  }
}

/**
 * 以管理员权限写注册表值（Windows 专用）。
 * 直接生成一个临时 .reg 文件并提权导入，比拼 reg.exe 命令更可靠。
 */
export async function winElevatedRegAdd(keyPath: string, valueName: string, valueData: string): Promise<ElevatedResult> {
  // 生成 .reg 文件内容
  const escapedKey = keyPath.replace(/\\/g, '\\\\')
  const regContent = `Windows Registry Editor Version 5.00\r\n\r\n[${escapedKey}]\r\n"${valueName}"="${valueData.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\r\n`
  const tmpFile = tmpdir() + '\\mochi-oa-elevate.reg'
  writeFileSync(tmpFile, regContent, 'utf8')
  // 提权导入 reg 文件
  const r = await runElevated(['reg', 'import', tmpFile])
  // 清理临时文件
  try { unlinkSync(tmpFile) } catch { /* 忽略 */ }
  return r
}

/** 以管理员权限删除注册表值（Windows 专用） */
export async function winElevatedRegDelete(keyPath: string, valueName: string): Promise<ElevatedResult> {
  return runElevated(['reg', 'delete', keyPath, '/v', valueName, '/f'])
}
