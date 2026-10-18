/**
 * 系统代理设置/断开（三平台）。
 * Windows：写注册表 HKCU\...\Internet Settings + cmdkey 存凭据到 Credential Manager + 广播 WM_SETTINGCHANGE。
 *   注册表 ProxyServer 不支持内嵌 user:pass，凭据走 Credential Manager（WinInet/浏览器自动用）。
 * macOS：networksetup -setwebproxy / -setwebproxystate（无凭据参数，限制见文件尾注释）。
 * Linux：gsettings org.gnome.system.proxy（无凭据参数）。
 */
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(exec)

export interface ProxyTarget { host: string; port: number; username?: string; password?: string }

/** 设置系统 HTTP 代理。Windows 用注册表+cmdkey；macOS/Linux 用命令行。 */
export async function setSystemProxy(t: ProxyTarget): Promise<{ ok: boolean; error?: string }> {
  const host = (t.host || '').trim()
  const port = Number(t.port)
  if (!host || !port) return { ok: false, error: '代理地址不完整' }
  try {
    if (process.platform === 'win32') {
      const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
      await execAsync(`reg add "${base}" /v ProxyEnable /t REG_DWORD /d 1 /f`)
      await execAsync(`reg add "${base}" /v ProxyServer /t REG_SZ /d "${host}:${port}" /f`)
      await execAsync(`reg add "${base}" /v AutoConfigURL /t REG_SZ /d "" /f`)
      // 凭据写入 Credential Manager（WinInet 自动用；注册表 ProxyServer 不支持内嵌 user:pass）
      if (t.username && t.password) {
        const target = `${host}:${port}`
        await execAsync(`cmdkey /add:${target} /user:${t.username} /pass:${t.password}`)
        console.log(`[system-proxy] Credential Manager 已写入 ${target} 用户=${t.username}`)
      }
      // 广播 WM_SETTINGCHANGE 让系统立即生效
      await execAsync(`powershell -Command "Add-Type -Namespace Win32 -Name NativeMethods -Definition '[DllImport(\\\"user32.dll\\\")] public static extern bool SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'; $HWND_BROADCAST=[IntPtr]0xffff; $WM_SETTINGCHANGE=0x1A; $r=[UIntPtr]::Zero; [Win32.NativeMethods]::SendMessageTimeout($HWND_BROADCAST,$WM_SETTINGCHANGE,[UIntPtr]::Zero,'Internet Settings',2,5000,[ref]$r) | Out-Null"`)
      return { ok: true }
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execAsync('networksetup -listallnetworkservices')
      const svc = stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('*'))[0] || 'Wi-Fi'
      await execAsync(`networksetup -setwebproxy "${svc}" ${host} ${port}`)
      await execAsync(`networksetup -setsecurewebproxy "${svc}" ${host} ${port}`)
      await execAsync(`networksetup -setwebproxystate "${svc}" on`)
      // 注：networksetup 不支持代理凭据，若服务端代理需鉴权，浏览器会弹登录框或 407。
      // 可备选 security add-internet-password 存 Keychain，但系统代理不会自动读，限制如实记录。
      return { ok: true }
    }
    // linux
    await execAsync(`gsettings set org.gnome.system.proxy mode 'manual'`)
    await execAsync(`gsettings set org.gnome.system.proxy.http host '${host}'`)
    await execAsync(`gsettings set org.gnome.system.proxy.http port ${port}`)
    await execAsync(`gsettings set org.gnome.system.proxy.https host '${host}'`)
    await execAsync(`gsettings set org.gnome.system.proxy.https port ${port}`)
    // 注：gsettings 无代理凭据字段，鉴权代理需本地转发方案。
    return { ok: true }
  } catch (e) {
    console.error('[system-proxy] 设置失败', e)
    return { ok: false, error: String(e) }
  }
}

/** 断开系统代理（恢复直连 + 清凭据）。 */
export async function clearSystemProxy(t?: { host?: string; port?: number }): Promise<{ ok: boolean; error?: string }> {
  try {
    if (process.platform === 'win32') {
      const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
      await execAsync(`reg add "${base}" /v ProxyEnable /t REG_DWORD /d 0 /f`)
      // 清 Credential Manager 凭据
      if (t?.host && t?.port) {
        try { await execAsync(`cmdkey /delete:${t.host}:${t.port}`) } catch { /* 可能本就不存在 */ }
      }
      return { ok: true }
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execAsync('networksetup -listallnetworkservices')
      const svc = stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('*'))[0] || 'Wi-Fi'
      await execAsync(`networksetup -setwebproxystate "${svc}" off`)
      await execAsync(`networksetup -setsecurewebproxystate "${svc}" off`)
      return { ok: true }
    }
    await execAsync(`gsettings set org.gnome.system.proxy mode 'none'`)
    return { ok: true }
  } catch (e) {
    console.error('[system-proxy] 断开失败', e)
    return { ok: false, error: String(e) }
  }
}
