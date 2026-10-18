/**
 * 系统代理设置/断开（三平台）。
 * Windows：写注册表 HKCU\...\Internet Settings + cmdkey 存凭据到 Credential Manager + 广播 WM_SETTINGCHANGE。
 *   注册表 ProxyServer 不支持内嵌 user:pass，凭据走 Credential Manager（WinInet/浏览器自动用）。
 *   设置前备份原值，任一步失败回滚，绝不能留下 ProxyEnable=1+失效代理导致离线。
 * macOS：networksetup -setwebproxy / -setwebproxystate（无凭据参数，限制见文件尾注释）。
 * Linux：gsettings org.gnome.system.proxy（无凭据参数）。
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface ProxyTarget { host: string; port: number; username?: string; password?: string }

const REG_BASE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 读注册表当前 ProxyEnable/ProxyServer/AutoConfigURL（设置前备份） */
async function backupWinReg(): Promise<{ enable: number; server: string; autoConfig: string }> {
  try {
    const { stdout } = await execAsync(`reg query "${REG_BASE}" /v ProxyEnable & reg query "${REG_BASE}" /v ProxyServer & reg query "${REG_BASE}" /v AutoConfigURL`)
    const get = (name: string): string => {
      const m = stdout.match(new RegExp(name + '\\s+REG_(?:SZ|DWORD)\\s+(.+)', 'i'))
      return m ? m[1].trim() : ''
    }
    return { enable: Number(get('ProxyEnable')) || 0, server: get('ProxyServer'), autoConfig: get('AutoConfigURL') }
  } catch { return { enable: 0, server: '', autoConfig: '' } }
}

/** 恢复注册表到备份值 */
async function restoreWinReg(b: { enable: number; server: string; autoConfig: string }): Promise<void> {
  try {
    await execAsync(`reg add "${REG_BASE}" /v ProxyEnable /t REG_DWORD /d ${b.enable} /f`)
    if (b.server) await execAsync(`reg add "${REG_BASE}" /v ProxyServer /t REG_SZ /d "${b.server}" /f`)
    if (b.autoConfig) await execAsync(`reg add "${REG_BASE}" /v AutoConfigURL /t REG_SZ /d "${b.autoConfig}" /f`)
    console.log(`[system-proxy] 注册表已还原：ProxyEnable=${b.enable} ProxyServer=${b.server}`)
  } catch (e) { console.error('[system-proxy] 注册表还原失败', e) }
}

/** 设置系统 HTTP 代理。Windows 用注册表+cmdkey；macOS/Linux 用命令行。 */
export async function setSystemProxy(t: ProxyTarget): Promise<{ ok: boolean; error?: string }> {
  const host = (t.host || '').trim()
  const port = Number(t.port)
  if (!host || !port) return { ok: false, error: '代理地址不完整' }
  if (process.platform !== 'win32') {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execAsync('networksetup -listallnetworkservices')
        const svc = stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('*'))[0] || 'Wi-Fi'
        const u = t.username ? `-u "${t.username}"` : ''
        const p = t.password ? `-p "${t.password}"` : ''
        await execAsync(`networksetup -setwebproxy "${svc}" ${host} ${port} ${u} ${p}`.trim())
        await execAsync(`networksetup -setsecurewebproxy "${svc}" ${host} ${port} ${u} ${p}`.trim())
        await execAsync(`networksetup -setwebproxystate "${svc}" on`)
      } else {
        await execAsync(`gsettings set org.gnome.system.proxy mode 'manual'`)
        await execAsync(`gsettings set org.gnome.system.proxy.http host '${host}'`)
        await execAsync(`gsettings set org.gnome.system.proxy.http port ${port}`)
        // 环境变量凭据（终端/多数 CLI 应用生效；GUI 应用限制见文件尾注释）
        const cred = t.username ? `${encodeURIComponent(t.username)}:${encodeURIComponent(t.password || '')}@` : ''
        console.log(`[system-proxy] Linux: 提示用户设置环境变量 http_proxy=http://${cred}${host}:${port}`)
      }
      return { ok: true }
    } catch (e) { return { ok: false, error: String(e) } }
  }

  // Windows：备份 → 逐步设置 → 失败回滚
  const backup = await backupWinReg()
  console.log(`[system-proxy] 设置前备份：ProxyEnable=${backup.enable} ProxyServer=${backup.server}`)
  try {
    await execAsync(`reg add "${REG_BASE}" /v ProxyEnable /t REG_DWORD /d 1 /f`)
    await execAsync(`reg add "${REG_BASE}" /v ProxyServer /t REG_SZ /d "${host}:${port}" /f`)
    await execAsync(`reg add "${REG_BASE}" /v AutoConfigURL /t REG_SZ /d "" /f`)
    console.log(`[system-proxy] 注册表写入：ProxyEnable=1 ProxyServer=${host}:${port}`)

    if (t.username && t.password) {
      const target = `${host}:${port}`
      await execAsync(`cmdkey /add:${target} /user:${t.username} /pass:${t.password}`)
      console.log(`[system-proxy] Credential Manager 已写入 ${target} 用户=${t.username}`)
    }

    // 广播 WM_SETTINGCHANGE（PS 5.1 用 -MemberDefinition，避免引号地狱）
    await execAsync(
      `powershell -NoProfile -Command "$sig='[DllImport(\\"user32.dll\\")] public static extern bool SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition $sig; $HWND_BROADCAST=[IntPtr]0xffff; $WM_SETTINGCHANGE=0x1A; $r=[UIntPtr]::Zero; [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST,$WM_SETTINGCHANGE,[UIntPtr]::Zero,'Internet Settings',2,5000,[ref]$r) | Out-Null"`
    )
    console.log(`[system-proxy] 设置成功 ${host}:${port}`)
    return { ok: true }
  } catch (e) {
    console.error('[system-proxy] 设置失败，回滚中：', e)
    await restoreWinReg(backup)
    if (t.username && t.password) {
      try { await execAsync(`cmdkey /delete:${host}:${port}`) } catch { /* ignore */ }
    }
    return { ok: false, error: String(e) }
  }
}

/** 断开系统代理（恢复直连 + 清凭据 + 还原 ProxyServer 原值）。 */
export async function clearSystemProxy(t?: { host?: string; port?: number }): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    try {
      if (process.platform === 'darwin') {
        const { stdout } = await execAsync('networksetup -listallnetworkservices')
        const svc = stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('*'))[0] || 'Wi-Fi'
        await execAsync(`networksetup -setwebproxystate "${svc}" off`)
        await execAsync(`networksetup -setsecurewebproxystate "${svc}" off`)
      } else {
        await execAsync(`gsettings set org.gnome.system.proxy mode 'none'`)
      }
      return { ok: true }
    } catch (e) { return { ok: false, error: String(e) } }
  }
  try {
    await execAsync(`reg add "${REG_BASE}" /v ProxyEnable /t REG_DWORD /d 0 /f`)
    // 清掉 ProxyServer 残留地址（用户曾发现 ProxyEnable=0 但 ProxyServer 残留导致重启后异常）
    await execAsync(`reg add "${REG_BASE}" /v ProxyServer /t REG_SZ /d "" /f`)
    await execAsync(`reg add "${REG_BASE}" /v AutoConfigURL /t REG_SZ /d "" /f`)
    if (t?.host && t?.port) {
      try { await execAsync(`cmdkey /delete:${t.host}:${t.port}`) } catch { /* ignore */ }
    }
    console.log('[system-proxy] 已断开并清空 ProxyServer/AutoConfigURL 残留')
    return { ok: true }
  } catch (e) {
    console.error('[system-proxy] 断开失败', e)
    return { ok: false, error: String(e) }
  }
}
