import { app, webContents } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";




export function patchConsoleToFile(): void {
  function safeStr(v: unknown): string {
    if (typeof v === 'string') return v
    try { const s = JSON.stringify(v); return s == null ? String(v) : s } catch { return String(v) }
  }

  const file = () => {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return join(dir, 'renderer-console.log')
  }

  const wrap = (fn: (...a: unknown[]) => void, tag: string) => {
    const orig = fn.bind(console)
    return (...args: unknown[]): void => {
      orig(...args)
      const line = `[${new Date().toISOString()}] [${tag}] ${args.map(safeStr).join(' ')}`
      try { appendFileSync(file(), line + '\n', 'utf8') } catch { /* 忽略 */ }
      // 转发到所有窗口渲染层控制台（Ctrl+Shift+I 可见），保证主进程日志也输出到控制台
      try {
        for (const wc of webContents.getAllWebContents()) {
          if (!wc.isDestroyed()) wc.send('__main_console', line)
        }
      } catch { /* 忽略 */ }
    }
  }


  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };
  console.log   = wrap(orig.log,   'LOG');
  console.warn  = wrap(orig.warn,  'WARN');
  console.error = wrap(orig.error, 'ERROR');
  console.info  = wrap(orig.info,  'INFO');
  console.debug = wrap(orig.debug, 'DEBUG');
}




// ---- 主进程全局错误日志：异常写入 userData/logs/main-error.log 且同时 console.error（统一到渲染层控制台），避免报错闪现丢失 ----
export function logMainError(tag: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${err instanceof Error ? (err.stack || err.message) : String(err)}`
  console.error(line) // 走 patchMainConsoleToFile：终端 + renderer-console.log + 渲染层控制台
  try {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'main-error.log'), line + '\n', 'utf8')
  } catch {
    /* 日志写入失败静默，避免二次抛错 */
  }
}

// 渲染进程日志统一走 console → 下方 web-contents-created 的 console-message 捕获落盘，无需 logError IPC。

// ---- 渲染层全量 console 落盘：userData/logs/renderer-console.log ----
// 覆盖所有窗口（主窗口 / meeting / task / 通知等）的 console.log/warn/error。
// 这样 WebRTC、socket 等渲染层日志无需开 DevTools 也能查看，排查直连/中转、ICE、协商过程。
// 仅允许 console 输出（不改各渲染层代码），这里统一捕获转发到文件。
export function logRendererConsole(contents: Electron.WebContents): void {
  const file = join(app.getPath('userData'), 'logs', 'renderer-console.log')
  try {
    const dir = join(app.getPath('userData'), 'logs')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  } catch { console.warn('[logRendererConsole] create log directory failed'); return }
  // Electron 版本差异：新版事件为 (event: Event<{...params}>)；旧版为 (event, level, message, line, sourceId)。两者兼容。
  contents.on('console-message', (event: unknown, ...rest: unknown[]) => {
    try {
      let level = 'info', message = '', line = '', source = ''
      const ev = event as { params?: { level?: number; message?: string; lineNumber?: number; sourceId?: string }; level?: number; message?: string; lineNumber?: number; sourceId?: string }
      if (ev && typeof ev === 'object' && 'params' in ev && ev.params) {
        const p = ev.params
        level = ['verbose', 'info', 'warning', 'error'][p.level ?? 1] ?? 'info'
        message = p.message ?? ''
        line = String(p.lineNumber ?? '')
        source = p.sourceId ?? ''
      } else {
        const lvl = typeof ev.level === 'number' ? ev.level : Number(rest[0] ?? 1)
        level = ['verbose', 'info', 'warning', 'error'][lvl] ?? 'info'
        message = String(typeof ev.message === 'string' && ev.message ? ev.message : rest[1] ?? '')
        line = String(ev.lineNumber ?? rest[3] ?? '')
        source = String(ev.sourceId ?? rest[4] ?? '')
      }
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message} (${source}:${line})\n`, 'utf8')
    } catch { console.warn('[logRendererConsole] write log failed') }
  })
}

