/**
 * 更新包平台 / 版本识别（主进程侧）。
 *
 * 职责边界：客户端在上传前本地识别，把 platform / version 随 multipart 上报；
 * 服务端只负责存包与合并 version 文件，不做外部解包。
 *
 * 不区分架构：一个安装包同时覆盖 arm64 + x86_64，识别与发布均按平台进行。
 *
 * 识别手段：
 *  - Windows .exe：平台按后缀；版本读 PE 资源 VS_FIXEDFILEINFO。
 *  - Linux .AppImage：平台按后缀；版本封在 squashfs 内，Node 无法解压，退文件名 semver。
 *  - macOS .zip：平台按后缀；版本读包内 Contents/Info.plist 的 CFBundleShortVersionString。
 *  - macOS .dmg：客户端无法解码 UDIF 内部内容，版本退回到文件名 token；表单字段可覆盖。
 */
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

export interface DetectedPackage {
  /** 标准平台名：windows / linux / darwin */
  platform: string
  /** 识别到的 semver 版本号，可能为空 */
  version: string
}

const PLATFORM_BY_EXT: Record<string, string> = {
  exe: 'windows',
  appimage: 'linux',
  zip: 'darwin',
  dmg: 'darwin'
}

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** peVersion 从 PE 资源 VS_FIXEDFILEINFO 解析文件版本（major.minor.build）。 */
function peVersion(b: Buffer): string {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return ''
  const peOff = b.readUInt32LE(0x3c)
  if (peOff + 24 > b.length) return ''
  const coffOff = peOff + 4
  const numSections = b.readUInt16LE(coffOff + 2)
  const optHdrOff = coffOff + 20
  if (optHdrOff + 2 > b.length) return ''
  const magic = b.readUInt16LE(optHdrOff)
  const dataDirOff = magic === 0x10b ? optHdrOff + 96 : optHdrOff + 112
  const resDirOff = dataDirOff + 2 * 8
  if (resDirOff + 8 > b.length) return ''
  const resRVA = b.readUInt32LE(resDirOff)
  const resSize = b.readUInt32LE(resDirOff + 4)
  if (resRVA === 0 || resSize === 0) return ''

  const sizeOptHdr = b.readUInt16LE(coffOff + 16)
  const secTabOff = optHdrOff + sizeOptHdr
  const rvaToOff = (rva: number): number => {
    for (let i = 0; i < numSections; i++) {
      const sOff = secTabOff + i * 40
      const vAddr = b.readUInt32LE(sOff + 12)
      const vSize = b.readUInt32LE(sOff + 8)
      const rawOff = b.readUInt32LE(sOff + 20)
      if (rva >= vAddr && rva < vAddr + vSize) return rva - vAddr + rawOff
    }
    return -1
  }
  const resBase = rvaToOff(resRVA)
  if (resBase < 0) return ''

  interface ResEntry { id: number; isDir: boolean; offset: number }
  const readDir = (dirOff: number): ResEntry[] => {
    const entries: ResEntry[] = []
    const numNamed = b.readUInt16LE(dirOff + 12)
    const numId = b.readUInt16LE(dirOff + 14)
    for (let i = 0; i < numNamed + numId; i++) {
      const eOff = dirOff + 16 + i * 8
      const id = b.readUInt32LE(eOff)
      const dataOrSub = b.readUInt32LE(eOff + 4)
      entries.push({ id, isDir: (dataOrSub & 0x80000000) !== 0, offset: dataOrSub & 0x7fffffff })
    }
    return entries
  }

  const lvl0 = readDir(resBase)
  for (const e of lvl0) {
    if (e.id !== 16) continue // RT_VERSION
    const lvl1 = readDir(resBase + e.offset)
    for (const e1 of lvl1) {
      const lvl2 = readDir(resBase + e1.offset)
      for (const e2 of lvl2) {
        if (e2.isDir) continue
        const dataEntryOff = resBase + e2.offset
        const dataRVA = b.readUInt32LE(dataEntryOff)
        const dataSize = b.readUInt32LE(dataEntryOff + 4)
        const dataOff = rvaToOff(dataRVA)
        if (dataOff < 0 || dataOff + dataSize > b.length) continue
        const fixedOff = dataOff + 40
        if (fixedOff + 52 > b.length) continue
        if (b.readUInt32LE(fixedOff) !== 0xfeef04bd) continue
        const ms = b.readUInt32LE(fixedOff + 8)
        const ls = b.readUInt32LE(fixedOff + 12)
        const major = ms >> 16
        const minor = ms & 0xffff
        const build = ls >> 16
        return `${major}.${minor}.${build}`
      }
    }
  }
  return ''
}

/** filenameVersion 从文件名提取 semver。 */
function filenameVersion(name: string): string {
  const m = name.match(SEMVER_RE)
  return m ? m[0] : ''
}

/** zipPlistVersion 解 macOS zip 包，从 Contents/Info.plist 读取 CFBundleShortVersionString。 */
async function zipPlistVersion(zip: JSZip): Promise<string> {
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!/\/Contents\/Info\.plist$/.test(name)) continue
    try {
      const text = await entry.async('string')
      const m = text.match(/CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)
      if (m) {
        const v = m[1].trim().match(SEMVER_RE)
        if (v) return v[0]
      }
    } catch {
      // 跳过损坏/不可读条目
    }
  }
  return ''
}

/** detectFromBuffer 从已读入内存的安装包缓冲识别平台/版本。 */
export function detectFromBuffer(buf: Buffer, name: string): DetectedPackage {
  const ext = extOf(name)
  const platform = PLATFORM_BY_EXT[ext] ?? ''

  let version = filenameVersion(name)
  if (platform === 'windows') {
    const pv = peVersion(buf)
    if (pv && pv !== '0.0.0') version = pv
  }

  return { platform, version }
}

/** detectFromBufferAsync 在同步识别基础上，补做 macOS zip 内 Info.plist 版本解析。 */
export async function detectFromBufferAsync(buf: Buffer, name: string): Promise<DetectedPackage> {
  const base = detectFromBuffer(buf, name)
  if (base.platform === 'darwin' && extOf(name) === 'zip') {
    try {
      const zip = await JSZip.loadAsync(buf)
      const pv = await zipPlistVersion(zip)
      if (pv) base.version = pv
    } catch {
      // zip 损坏时保留文件名兜底版本
    }
  }
  return base
}

/** detectUpdatePackage 读取本地安装包并识别平台/版本。 */
export async function detectUpdatePackage(filePath: string, name: string): Promise<DetectedPackage> {
  const buf = await readFile(filePath)
  return detectFromBufferAsync(buf, name)
}
