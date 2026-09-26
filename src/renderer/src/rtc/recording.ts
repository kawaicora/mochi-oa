/**
 * 通话/会议录制落盘助手。
 * 把 MediaRecorder 产出的 webm Blob 转 base64，经主进程写入
 * {downloadDir}/通话录制/{name}.webm（downloadDir 默认 文档/麻薯）。
 */

export interface SaveRecordingResult {
  ok: boolean
  path?: string
  error?: string
}

/** Blob → base64（分块，避免大数组展开爆栈/内存） */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000 // 32k
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

/**
 * 保存一次录制。
 * @param blob webm 录制数据
 * @param kind video | audio（决定文件名不区分，仅留档）
 * @param label 场景标识，如 dm-123 / group-456 / meeting-abc
 */
export async function saveCallRecording(
  blob: Blob,
  kind: 'video' | 'audio',
  label: string
): Promise<SaveRecordingResult> {
  try {
    const base64 = await blobToBase64(blob)
    const safeLabel = (label || 'call').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)
    const ts = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}`
    const name = `通话录制_${safeLabel}_${stamp}.webm`
    return await window.pantry.appSaveRecording(name, base64)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
