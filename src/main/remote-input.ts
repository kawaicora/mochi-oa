/**
 * Mochi OA - 远程控制输入注入（被控端 main 进程）—— 跨平台。
 *
 * 真实系统级键鼠注入。按平台分派后端（会话开始时探测并把选择结果写进日志）：
 *  - win32 ：常驻 PowerShell 子进程 + user32 原生 API
 *            （SetCursorPos / SendInput / mouse_event / ClipCursor / ShowCursor）。
 *            【注入行为本次不改】，只加握手与日志。
 *  - linux ：① Python3 + uinput 常驻进程（首选：Wayland / X11 都有效，零编译零依赖）
 *            ② xdotool（兜底：仅 X11）
 *            以前只有 xdotool —— 这就是「Linux 上鼠标键盘都发不过去」的根因：
 *            GNOME/KDE 默认 Wayland 会话，xdotool 注入不到任何东西。
 *  - darwin：osascript(JXA) 常驻进程调 CGEvent（kCGHIDEventTap），零编译。
 *            需要「辅助功能」权限，启动时用 AXIsProcessTrusted 自检并上报结果。
 *
 * 两种键鼠模式（控制端发起会话时指定）：
 *  - remote：本机鼠标锁定（ClipCursor）+ 隐藏（ShowCursor(false)），所有键鼠事件上报控制端。
 *  - local ：本机鼠标照常显示，仅按归一化坐标同步移动被控端鼠标。
 *  只有 Windows 有这套「锁定+隐藏」的权限模型，其它平台一律按 local 处理并记日志说明。
 *
 * 断线/结束必须复位：
 *  - 鼠标/键盘「按下中」断开 → 补发对应的 Up（防止粘连）。
 *  - Windows 强制解冻 + 显示鼠标（ClipCursor(null) + ShowCursor(true)）多次兜底。
 */

import { app } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import { rlog, rwarn, rerr, rlogThrottled } from '../shared/remote-log'
import { DOM_TO_EVDEV, DOM_TO_MAC, mapKey } from './remote-input-keymap'
import { UINPUT_PY } from './remote-input-uinput'
import { CGEVENT_JXA } from './remote-input-cgevent'

const S = 'input'
const IS_WIN = platform() === 'win32'
const IS_LINUX = platform() === 'linux'
const IS_DARWIN = platform() === 'darwin'

export type InputBackend =
  | 'windows-powershell'
  | 'linux-uinput'
  | 'linux-xdotool'
  | 'macos-cgevent'
  | 'none'

export interface InputCapability {
  /** 键鼠注入是否可用（不可用时控制端会明确提示，而不是"连上了但点不动"） */
  ok: boolean
  backend: InputBackend
  /** 人话说明：为什么不可用 / 降级原因 / 缺什么权限 */
  detail: string
  screen?: { w: number; h: number }
}

interface RemoteInputCommand {
  t: string
  x?: number
  y?: number
  d?: number
  k?: number
  c?: number
  btn?: string
}

// ─────────────────────────── Windows：PowerShell + user32 ───────────────────────────
// 注入分支保持原样，只补一行握手输出与 ping（便于主进程确认后端就绪 + 日志可读）。

const POWERSHELL_SCRIPT = `
$src = @'
using System;
using System.Runtime.InteropServices;
public static class U32 {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool ClipCursor(ref RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ClipCursor(IntPtr lpRect);
  [DllImport("user32.dll")] public static extern int ShowCursor(bool bShow);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  public const uint INPUT_MOUSE = 0; public const uint INPUT_KEYBOARD = 1;
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002; public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008; public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020; public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
  public const int SM_CXSCREEN = 0; public const int SM_CYSCREEN = 1;
  public static void SendMouse(uint flags, int dx, int dy, uint data) {
    var mi = new MOUSEINPUT(); mi.dwFlags = flags; mi.dx = dx; mi.dy = dy; mi.mouseData = data;
    var inp = new INPUT(); inp.type = INPUT_MOUSE; inp.U.mi = mi;
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void SendKey(ushort vk, bool down) {
    var ki = new KEYBDINPUT(); ki.wVk = vk; ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
    var inp = new INPUT(); inp.type = INPUT_KEYBOARD; inp.U.ki = ki;
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static int ScreenW() { return GetSystemMetrics(SM_CXSCREEN); }
  public static int ScreenH() { return GetSystemMetrics(SM_CYSCREEN); }
}
'@
Add-Type -TypeDefinition $src
[Console]::Out.WriteLine('{"ok":true,"backend":"windows-powershell"}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.t) {
      'move'   { [void][U32]::SetCursorPos([int]$c.x, [int]$c.y) }
      'ldown'  { [void][U32]::SendMouse([U32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0) }
      'lup'    { [void][U32]::SendMouse([U32]::MOUSEEVENTF_LEFTUP, 0, 0, 0) }
      'rdown'  { [void][U32]::SendMouse([U32]::MOUSEEVENTF_RIGHTDOWN, 0, 0, 0) }
      'rup'    { [void][U32]::SendMouse([U32]::MOUSEEVENTF_RIGHTUP, 0, 0, 0) }
      'mdown'  { [void][U32]::SendMouse([U32]::MOUSEEVENTF_MIDDLEDOWN, 0, 0, 0) }
      'mup'    { [void][U32]::SendMouse([U32]::MOUSEEVENTF_MIDDLEUP, 0, 0, 0) }
      'scroll' { [void][U32]::SendMouse([U32]::MOUSEEVENTF_WHEEL, 0, 0, [uint32]$c.d) }
      'kdown'  { [void][U32]::SendKey([uint16]$c.k, $true) }
      'kup'    { [void][U32]::SendKey([uint16]$c.k, $false) }
      'cliplock' {
        $r = New-Object U32+RECT
        $r.Left = 0; $r.Top = 0; $r.Right = [U32]::ScreenW(); $r.Bottom = [U32]::ScreenH()
        [void][U32]::ClipCursor([ref]$r)
      }
      'clipfree' { [void][U32]::ClipCursor([IntPtr]::Zero) }
      'hide' { [void][U32]::ShowCursor($false) }
      'show' { for ($i = 0; $i -lt 5; $i++) { [void][U32]::ShowCursor($true) } }
      'ping' { [Console]::Out.WriteLine('{"ok":true,"pong":true}') }
      default { [Console]::Out.WriteLine('{"ok":false,"reason":"unknown cmd"}') }
    }
  } catch { Write-Error "注入失败: $_" }
}
`

let winProc: ChildProcess | null = null

function ensureWinProc(): ChildProcess | null {
  if (winProc && !winProc.killed) return winProc
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    p.stdin?.setDefaultEncoding('utf8')
    p.on('error', (e) => { rerr(S, `PowerShell 注入进程启动失败：${e.message}`); winProc = null })
    p.on('exit', (code) => { rwarn(S, `PowerShell 注入进程退出 code=${code}`); winProc = null })
    attachHelperOutput(p, 'powershell')
    winProc = p
    rlog(S, '已启动 Windows 注入进程（powershell + user32 SendInput）')
    return p
  } catch (e) {
    rerr(S, `启动 PowerShell 注入进程异常：${e instanceof Error ? e.message : String(e)}`)
    winProc = null
    return null
  }
}

function winSend(cmd: RemoteInputCommand): boolean {
  const p = ensureWinProc()
  if (!p || !p.stdin) return false
  try {
    p.stdin.write(JSON.stringify(cmd) + '\n')
    return true
  } catch (e) {
    rwarn(S, `写入注入命令失败 t=${cmd.t}：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

// ─────────────── 常驻助手进程（Linux uinput / macOS CGEvent）───────────────
// 统一约定：stdin 逐行 JSON 命令，stdout 逐行 JSON 结果，首行握手。

let helper: ChildProcess | null = null
let helperBackend: InputBackend = 'none'
let helperHandshake: { ok: boolean; reason?: string; backend?: string } | null = null
let handshakeResolve: (() => void) | null = null

function helperDir(): string {
  const dir = join(app.getPath('userData'), 'remote-helpers')
  try {
    mkdirSync(dir, { recursive: true })
  } catch { /* 已存在 */ }
  return dir
}

function writeHelper(name: string, content: string): string {
  const file = join(helperDir(), name)
  try {
    writeFileSync(file, content, 'utf-8')
  } catch (e) {
    rwarn(S, `写入助手脚本失败 ${name}：${e instanceof Error ? e.message : String(e)}`)
  }
  return file
}

/** 收集助手进程输出；第一行 JSON 视为握手结果 */
function attachHelperOutput(p: ChildProcess, label: string): void {
  let buf = ''
  p.stdout?.on('data', (d: Buffer) => {
    buf += String(d)
    let idx: number
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      let obj: Record<string, unknown> | null = null
      try { obj = JSON.parse(line) as Record<string, unknown> } catch { /* 非 JSON 原样记 */ }
      if (obj) {
        if (obj.ok === true && obj.backend && !helperHandshake) {
          helperHandshake = { ok: true, backend: String(obj.backend) }
          rlog(S, `${label} 握手成功 backend=${String(obj.backend)}`)
          handshakeResolve?.()
        } else if (obj.ok === false) {
          if (!helperHandshake) {
            helperHandshake = { ok: false, reason: String(obj.reason ?? '未知原因') }
            handshakeResolve?.()
          }
          rerr(S, `${label} 上报错误：${String(obj.reason ?? '')}`)
        } else if (obj.pong) {
          rlog(S, `${label} ping 正常`)
        } else if (obj.bye) {
          rlog(S, `${label} 已正常退出`)
        } else {
          rlog(S, `${label} 输出：${line}`)
        }
      } else {
        rlog(S, `${label} 输出：${line}`)
      }
    }
  })
  p.stderr?.on('data', (d: Buffer) => {
    const s = String(d).trim()
    if (s) rerr(S, `${label} stderr：${s}`)
  })
  p.on('error', (e) => {
    rerr(S, `${label} 进程错误：${e.message}`)
    if (!helperHandshake) { helperHandshake = { ok: false, reason: e.message }; handshakeResolve?.() }
  })
  p.on('exit', (code, sig) => {
    rwarn(S, `${label} 进程退出 code=${code} signal=${sig}`)
    if (helper === p) helper = null
    if (!helperHandshake) { helperHandshake = { ok: false, reason: `进程退出 code=${code}` }; handshakeResolve?.() }
  })
}

/** 等助手握手（超时也算失败，避免会话卡住） */
function waitHandshake(timeoutMs: number): Promise<void> {
  if (helperHandshake) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!helperHandshake) {
        helperHandshake = { ok: false, reason: `等待注入助手握手超时（${timeoutMs}ms）` }
        rwarn(S, `注入助手握手超时（${timeoutMs}ms）`)
      }
      handshakeResolve = null
      resolve()
    }, timeoutMs)
    handshakeResolve = () => { clearTimeout(timer); handshakeResolve = null; resolve() }
  })
}

function handshakeOk(): boolean {
  const h: { ok: boolean; reason?: string } | null = helperHandshake
  return h?.ok === true
}

/** 握手失败的说明（TS 在 async 之后会把 helperHandshake 收窄成 null，这里绕开以读到最新值） */
function handshakeReason(): string {
  const h: { ok: boolean; reason?: string } | null = helperHandshake
  return h?.reason || ''
}

function helperSend(cmd: RemoteInputCommand): boolean {
  if (!helper || !helper.stdin) return false
  try {
    helper.stdin.write(JSON.stringify(cmd) + '\n')
    return true
  } catch (e) {
    rwarn(S, `写入注入命令失败 t=${cmd.t}：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

// ─────────────────────────── Linux ───────────────────────────

/** 首选后端：Python3 + uinput（Wayland / X11 通用，零编译） */
async function startLinuxUinput(w: number, h: number): Promise<boolean> {
  const script = writeHelper('uinput_helper.py', UINPUT_PY)
  const py = process.env['MOCHI_PYTHON'] || 'python3'
  rlog(S, `尝试 uinput 后端：${py} ${script} ${w} ${h}`)
  let p: ChildProcess
  try {
    p = spawn(py, [script, String(w), String(h)], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    rerr(S, `启动 python3 失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
  helper = p
  helperBackend = 'linux-uinput'
  helperHandshake = null
  p.stdin?.setDefaultEncoding('utf8')
  attachHelperOutput(p, 'uinput')
  await waitHandshake(5000)
  return handshakeOk()
}

function hasXdotool(): boolean {
  try {
    execFile('xdotool', ['--version'], { timeout: 1500 }, () => { /* 能启动就算有 */ })
    return true
  } catch {
    return false
  }
}

function xdotool(args: string[]): void {
  execFile('xdotool', args, { timeout: 2000 }, (err) => {
    if (err) rwarn(S, `xdotool 执行失败（${args.join(' ')}）：${err.message}`)
  })
}

function linuxXdotoolMove(x: number, y: number): void { xdotool(['mousemove', '--absolute', String(Math.round(x)), String(Math.round(y))]) }
function linuxXdotoolBtn(btn: 'left' | 'right' | 'middle', down: boolean): void {
  xdotool([down ? 'mousedown' : 'mouseup', btn === 'left' ? '1' : btn === 'right' ? '3' : '2'])
}
function linuxXdotoolScroll(delta: number): void {
  const n = Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 120) || 1))
  const btn = delta >= 0 ? '4' : '5'
  for (let i = 0; i < n; i++) xdotool(['click', btn])
}
function linuxXdotoolKey(code: number, down: boolean): void {
  const m = mapKey(DOM_TO_EVDEV, code, 'evdev')
  if (!m.ok) { rwarn(S, `键盘注入跳过：${m.reason}`); return }
  // xdotool 的 keycode = evdev 码 + 8（X11 约定）
  xdotool([down ? 'keydown' : 'keyup', String(m.code + 8)])
}

// ─────────────────────────── macOS ───────────────────────────

/** CGEvent（JXA 常驻进程调 CoreGraphics），需要「辅助功能」权限 */
async function startMacCgEvent(): Promise<boolean> {
  const script = writeHelper('cgevent_helper.js', CGEVENT_JXA)
  rlog(S, `尝试 CGEvent 后端：osascript -l JavaScript ${script}`)
  let p: ChildProcess
  try {
    p = spawn('osascript', ['-l', 'JavaScript', script], { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    rerr(S, `启动 osascript 失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
  helper = p
  helperBackend = 'macos-cgevent'
  helperHandshake = null
  p.stdin?.setDefaultEncoding('utf8')
  attachHelperOutput(p, 'cgevent')
  await waitHandshake(8000)
  return handshakeOk()
}

// ─────────────────────────── 状态 ───────────────────────────

let backend: InputBackend = 'none'
let capability: InputCapability = { ok: false, backend: 'none', detail: '尚未开始远程会话' }
let screenSize = { w: 1920, h: 1080 }
let cursorHidden = false
let cursorLocked = false
/** 按下中（未抬起）的键/钮，断线复位时补发 Up */
const pendingButtons = new Set<'left' | 'right' | 'middle'>()
const pendingKeys = new Set<number>()

export function remoteInputCapability(): InputCapability {
  return { ...capability }
}

/**
 * 会话开始：选后端 + 建常驻进程 + 设键鼠模式。
 * 返回本次输入注入的能力描述（控制端据此提示"对端键鼠不可用：原因…"）。
 */
export async function remoteInputStart(mode: 'remote' | 'local', screen?: { w: number; h: number }): Promise<InputCapability> {
  remoteInputReset()
  if (screen && screen.w > 0 && screen.h > 0) screenSize = { w: Math.round(screen.w), h: Math.round(screen.h) }
  rlog(S, `开始远程输入会话 mode=${mode} screen=${screenSize.w}x${screenSize.h} platform=${platform()}`)

  if (IS_WIN) {
    backend = 'windows-powershell'
    helperHandshake = null
    ensureWinProc()
    await waitHandshake(3000)
    capability = { ok: true, backend, detail: 'Windows 原生 SendInput', screen: { ...screenSize } }
  } else if (IS_LINUX) {
    const okUinput = await startLinuxUinput(screenSize.w, screenSize.h)
    if (okUinput) {
      backend = 'linux-uinput'
      capability = { ok: true, backend, detail: 'uinput 虚拟键鼠（Wayland / X11 通用）', screen: { ...screenSize } }
    } else {
      const reason = helperHandshake?.reason || '未知原因'
      rwarn(S, `uinput 后端不可用：${reason}`)
      if (hasXdotool()) {
        const wayland = !!process.env['WAYLAND_DISPLAY'] || process.env['XDG_SESSION_TYPE'] === 'wayland'
        backend = 'linux-xdotool'
        capability = {
          ok: !wayland,
          backend,
          detail: wayland
            ? `uinput 不可用（${reason}）；已退回 xdotool，但当前是 Wayland 会话，xdotool 注入无效 —— 必须先修好 uinput 权限`
            : `uinput 不可用（${reason}）；已退回 xdotool（仅 X11）`,
          screen: { ...screenSize }
        }
      } else {
        backend = 'none'
        capability = { ok: false, backend, detail: `uinput 与 xdotool 都不可用：${reason}`, screen: { ...screenSize } }
      }
    }
  } else if (IS_DARWIN) {
    const ok = await startMacCgEvent()
    if (ok) {
      backend = 'macos-cgevent'
      capability = { ok: true, backend, detail: 'CGEvent 注入（需辅助功能权限）' }
    } else {
      backend = 'none'
      capability = { ok: false, backend, detail: helperHandshake?.reason || 'CGEvent 助手不可用' }
    }
  } else {
    backend = 'none'
    capability = { ok: false, backend, detail: `不支持的平台 ${platform()}` }
  }

  rlog(S, `输入后端 = ${backend} ok=${capability.ok} 说明=${capability.detail}`)

  // 键鼠模式：只有 Windows 有「锁定+隐藏本机光标」
  let effMode = mode
  if (effMode === 'remote' && !IS_WIN) {
    rwarn(S, 'remote 模式（锁定+隐藏本机光标）在 Windows 之外不可用，本会话按 local 处理（仅同步位置）')
    effMode = 'local'
  }
  if (effMode === 'remote') {
    if (!cursorLocked) { winSend({ t: 'cliplock' }); cursorLocked = true }
    if (!cursorHidden) { winSend({ t: 'hide' }); cursorHidden = true }
  } else if (IS_WIN) {
    winSend({ t: 'clipfree' })
    winSend({ t: 'show' })
    cursorLocked = false
    cursorHidden = false
  }
  return { ...capability }
}

// ─────────────────────────── 指令分发 ───────────────────────────

export function remoteInputMove(x: number, y: number): void {
  const px = Math.round(x)
  const py = Math.round(y)
  rlogThrottled(S, 'move', `鼠标移动到 ${px},${py}`, 1000)
  if (backend === 'windows-powershell') { winSend({ t: 'move', x: px, y: py }); return }
  if (backend === 'linux-uinput' || backend === 'macos-cgevent') { helperSend({ t: 'move', x: px, y: py }); return }
  if (backend === 'linux-xdotool') linuxXdotoolMove(px, py)
}

function btnName(btn: string): 'left' | 'right' | 'middle' {
  return btn === 'left' ? 'left' : btn === 'right' ? 'right' : 'middle'
}

export function remoteInputDown(btn: string): void {
  const b = btnName(btn)
  pendingButtons.add(b)
  rlog(S, `鼠标按下 ${b}`)
  if (backend === 'windows-powershell') { winSend({ t: b === 'left' ? 'ldown' : b === 'right' ? 'rdown' : 'mdown' }); return }
  if (backend === 'linux-uinput') { helperSend({ t: 'down', btn: b }); return }
  if (backend === 'macos-cgevent') { helperSend({ t: 'down', btn: b === 'left' ? '0' : b === 'right' ? '1' : '2' }); return }
  if (backend === 'linux-xdotool') linuxXdotoolBtn(b, true)
}

export function remoteInputUp(btn: string): void {
  const b = btnName(btn)
  pendingButtons.delete(b)
  rlog(S, `鼠标抬起 ${b}`)
  if (backend === 'windows-powershell') { winSend({ t: b === 'left' ? 'lup' : b === 'right' ? 'rup' : 'mup' }); return }
  if (backend === 'linux-uinput') { helperSend({ t: 'up', btn: b }); return }
  if (backend === 'macos-cgevent') { helperSend({ t: 'up', btn: b === 'left' ? '0' : b === 'right' ? '1' : '2' }); return }
  if (backend === 'linux-xdotool') linuxXdotoolBtn(b, false)
}

export function remoteInputScroll(delta: number): void {
  const d = Math.round(delta)
  rlogThrottled(S, 'scroll', `滚轮 d=${d}`, 300)
  if (backend === 'windows-powershell') { winSend({ t: 'scroll', d }); return }
  if (backend === 'linux-uinput' || backend === 'macos-cgevent') { helperSend({ t: 'scroll', d }); return }
  if (backend === 'linux-xdotool') linuxXdotoolScroll(d)
}

export function remoteInputKeyDown(code: number): void {
  if (!(code > 0)) return
  pendingKeys.add(code)
  rlog(S, `键盘按下 keyCode=${code}`)
  if (backend === 'windows-powershell') { winSend({ t: 'kdown', k: code }); return }
  if (backend === 'linux-uinput') {
    const m = mapKey(DOM_TO_EVDEV, code, 'evdev')
    if (!m.ok) { rwarn(S, `键盘注入跳过：${m.reason}`); return }
    helperSend({ t: 'kdown', c: m.code })
    return
  }
  if (backend === 'macos-cgevent') {
    const m = mapKey(DOM_TO_MAC, code, 'macOS 虚拟键码')
    if (!m.ok) { rwarn(S, `键盘注入跳过：${m.reason}`); return }
    helperSend({ t: 'kdown', c: m.code })
    return
  }
  if (backend === 'linux-xdotool') linuxXdotoolKey(code, true)
}

export function remoteInputKeyUp(code: number): void {
  if (!(code > 0)) return
  pendingKeys.delete(code)
  rlog(S, `键盘抬起 keyCode=${code}`)
  if (backend === 'windows-powershell') { winSend({ t: 'kup', k: code }); return }
  if (backend === 'linux-uinput') {
    const m = mapKey(DOM_TO_EVDEV, code, 'evdev')
    if (!m.ok) return
    helperSend({ t: 'kup', c: m.code })
    return
  }
  if (backend === 'macos-cgevent') {
    const m = mapKey(DOM_TO_MAC, code, 'macOS 虚拟键码')
    if (!m.ok) return
    helperSend({ t: 'kup', c: m.code })
    return
  }
  if (backend === 'linux-xdotool') linuxXdotoolKey(code, false)
}

/** 统一分发一条控制端经 DataChannel 发来的控制指令（{ t, ... }）。 */
export function remoteInputDispatch(evt: Record<string, unknown>): void {
  const t = typeof evt?.t === 'string' ? evt.t : ''
  switch (t) {
    case 'move': remoteInputMove(Number(evt.x) || 0, Number(evt.y) || 0); break
    case 'down': remoteInputDown(String(evt.btn ?? 'left')); break
    case 'up': remoteInputUp(String(evt.btn ?? 'left')); break
    case 'scroll': remoteInputScroll(Number(evt.d) || 0); break
    case 'kdown': remoteInputKeyDown(Number(evt.k) || 0); break
    case 'kup': remoteInputKeyUp(Number(evt.k) || 0); break
    default: rwarn(S, `未知控制指令：${JSON.stringify(evt).slice(0, 200)}`); break
  }
}

/**
 * 断线/结束复位：补发所有「按下中」的 Up + Windows 强制解冻并显示鼠标（多执行几次兜底）。
 * 宁可重复执行，也要保证本地鼠标可用。
 */
export function remoteInputReset(): void {
  if (pendingButtons.size || pendingKeys.size) {
    rlog(S, `复位：补发 ${pendingButtons.size} 个鼠标 Up、${pendingKeys.size} 个键盘 Up`)
  }
  for (const b of [...pendingButtons]) remoteInputUp(b)
  for (const code of [...pendingKeys]) remoteInputKeyUp(code)
  pendingButtons.clear()
  pendingKeys.clear()
  if (backend === 'windows-powershell') {
    winSend({ t: 'clipfree' })
    winSend({ t: 'show' })
    winSend({ t: 'show' })
  }
  cursorLocked = false
  cursorHidden = false
}

/** 彻底停止（会话结束）：复位 + 结束常驻进程。 */
export function remoteInputStop(): void {
  remoteInputReset()
  if (winProc) {
    rlog(S, '结束 Windows 注入进程')
    try { winProc.stdin?.end() } catch { console.warn('结束注入进程stdin失败') }
    try { winProc.kill() } catch { console.warn('结束win注入进程失败') }
    winProc = null
  }
  if (helper) {
    rlog(S, `结束注入助手进程（${helperBackend}）`)
    try { helper.stdin?.end() } catch { console.warn('结束注入助手进程stdin失败')  }
    try { helper.kill() } catch { console.warn('结束注入助手进程失败') }
    helper = null
  }
  helperBackend = 'none'
  helperHandshake = null
  backend = 'none'
  capability = { ok: false, backend: 'none', detail: '会话已结束' }
  cursorLocked = false
  cursorHidden = false
}

/** 应用退出前兜底清理：子进程不会随父进程自动退出，必须显式收掉 */
export function remoteInputShutdown(): void {
  try { remoteInputStop() } catch { console.warn('结束远程输入失败') }
}
