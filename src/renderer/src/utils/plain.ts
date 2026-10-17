/**
 * 深拷贝为普通对象，剥掉 Vue3 reactive 的 Proxy。
 *
 * 背景：Electron contextBridge 在「主世界 → 隔离世界」传参时就用结构化克隆，
 * Vue reactive 代理在【进入 preload 之前】就克隆失败，抛 "An object could not be cloned."。
 * 因此凡把 ref 持有的数组/对象传给 window.pantry.server* 前，必须先 toPlain。
 *
 * Date / ArrayBuffer / TypedArray 原样返回；函数/符号跳过；WeakSet 防循环引用。
 */
export function toPlain<T = unknown>(v: T, seen: WeakSet<object> = new WeakSet()): T {
  if (v === null || typeof v !== 'object') return v
  if (typeof v === 'function' || typeof v === 'symbol') return undefined as T
  if (v instanceof Date) return v
  if (v instanceof ArrayBuffer) return v
  if (ArrayBuffer.isView(v)) return v
  if (seen.has(v as object)) return undefined as T
  seen.add(v as object)
  if (Array.isArray(v)) return v.map((item) => toPlain(item, seen)) as T
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as Record<string, unknown>)) {
    out[k] = toPlain((v as Record<string, unknown>)[k], seen)
  }
  return out as T
}
