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