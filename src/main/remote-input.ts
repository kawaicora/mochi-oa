/**
 * Mochi OA - 远程控制输入注入（被控端 main 进程）—— 跨平台。
 *
 * 真实系统级键鼠注入。按平台分派后端（会话开始时探测并把选择结果写进日志）：
 *  - win32 ：内置 Rust 常驻助手（user32 SendInput / ClipCursor）。
 *  - linux ：① 内置 Rust 助手（uinput 虚拟键鼠，Wayland / X11 通用）
 *            ② Python3 + uinput 常驻进程（零编译零依赖）
 *            ③ xdotool（兜底：仅 X11）
 *            以前只有 xdotool —— 这就是「Linux 上鼠标键盘都发不过去」的根因：
 *            GNOME/KDE 默认 Wayland 会话，xdotool 注入不到任何东西。
 *  - darwin：① 内置 Rust 助手（CGEvent，kCGHIDEventTap）
 *            ② osascript(JXA) 常驻进程调 CGEvent，零编译。
 *            需要「辅助功能」权限，启动时用 AXIsProcessTrusted 自检并上报结果。
 *
 * 两种键鼠模式（控制端发起会话时指定）：
 *  - remote：本机鼠标锁定在屏幕边界（ClipCursor）；键鼠事件由控制端上报。
 *  - local ：本机鼠标照常显示，仅按归一化坐标同步移动被控端鼠标。
 *  光标是否可见由系统/设备自己决定，注入侧不调用 ShowCursor 强制显示或隐藏。
 *
 * 断线/结束必须复位：
 *  - 鼠标/键盘「按下中」断开 → 补发对应的 Up（防止粘连）。
 *  - Windows 强制解冻光标边界（ClipCursor(null)）兜底。
 */

import { app, screen } from 'electron'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import { rlog, rwarn, rerr, rlogThrottled } from '../shared/remote-log'
import { DOM_TO_EVDEV, DOM_TO_MAC, mapKey } from './remote-input-keymap'
import { UINPUT_PY } from './remote-input-uinput'
import { CGEVENT_JXA } from './remote-input-cgevent'
import {
  type RemoteDisplayInfo,
  type InputPlatform,
  displayPhysicalSize as displayPhysicalSizePure,
  transformPoint as transformPointPure
} from './remote-input-geometry'

const S = 'input'
const IS_WIN = platform() === 'win32'
const IS_LINUX = platform() === 'linux'
const IS_DARWIN = platform() === 'darwin'
const PLATFORM: InputPlatform = IS_WIN ? 'win32' : IS_DARWIN ? 'darwin' : 'linux'

export type InputBackend =
  | 'windows-rust'
  | 'linux-rust-uinput'
  | 'linux-uinput'
  | 'linux-xdotool'
  | 'macos-rust-cgevent'
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
  buttons?: number[]
  axes?: number[]
}

const FALLBACK_DISPLAY: RemoteDisplayInfo = {
  id: '0', label: '主屏', x: 0, y: 0, w: 1920, h: 1080, scaleFactor: 1, primary: true
}

/** 枚举全部显示器；枚举失败时回退单块主屏描述。 */
export function listDisplays(): RemoteDisplayInfo[] {
  try {
    const primaryId = screen.getPrimaryDisplay().id
    const all = screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: `显示器 ${i + 1}`,
      x: Math.round(d.bounds.x),
      y: Math.round(d.bounds.y),
      w: Math.round(d.bounds.width),
      h: Math.round(d.bounds.height),
      scaleFactor: d.scaleFactor || 1,
      primary: d.id === primaryId
    }))
    return all.length ? all : [FALLBACK_DISPLAY]
  } catch (e) {
    rerr(S, `枚举显示器失败：${e instanceof Error ? e.message : String(e)}`)
    return [FALLBACK_DISPLAY]
  }
}

/** 按 id 找显示器；找不到回退主屏/第一块。 */
function resolveDisplay(id?: string | null): RemoteDisplayInfo {
  const all = listDisplays()
  if (id) {
    const hit = all.find((d) => d.id === id)
    if (hit) return hit
  }
  return all.find((d) => d.primary) ?? all[0] ?? FALLBACK_DISPLAY
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

// ─────────────────────────── 内置 Rust 常驻助手（首选后端）───────────────────────────
// 产物由 scripts/build-helper.mjs 落到 resources/remote-input-helper/<plat>-<arch>/，
// 打包后经 extraResources 随包分发。路径口径与 branding.ts 一致：
// 打包后 process.resourcesPath/resources；开发态 app.getAppPath()/resources（兜底 cwd/resources）。

/** 解析当前平台 Rust 助手二进制；不存在返回 null（改走该平台其它后端或不可用）。 */
function resolveHelper(): string | null {
  const plat = process.platform
  const arch = process.arch === 'x64' ? 'amd64' : process.arch
  const bin = plat === 'win32' ? 'remote-input-helper.exe' : 'remote-input-helper'
  const roots: string[] = []
  if (app.isPackaged) {
    roots.push(join(process.resourcesPath, 'resources', 'remote-input-helper', `${plat}-${arch}`))
  } else {
    roots.push(join(app.getAppPath(), 'resources', 'remote-input-helper', `${plat}-${arch}`))
    roots.push(join(process.cwd(), 'resources', 'remote-input-helper', `${plat}-${arch}`))
  }
  for (const r of roots) {
    const p = join(r, bin)
    try { if (existsSync(p)) return p } catch { /* ignore */ }
  }
  return null
}

/** 停掉当前 helper 常驻进程（切换后端前清理）。 */
function stopHelperProc(): void {
  if (helper) {
    try { helper.stdin?.end() } catch { /* ignore */ }
    try { helper.kill() } catch { /* ignore */ }
    helper = null
  }
  helperHandshake = null
}

/** 启动内置 Rust 助手并等握手；失败（缺二进制/启动报错/握手超时）返回 false。 */
async function startRustHelper(w: number, h: number): Promise<boolean> {
  const exe = resolveHelper()
  if (!exe) {
    rlog(S, '未找到内置 Rust 助手二进制，尝试该平台其它后端')
    return false
  }
  if (process.platform !== 'win32') { try { chmodSync(exe, 0o755) } catch { /* ignore */ } }
  rlog(S, `启动 Rust 键鼠助手：${exe} ${w} ${h}`)
  let p: ChildProcess
  try {
    p = spawn(exe, [String(w), String(h)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  } catch (e) {
    rerr(S, `启动 Rust 助手失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
  helper = p
  helperHandshake = null
  p.stdin?.setDefaultEncoding('utf8')
  attachHelperOutput(p, 'rust-helper')
  await waitHandshake(5000)
  if (handshakeOk()) {
    helperBackend = IS_WIN ? 'windows-rust' : IS_LINUX ? 'linux-rust-uinput' : 'macos-rust-cgevent'
    return true
  }
  return false
}

/** Windows 边界/光标/键鼠指令：统一走 Rust 助手。 */
function sendWinMode(cmd: RemoteInputCommand): void {
  if (backend === 'windows-rust') helperSend(cmd)
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
/** 当前注入目标显示器（默认主屏）；多屏切换时只改几何，不重启注入进程 */
let activeDisplay: RemoteDisplayInfo = resolveDisplay(null)
let cursorLocked = false
/** 按下中（未抬起）的键/钮，断线复位时补发 Up */
const pendingButtons = new Set<'left' | 'right' | 'middle'>()
const pendingKeys = new Set<number>()
/** 按下中的触摸触点标识；断线复位时补发抬起 */
const pendingTouches = new Set<number>()

export function remoteInputCapability(): InputCapability {
  return { ...capability }
}

/** 列出全部显示器（供控制端下拉切换）。 */
export function remoteInputListDisplays(): RemoteDisplayInfo[] {
  return listDisplays()
}

/** 当前注入目标显示器。 */
export function remoteInputActiveDisplay(): RemoteDisplayInfo {
  return activeDisplay
}

/** 切换注入目标显示器：只改几何与坐标换算，不重启注入常驻进程。 */
export function remoteInputSwitchDisplay(id: string): { ok: boolean; display?: RemoteDisplayInfo; reason?: string } {
  const next = resolveDisplay(id)
  activeDisplay = next
  const phys = displayPhysicalSizePure(next, PLATFORM)
  screenSize = phys
  rlog(S, `切换注入目标显示器 id=${next.id} ${next.label} ${next.w}x${next.h} sf=${next.scaleFactor}`)
  return { ok: true, display: next }
}

/**
 * 会话开始：选后端 + 建常驻进程 + 设键鼠模式。
 * 返回本次输入注入的能力描述（控制端据此提示"对端键鼠不可用：原因…"）。
 */
export async function remoteInputStart(mode: 'remote' | 'local', screen?: { w: number; h: number }, displayId?: string | null): Promise<InputCapability> {
  remoteInputReset()
  activeDisplay = resolveDisplay(displayId)
  const phys = displayPhysicalSizePure(activeDisplay, PLATFORM)
  screenSize = (phys.w > 0 && phys.h > 0) ? phys : { w: Math.round(screen?.w || 1920), h: Math.round(screen?.h || 1080) }
  rlog(S, `开始远程输入会话 mode=${mode} screen=${screenSize.w}x${screenSize.h} display=${activeDisplay.id} platform=${platform()}`)

  if (IS_WIN) {
    const rustOk = await startRustHelper(screenSize.w, screenSize.h)
    if (rustOk) {
      backend = 'windows-rust'
      capability = { ok: true, backend, detail: 'Rust 原生 SendInput 注入', screen: { ...screenSize } }
    } else {
      stopHelperProc()
      backend = 'none'
      const reason = handshakeReason() || '内置 Rust 助手不可用'
      capability = { ok: false, backend, detail: `Windows 注入助手不可用：${reason}`, screen: { ...screenSize } }
    }
  } else if (IS_LINUX) {
    const rustOk = await startRustHelper(screenSize.w, screenSize.h)
    if (rustOk) {
      backend = 'linux-rust-uinput'
      capability = { ok: true, backend, detail: 'Rust uinput 虚拟键鼠（Wayland / X11 通用）', screen: { ...screenSize } }
    } else {
      stopHelperProc()
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
    }
  } else if (IS_DARWIN) {
    const rustOk = await startRustHelper(screenSize.w, screenSize.h)
    if (rustOk) {
      backend = 'macos-rust-cgevent'
      capability = { ok: true, backend, detail: 'Rust CGEvent 注入（需辅助功能权限）' }
    } else {
      stopHelperProc()
      const ok = await startMacCgEvent()
      if (ok) {
        backend = 'macos-cgevent'
        capability = { ok: true, backend, detail: 'CGEvent 注入（需辅助功能权限）' }
      } else {
        backend = 'none'
        capability = { ok: false, backend, detail: helperHandshake?.reason || 'CGEvent 助手不可用' }
      }
    }
  } else {
    backend = 'none'
    capability = { ok: false, backend, detail: `不支持的平台 ${platform()}` }
  }

  rlog(S, `输入后端 = ${backend} ok=${capability.ok} 说明=${capability.detail}`)

  // 键鼠模式：只有 Windows 有「锁定本机光标边界」的能力；光标是否可见交给系统，代码不强制显示/隐藏。
  let effMode = mode
  if (effMode === 'remote' && !IS_WIN) {
    rwarn(S, 'remote 模式（锁定本机光标边界）在 Windows 之外不可用，本会话按 local 处理（仅同步位置）')
    effMode = 'local'
  }
  if (effMode === 'remote') {
    if (!cursorLocked) { sendWinMode({ t: 'cliplock' }); cursorLocked = true }
  } else if (IS_WIN) {
    sendWinMode({ t: 'clipfree' })
    cursorLocked = false
  }
  return { ...capability }
}

// ─────────────────────────── 指令分发 ───────────────────────────

/** 已换算成注入全局坐标后的移动路由（触摸兜底复用，避免二次叠加屏偏移/缩放）。 */
function injectMoveGlobal(pt: { x: number; y: number }): void {
  if (backend === 'windows-rust' || backend === 'macos-rust-cgevent' || backend === 'macos-cgevent') {
    helperSend({ t: 'move', x: pt.x, y: pt.y }); return
  }
  if (backend === 'linux-rust-uinput' || backend === 'linux-uinput') { helperSend({ t: 'move', x: pt.x, y: pt.y }); return }
  if (backend === 'linux-xdotool') linuxXdotoolMove(pt.x, pt.y)
}

export function remoteInputMove(x: number, y: number): void {
  const px = Math.round(x)
  const py = Math.round(y)
  const pt = transformPointPure(activeDisplay, px, py, PLATFORM)
  rlogThrottled(S, 'move', `鼠标移动到 ${px},${py} → 注入 ${pt.x},${pt.y}`, 1000)
  injectMoveGlobal(pt)
}

function btnName(btn: string): 'left' | 'right' | 'middle' {
  return btn === 'left' ? 'left' : btn === 'right' ? 'right' : 'middle'
}

export function remoteInputDown(btn: string): void {
  const b = btnName(btn)
  pendingButtons.add(b)
  rlog(S, `鼠标按下 ${b}`)
  if (
    backend === 'windows-rust' || backend === 'linux-rust-uinput' || backend === 'macos-rust-cgevent' ||
    backend === 'linux-uinput'
  ) { helperSend({ t: 'down', btn: b }); return }
  if (backend === 'macos-cgevent') { helperSend({ t: 'down', btn: b === 'left' ? '0' : b === 'right' ? '1' : '2' }); return }
  if (backend === 'linux-xdotool') linuxXdotoolBtn(b, true)
}

export function remoteInputUp(btn: string): void {
  const b = btnName(btn)
  pendingButtons.delete(b)
  rlog(S, `鼠标抬起 ${b}`)
  if (
    backend === 'windows-rust' || backend === 'linux-rust-uinput' || backend === 'macos-rust-cgevent' ||
    backend === 'linux-uinput'
  ) { helperSend({ t: 'up', btn: b }); return }
  if (backend === 'macos-cgevent') { helperSend({ t: 'up', btn: b === 'left' ? '0' : b === 'right' ? '1' : '2' }); return }
  if (backend === 'linux-xdotool') linuxXdotoolBtn(b, false)
}

export function remoteInputScroll(delta: number): void {
  const d = Math.round(delta)
  rlogThrottled(S, 'scroll', `滚轮 d=${d}`, 300)
  if (
    backend === 'windows-rust' || backend === 'linux-rust-uinput' || backend === 'macos-rust-cgevent' ||
    backend === 'linux-uinput' || backend === 'macos-cgevent'
  ) { helperSend({ t: 'scroll', d }); return }
  if (backend === 'linux-xdotool') linuxXdotoolScroll(d)
}

export function remoteInputKeyDown(code: number): void {
  if (!(code > 0)) return
  pendingKeys.add(code)
  rlog(S, `键盘按下 keyCode=${code}`)
  if (backend === 'windows-rust') {
    helperSend({ t: 'kdown', k: code })
    return
  }
  if (backend === 'linux-uinput' || backend === 'linux-rust-uinput') {
    const m = mapKey(DOM_TO_EVDEV, code, 'evdev')
    if (!m.ok) { rwarn(S, `键盘注入跳过：${m.reason}`); return }
    helperSend({ t: 'kdown', k: m.code })
    return
  }
  if (backend === 'macos-cgevent' || backend === 'macos-rust-cgevent') {
    const m = mapKey(DOM_TO_MAC, code, 'macOS 虚拟键码')
    if (!m.ok) { rwarn(S, `键盘注入跳过：${m.reason}`); return }
    helperSend({ t: 'kdown', k: m.code })
    return
  }
  if (backend === 'linux-xdotool') linuxXdotoolKey(code, true)
}

export function remoteInputKeyUp(code: number): void {
  if (!(code > 0)) return
  pendingKeys.delete(code)
  rlog(S, `键盘抬起 keyCode=${code}`)
  if (backend === 'windows-rust') {
    helperSend({ t: 'kup', k: code })
    return
  }
  if (backend === 'linux-uinput' || backend === 'linux-rust-uinput') {
    const m = mapKey(DOM_TO_EVDEV, code, 'evdev')
    if (!m.ok) return
    helperSend({ t: 'kup', k: m.code })
    return
  }
  if (backend === 'macos-cgevent' || backend === 'macos-rust-cgevent') {
    const m = mapKey(DOM_TO_MAC, code, 'macOS 虚拟键码')
    if (!m.ok) return
    helperSend({ t: 'kup', k: m.code })
    return
  }
  if (backend === 'linux-xdotool') linuxXdotoolKey(code, false)
}

/**
 * 触摸触点注入（被控端）。
 * 本期注入路径先走左键鼠标兜底：点按 / 长按（触点保持按下）/ 滑动都映射为左键按下+移动+抬起；
 * 原生多点触控（双指捏合/缩放）待 Windows InjectTouchInput、Linux uinput MT-B 设备补齐后接入。
 */
export function remoteInputTouch(phase: string, id: number, x: number, y: number): void {
  const px = Math.round(x)
  const py = Math.round(y)
  const pt = transformPointPure(activeDisplay, px, py, PLATFORM)
  if (phase === 'down') {
    // 兜底单触点：只把第一路触点映射成左键，避免多指互相顶起
    if (pendingTouches.size === 0) {
      injectMoveGlobal(pt)
      remoteInputDown('left')
    }
    pendingTouches.add(id)
  } else if (phase === 'move') {
    if (pendingTouches.has(id) && pendingTouches.size === 1) injectMoveGlobal(pt)
  } else {
    pendingTouches.delete(id)
    if (pendingTouches.size === 0) remoteInputUp('left')
  }
}

/** 手柄状态注入（被控端）。标准 Gamepad 映射：buttons[0..15] 按键，axes[0..3] 左右摇杆。 */
export function remoteInputGamepad(buttons: number[], axes: number[]): void {
  rlogThrottled(S, 'gamepad', `手柄按下 ${buttons.filter(Boolean).length} 键 轴=${axes.length}`, 500)
  if (
    backend === 'windows-rust' || backend === 'linux-rust-uinput' ||
    backend === 'macos-rust-cgevent'
  ) {
    helperSend({ t: 'gamepad', buttons, axes })
  }
}

/** 光标可见性由系统/设备自己决定，注入侧不再强制显示或隐藏鼠标。 */
export function remoteInputShowCursor(): void {
  // 保留空实现以兼容旧的 cursorShow 指令；不调用 ShowCursor。
}

/** 统一分发一条控制端经 DataChannel 发来的控制指令（{ t, ... }）。 */
/** 需要注入后端的指令类型；后端不可用时显式告警，不静默丢弃。 */
const INJECT_EVENTS = new Set([
  'move', 'down', 'up', 'scroll', 'kdown', 'kup', 'touchdown', 'touchmove', 'touchup', 'gamepad'
])

export function remoteInputDispatch(evt: Record<string, unknown>): void {
  const t = typeof evt?.t === 'string' ? evt.t : ''
  if (backend === 'none' && INJECT_EVENTS.has(t)) {
    rwarn(S, `注入后端不可用，丢弃指令 t=${t}`)
    return
  }
  switch (t) {
    case 'move': remoteInputMove(Number(evt.x) || 0, Number(evt.y) || 0); break
    case 'down': remoteInputDown(String(evt.btn ?? 'left')); break
    case 'up': remoteInputUp(String(evt.btn ?? 'left')); break
    case 'scroll': remoteInputScroll(Number(evt.d) || 0); break
    case 'kdown': remoteInputKeyDown(Number(evt.k) || 0); break
    case 'kup': remoteInputKeyUp(Number(evt.k) || 0); break
    case 'touchdown': remoteInputTouch('down', Number(evt.touchId) || 0, Number(evt.x) || 0, Number(evt.y) || 0); break
    case 'touchmove': remoteInputTouch('move', Number(evt.touchId) || 0, Number(evt.x) || 0, Number(evt.y) || 0); break
    case 'touchup': remoteInputTouch('up', Number(evt.touchId) || 0, Number(evt.x) || 0, Number(evt.y) || 0); break
    case 'gamepad':
      remoteInputGamepad(
        Array.isArray(evt.buttons) ? evt.buttons.map(Number) : [],
        Array.isArray(evt.axes) ? evt.axes.map(Number) : []
      )
      break
    case 'cursorShow': remoteInputShowCursor(); break
    default: rwarn(S, `未知控制指令：${JSON.stringify(evt).slice(0, 200)}`); break
  }
}

/**
 * 断线/结束复位：补发所有「按下中」的 Up，解冻光标边界。
 * 光标可见性交给系统，不在此恢复或强制显隐。
 */
export function remoteInputReset(): void {
  if (pendingButtons.size || pendingKeys.size) {
    rlog(S, `复位：补发 ${pendingButtons.size} 个鼠标 Up、${pendingKeys.size} 个键盘 Up`)
  }
  for (const b of [...pendingButtons]) remoteInputUp(b)
  for (const code of [...pendingKeys]) remoteInputKeyUp(code)
  pendingButtons.clear()
  pendingKeys.clear()
  if (pendingTouches.size) {
    remoteInputUp('left')
    pendingTouches.clear()
  }
  if (backend === 'windows-rust') {
    sendWinMode({ t: 'clipfree' })
  }
  cursorLocked = false
}

/**
 * 快捷键解锁被控端本地鼠标：解冻光标边界 + 复位按下中。
 * 仅解锁当前会话，不改动光标可见性。
 */
export function remoteInputUnlock(): void {
  for (const b of [...pendingButtons]) remoteInputUp(b)
  for (const code of [...pendingKeys]) remoteInputKeyUp(code)
  pendingButtons.clear()
  pendingKeys.clear()
  if (pendingTouches.size) {
    remoteInputUp('left')
    pendingTouches.clear()
  }
  if (backend === 'windows-rust') {
    sendWinMode({ t: 'clipfree' })
  }
  cursorLocked = false
}

/** 彻底停止（会话结束）：复位 + 结束常驻进程。 */
export function remoteInputStop(): void {
  remoteInputReset()
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
}

/** 应用退出前兜底清理：子进程不会随父进程自动退出，必须显式收掉 */
export function remoteInputShutdown(): void {
  try { remoteInputStop() } catch { console.warn('结束远程输入失败') }
}
