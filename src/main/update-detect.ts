/**
 * 更新包平台/架构/版本识别（主进程侧）。
 *
 * 职责边界：客户端在上传前本地识别，把 platform / archs / version 随 multipart 上报；
 * 服务端只负责存包与合并 version 文件，不做外部解包。
 *
 * 识别手段：
 *  - Windows .exe：读 PE COFF Machine 字段。
 *  - Linux .AppImage：读 ELF e_machine。
 *  - macOS .zip：解出 *.app/Contents/MacOS/<主二进制>，读 Mach-O fat / 单二进制 CPU 类型。
 *  - macOS .dmg：客户端无法解码 UDIF 内部二进制，架构退回到文件名 token；表单 arch 可覆盖。
 *  - 版本号：从文件名 semver 提取。
 */
import { readFile } from 'node:fs/promises'
import JSZip from 'jszip'

export interface DetectedPackage {
  /** 标准平台名：windows / linux / darwin */
  platform: string
  /** 标准架构名：x86_64 / arm64（可多个，通用包） */
  archs: string[]
  /** 识别到的 semver 版本号，可能为空 */
  version: string
}

const PLATFORM_BY_EXT: Record<string, string> = {
  exe: 'windows',
  appimage: 'linux',
  zip: 'darwin',
  dmg: 'darwin'
}

const ARCH_TOKEN_RE = /(arm64|aarch64|x64|x86_64|amd64)/gi
const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/

/** Mach-O CPU 类型。 */
const CPU_X86_64 = 0x01000007
const CPU_ARM64 = 0x0100000c

function normalizeArch(token: string): string {
  switch (token.toLowerCase()) {
    case 'arm64':
    case 'aarch64':
      return 'arm64'
    case 'x64':
    case 'x86_64':
    case 'amd64':
      return 'x86_64'
  }
  return ''
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

/** peArch 从 PE COFF 头 Machine 字段解析架构。 */
function peArch(b: Buffer): string {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) return ''
  const peOff = b.readUInt32LE(0x3c)
  if (peOff + 4 > b.length || b.toString('ascii', peOff, peOff + 4) !== 'PE\0\0') return ''
  const machine = b.readUInt16LE(peOff + 4)
  switch (machine) {
    case 0x8664: // AMD64
      return 'x86_64'
    case 0xaa64: // ARM64
      return 'arm64'
    default:
      return ''
  }
}

/** elfArch 从 ELF e_machine 解析架构。 */
function elfArch(b: Buffer): string {
  if (b.length < 20 || b.toString('binary', 0, 4) !== '\x7fELF') return ''
  switch (b.readUInt16LE(18)) {
    case 62: // EM_X86_64
      return 'x86_64'
    case 183: // EM_AARCH64
      return 'arm64'
    default:
      return ''
  }
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

function mapCpu(cpu: number): string {
  switch (cpu) {
    case CPU_X86_64:
      return 'x86_64'
    case CPU_ARM64:
      return 'arm64'
    default:
      return ''
  }
}

/** machoArchs 从 Mach-O fat 通用头或单二进制头解析全部架构。 */
function machoArchs(b: Buffer): string[] {
  if (b.length < 8) return []
  const out: string[] = []
  const seen = new Set<string>()
  const push = (a: string): void => {
    if (a && !seen.has(a)) {
      seen.add(a)
      out.push(a)
    }
  }

  const leMagic = b.readUInt32LE(0)
  const beMagic = b.readUInt32BE(0)
  const cpuOf = (o: number, le: boolean): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))

  let fat = false
  let le = false
  let fat64 = false
  switch (leMagic) {
    case 0xcafebabe:
      fat = true
      le = false
      break
    case 0xbebafeca:
      fat = true
      le = true
      break
    case 0xcafebabf:
      fat = true
      le = false
      fat64 = true
      break
    case 0xbebafbaf:
      fat = true
      le = true
      fat64 = true
      break
    case 0xfeedface:
    case 0xfeedfacf:
      push(mapCpu(cpuOf(4, true)))
      return out
    case 0xcefaedfe:
    case 0xcffaedfe:
      push(mapCpu(cpuOf(4, false)))
      return out
  }
  if (!fat) {
    if (beMagic === 0xcafebabe || beMagic === 0xcafebabf) {
      fat = true
      le = false
      fat64 = beMagic === 0xcafebabf
    } else if (beMagic === 0xbebafeca || beMagic === 0xbebafbaf) {
      fat = true
      le = true
      fat64 = beMagic === 0xbebafbaf
    } else {
      return out
    }
  }

  const nfat = Math.min(le ? b.readUInt32LE(4) : b.readUInt32BE(4), 16)
  const entrySize = fat64 ? 32 : 20
  for (let i = 0; i < nfat; i++) {
    const o = 8 + i * entrySize
    if (o + 4 > b.length) break
    push(mapCpu(cpuOf(o, le)))
  }
  return out
}

/** zipMachArchs 解 macOS zip 分发包，定位主二进制读取 Mach-O 架构。 */
async function zipMachArchs(b: Buffer): Promise<string[]> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(b)
  } catch {
    return []
  }
  const out: string[] = []
  const seen = new Set<string>()
  let matched = 0
  for (const [name, entry] of Object.entries(zip.files)) {
    if (matched >= 4) break
    const idx = name.indexOf('/Contents/MacOS/')
    if (idx < 0) continue
    const base = name.slice(idx + '/Contents/MacOS/'.length)
    if (!base || base.includes('/') || base.includes('.')) continue
    try {
      const raw = Buffer.from(await entry.async('nodebuffer'))
      for (const a of machoArchs(raw.subarray(0, 4096))) {
        if (!seen.has(a)) {
          seen.add(a)
          out.push(a)
        }
      }
    } catch {
      // 跳过损坏/不可读条目
    }
    matched++
  }
  return out
}

/** filenameArchs 从文件名 token 提取架构（dmg 兜底）。 */
function filenameArchs(name: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of name.match(ARCH_TOKEN_RE) ?? []) {
    const a = normalizeArch(m)
    if (a && !seen.has(a)) {
      seen.add(a)
      out.push(a)
    }
  }
  return out
}

/** filenameVersion 从文件名提取 semver。 */
function filenameVersion(name: string): string {
  const m = name.match(SEMVER_RE)
  return m ? m[0] : ''
}

/** detectFromBuffer 从已读入内存的安装包缓冲识别平台/架构/版本。 */
export function detectFromBuffer(buf: Buffer, name: string): DetectedPackage {
  const ext = extOf(name)
  const platform = PLATFORM_BY_EXT[ext] ?? ''

  const archs: string[] = []
  const seen = new Set<string>()
  const add = (a: string): void => {
    if (a && !seen.has(a)) {
      seen.add(a)
      archs.push(a)
    }
  }

  if (platform === 'windows') {
    add(peArch(buf))
  } else if (platform === 'linux') {
    add(elfArch(buf))
  } else if (platform === 'darwin' && ext === 'zip') {
    // zipMachArchs 为异步，Buffer 直解析架构见 detectUpdatePackage；此处同步层不处理 zip 内部。
  }
  // 文件名 token 兜底（dmg 无法在客户端解码内部二进制）。
  for (const a of filenameArchs(name)) add(a)

  // 版本号：exe 优先 PE 资源 VS_FIXEDFILEINFO；AppImage/dmg 内部分 squashfs/UDIF 无法在
  // Node 内解压，退回到文件名 semver。
  let version = filenameVersion(name)
  if (platform === 'windows') {
    const pv = peVersion(buf)
    if (pv && pv !== '0.0.0') version = pv
  }

  return { platform, archs, version }
}

/** detectFromBufferAsync 在同步识别基础上，补做 macOS zip 内部 Mach-O 解析。 */
export async function detectFromBufferAsync(buf: Buffer, name: string): Promise<DetectedPackage> {
  const base = detectFromBuffer(buf, name)
  if (base.platform === 'darwin' && extOf(name) === 'zip') {
    for (const a of await zipMachArchs(buf)) {
      if (!base.archs.includes(a)) base.archs.push(a)
    }
  }
  return base
}

/** detectUpdatePackage 读取本地安装包并识别平台/架构/版本。 */
export async function detectUpdatePackage(filePath: string, name: string): Promise<DetectedPackage> {
  const buf = await readFile(filePath)
  return detectFromBufferAsync(buf, name)
}
