import { app, webContents } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";


function safeStr(v: unknown): string {
  if (typeof v === 'string') return v
  try { const s = JSON.stringify(v); return s == null ? String(v) : s } catch { return String(v) }
}

export function getCallerInfo(): { method: string; file: string; line: string } | null {
  const err: any = new Error();
  // ✅ 排除 getCallerInfo 自身 + wrap 返回的闭包函数
  Error.captureStackTrace(err, getCallerInfo);
  Error.captureStackTrace(err, _callerWrapper);
  
  const stackLines = err.stack?.split('\n');
  if (!stackLines) return null;

  for (let i = 0; i < stackLines.length; i++) {
    const line = stackLines[i].trim();
    if (!line.startsWith('at ')) continue;

    const match = line.match(/at (.+?) \((.+):(\d+):(\d+)\)/);
    if (match) {
      const [, method, file, lineNum] = match;
      if (file.includes('electron') || file.includes('app.asar')) continue;
      return { method, file, line: lineNum };
    }

    const match2 = line.match(/at (.+):(\d+):(\d+)/);
    if (match2) {
      const [, file, lineNum] = match2;
      if (file.includes('electron') || file.includes('app.asar')) continue;
      return { method: '<anonymous>', file, line: lineNum };
    }
  }
  return null;
}

// ✅ 单独命名，方便 captureStackTrace 排除
function _callerWrapper(orig: (...a: unknown[]) => void, tag: string) {
  const logFile = () => {
    const dir = join(app.getPath('userData'), 'logs');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, 'renderer-console.log');
  };
  return (...args: unknown[]): void => {
    orig(...args);
    const callInfo = getCallerInfo();
    const info = callInfo
      ? `[${callInfo.method}] ${callInfo.file}:${callInfo.line}`
      : '[unknown]';
    const line = `[${new Date().toISOString()}] [${tag}] ${info} ${args.map(safeStr).join(' ')}`;
    try { appendFileSync(logFile(), line + '\n', 'utf8'); } catch { /* 忽略 */ }
    try {
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed()) wc.send('__main_console', line);
      }
    } catch { /* 忽略 */ }
  };
}

export function patchConsoleToFile(): void {
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };
  console.log   = _callerWrapper(orig.log,   'LOG');
  console.warn  = _callerWrapper(orig.warn,  'WARN');
  console.error = _callerWrapper(orig.error, 'ERROR');
  console.info  = _callerWrapper(orig.info,  'INFO');
  console.debug = _callerWrapper(orig.debug, 'DEBUG');
}