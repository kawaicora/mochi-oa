/**
 * Mochi OA - 远程控制输入注入（被控端 main 进程）—— 跨平台。
 *
 * 真实系统级键鼠注入。按平台分派后端：
 *  - win32 ：常驻 PowerShell 子进程 + user32 原生 API
 *            （SetCursorPos / SendInput / mouse_event / ClipCursor / ShowCursor），
 *            无原生编译依赖，完整支持 remote/local 两种模式 + 锁定/隐藏/复位。
 *  - linux ：命令式调用 xdotool（X11）。支持 move/click/key/滚轮；X11 的鼠标
 *            "锁定+隐藏"需 XGrabPointer 权限，自动降级为 local 语义（仅同步位置）。
 *  - darwin：尽力。macOS 注入需编译 CGEvent 小工具，暂降级为 local 语义 + 日志。
 *
 * 两种键鼠模式（控制端发起会话时指定）：
 *  - remote：本机鼠标锁定（ClipCursor）+ 隐藏（ShowCursor(false)），所有键鼠事件
 *            上报控制端；控制端默认显示鼠标，无需处理。
 *  - local ：本机鼠标照常显示，仅按归一化坐标同步移动被控端鼠标；不隐藏控制端鼠标。
 *
 * 断线/结束必须复位：
 *  - 鼠标/键盘「按下中」断开 → 补发对应的 Up（防止粘连）。
 *  - 强制解冻 + 显示鼠标（ClipCursor(null) + ShowCursor(true)）多次兜底，宁可多执行。
 *
 * 本地鼠标键盘事件屏蔽：注入发生在被控端，事件只在焦点窗口起作用；被控端让出焦点
 * 给远程控制面板后本地物理键鼠默认不触发，无需额外拦截。
 */

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { platform } from 'node:os'

const IS_WIN = platform() === 'win32'
const IS_LINUX = platform() === 'linux'
const IS_DARWIN = platform() === 'darwin'

interface RemoteInputCommand {
  t: string
  x?: number
  y?: number
  d?: number
  k?: number
}

// ─────────────────────────── Windows：PowerShell + user32 ───────────────────────────

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
    }
  } catch { Write-Error "注入失败: $_" }
}
`

let winProc: ChildProcessWithoutNullStreams | null = null

function ensureWinProc(): ChildProcessWithoutNullStreams | null {
  if (winProc && !winProc.killed) return winProc
  try {
    winProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    winProc.stdin.setDefaultEncoding('utf8')
    winProc.on('error', () => { winProc = null })
    winProc.on('exit', () => { winProc = null })
    winProc.stdout.on('data', () => {})
    winProc.stderr.on('data', (d) => { const s = String(d).trim(); if (s) console.warn('[remote-input] powershell:', s) })
    return winProc
  } catch (e) {
    console.error('[remote-input] 启动 powershell 注入进程失败', e)
    winProc = null
    return null
  }
}

function winSend(cmd: RemoteInputCommand): boolean {
  const p = ensureWinProc()
  if (!p) return false
  try {
    p.stdin.write(JSON.stringify(cmd) + '\n')
    return true
  } catch (e) {
    console.warn('[remote-input] 写入注入命令失败', cmd.t, e)
    return false
  }
}

// ─────────────────────────── Linux：xdotool（X11） ───────────────────────────

// DOM keyCode → xdotool keysym（常用子集；完整映射见 Linux X11 keycode 表）
const XKEYSYM: Record<number, string> = {
  // 字母 A-Z
  65: 'a', 66: 'b', 67: 'c', 68: 'd', 69: 'e', 70: 'f', 71: 'g', 72: 'h', 73: 'i', 74: 'j',
  75: 'k', 76: 'l', 77: 'm', 78: 'n', 79: 'o', 80: 'p', 81: 'q', 82: 'r', 83: 's', 84: 't',
  85: 'u', 86: 'v', 87: 'w', 88: 'x', 89: 'y', 90: 'z',
  // 数字 0-9
  48: '0', 49: '1', 50: '2', 51: '3', 52: '4', 53: '5', 54: '6', 55: '7', 56: '8', 57: '9',
  // 功能键
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6', 118: 'F7', 119: 'F8',
  120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
  // 控制
  8: 'BackSpace', 9: 'Tab', 13: 'Return', 16: 'Shift_L', 17: 'Control_L', 18: 'Alt_L',
  20: 'Caps_Lock', 27: 'Escape', 32: 'space', 37: 'Left', 38: 'Up', 39: 'Right', 40: 'Down',
  33: 'Prior', 34: 'Next', 35: 'End', 36: 'Home', 45: 'Insert', 46: 'Delete',
  188: 'comma', 190: 'period', 191: 'slash', 219: 'bracketleft', 221: 'bracketright',
  186: 'semicolon', 222: 'apostrophe', 189: 'minus', 187: 'equal'
}

function xdotool(args: string[]): void {
  try {
    execFile('xdotool', args, { timeout: 1500 }, (err) => {
      if (err) console.warn('[remote-input] xdotool 失败', err.message)
    })
  } catch (e) {
    console.warn('[remote-input] xdotool 调用异常', e)
  }
}

function linuxMove(x: number, y: number): void { xdotool(['mousemove', '--absolute', String(x), String(y)]) }
function linuxDown(btn: string): void {
  const b = btn === 'left' ? '1' : btn === 'right' ? '3' : '2'
  xdotool(['mousedown', b])
}
function linuxUp(btn: string): void {
  const b = btn === 'left' ? '1' : btn === 'right' ? '3' : '2'
  xdotool(['mouseup', b])
}
function linuxScroll(delta: number): void {
  // delta>0 向上滚（4），delta<0 向下滚（5）
  const n = Math.min(10, Math.max(1, Math.round(Math.abs(delta) / 120) || 1))
  const btn = delta >= 0 ? '4' : '5'
  for (let i = 0; i < n; i++) xdotool(['click', btn])
}
function linuxKey(code: number, down: boolean): void {
  const sym = XKEYSYM[code]
  if (!sym) return
  xdotool([down ? 'keydown' : 'keyup', sym])
}

// ─────────────────────────── 平台分派状态 ───────────────────────────

let cursorHidden = false
let cursorLocked = false
// 按下中（未抬起）的键/钮，断线复位时补发 Up
const pendingButtons = new Set<'left' | 'right' | 'middle'>()
const pendingKeys = new Set<number>()

/** 是否支持完整 remote 模式（锁定+隐藏）。Linux/macOS 降级为 local 语义。 */
export const remoteInputSupportFullMode = IS_WIN

function win() { return IS_WIN }
function linux() { return IS_LINUX }

/** 设置键鼠模式（会话开始时调用）。remote=锁定+隐藏本机鼠标；local=仅同步位置。 */
export function remoteInputSetMode(mode: 'remote' | 'local'): void {
  if (IS_DARWIN) {
    // macOS 暂不支持注入，仅记录
    console.warn('[remote-input] macOS 输入注入暂不支持，本会话仅远程查看')
    return
  }
  if (mode === 'remote' && IS_LINUX) {
    // Linux X11 锁定需 XGrabPointer 权限，降级为 local（仅同步位置），不隐藏控制端鼠标
    console.warn('[remote-input] Linux 无图形锁权限，remote 模式降级为 local（仅同步位置）')
    mode = 'local'
  }
  if (mode === 'remote') {
    if (!cursorLocked) { if (win() ? winSend({ t: 'cliplock' }) : true) cursorLocked = true }
    if (!cursorHidden) { if (win() ? winSend({ t: 'hide' }) : true) cursorHidden = true }
  } else {
    if (cursorLocked) { if (win()) winSend({ t: 'clipfree' }); cursorLocked = false }
    if (cursorHidden) { if (win()) winSend({ t: 'show' }); cursorHidden = false }
  }
}

export function remoteInputMove(x: number, y: number): void {
  if (IS_DARWIN) return
  if (win()) winSend({ t: 'move', x, y })
  else linuxMove(x, y)
}

function btnName(btn: string): 'left' | 'right' | 'middle' {
  return btn === 'left' ? 'left' : btn === 'right' ? 'right' : 'middle'
}

export function remoteInputDown(btn: string): void {
  if (IS_DARWIN) return
  const b = btnName(btn)
  pendingButtons.add(b)
  if (win()) winSend({ t: b === 'left' ? 'ldown' : b === 'right' ? 'rdown' : 'mdown' })
  else linuxDown(b)
}

export function remoteInputUp(btn: string): void {
  if (IS_DARWIN) return
  const b = btnName(btn)
  pendingButtons.delete(b)
  if (win()) winSend({ t: b === 'left' ? 'lup' : b === 'right' ? 'rup' : 'mup' })
  else linuxUp(b)
}

export function remoteInputScroll(delta: number): void {
  if (IS_DARWIN) return
  const d = Math.round(delta)
  if (win()) winSend({ t: 'scroll', d })
  else linuxScroll(d)
}

export function remoteInputKeyDown(code: number): void {
  if (IS_DARWIN) return
  if (code > 0) {
    pendingKeys.add(code)
    if (win()) winSend({ t: 'kdown', k: code })
    else linuxKey(code, true)
  }
}

export function remoteInputKeyUp(code: number): void {
  if (IS_DARWIN) return
  if (code > 0) {
    pendingKeys.delete(code)
    if (win()) winSend({ t: 'kup', k: code })
    else linuxKey(code, false)
  }
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
    default: break
  }
}

/**
 * 断线/结束复位：补发所有「按下中」的 Up + 强制解冻并显示鼠标（多执行几次兜底）。
 * 宁可重复执行，也要保证本地鼠标可用。
 */
export function remoteInputReset(): void {
  if (win()) {
    for (const b of pendingButtons) winSend({ t: b === 'left' ? 'lup' : b === 'right' ? 'rup' : 'mup' })
    for (const code of pendingKeys) winSend({ t: 'kup', k: code })
  } else if (linux()) {
    for (const b of pendingButtons) linuxUp(b)
    for (const code of pendingKeys) linuxKey(code, false)
  }
  pendingButtons.clear()
  pendingKeys.clear()
  if (win()) {
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
  if (win()) {
    const p = winProc
    winProc = null
    try { p?.stdin.end() } catch { /* ignore */ }
  }
  cursorLocked = false
  cursorHidden = false
}
