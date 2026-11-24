/**
 * 编译远程键鼠助手（Rust crate：plugins/remote-input-helper），并把 release 产物落到
 * resources/remote-input-helper/<plat>-<arch>/，由 electron-builder extraResources 随包带走。
 *
 * 说明：
 * - 与 electron-builder 打包架构对齐：Windows/Linux 同时出 amd64 + arm64；macOS 出宿主架构。
 * - 仅编译当前宿主平台；跨平台产物需在对应 OS 上各自打包（与 sing-box 预编译分目录口径一致）。
 * - 本机未装 cargo 时给出告警并跳过（开发态会回退到旧后端），不阻断打包。
 * - 宿主架构编译失败视为错误并非零退出；附加架构（如 arm64）缺 Rust target / 链接器时
 *   告警跳过该架构，不阻断整包打包（对应架构的被控端回退旧后端）。
 *
 * 用法：node scripts/build-helper.mjs
 */
import { existsSync, mkdirSync, copyFileSync, chmodSync, statSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 占用类错误码：目标二进制被运行中的实例/杀软扫描锁住，稍等重试。 */
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EMFILE', 'ENFILE'])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 复制产物到 resources 目录。目标 exe 可能被上一轮运行的远程助手进程或杀软占用，
 * 先做有限次退避重试；仍被锁则保留旧产物并告警跳过，不阻断整包打包（开发态会回退旧后端）。
 */
async function copyHelperBin(src, dst) {
  const retries = 6
  const backoffMs = 500
  for (let i = 1; i <= retries; i++) {
    try {
      // 旧目标先摘除；摘不掉说明被占用，直接进入复制重试
      try { rmSync(dst, { force: true }) } catch { /* ignore */ }
      copyFileSync(src, dst)
      return true
    } catch (e) {
      const code = e?.code ?? ''
      if (!LOCKED_CODES.has(code) || i === retries) throw e
      console.warn(`[helper] 目标产物被占用（${code}），${backoffMs}ms 后重试 ${i}/${retries}…`)
      await sleep(backoffMs)
    }
  }
  return false
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const crateDir = join(root, 'plugins', 'remote-input-helper')

const plat = process.platform // win32 | linux | darwin
const hostArch = process.arch === 'x64' ? 'amd64' : process.arch
const binName = plat === 'win32' ? 'remote-input-helper.exe' : 'remote-input-helper'

/** 各平台需要编译的架构与对应 Rust target。 */
const PLATFORM_TARGETS = {
  win32: [
    { arch: 'amd64', target: 'x86_64-pc-windows-msvc' },
    { arch: 'arm64', target: 'aarch64-pc-windows-msvc' }
  ],
  linux: [
    { arch: 'amd64', target: 'x86_64-unknown-linux-gnu' },
    { arch: 'arm64', target: 'aarch64-unknown-linux-gnu' }
  ],
  darwin: [
    { arch: hostArch, target: hostArch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin' }
  ]
}

function resolveCargo() {
  const env = process.env.CARGO
  const candidates = env ? [env] : ['cargo', 'cargo.exe']
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      /* try next */
    }
  }
  return null
}

const cargo = resolveCargo()
if (!cargo) {
  console.warn('[helper] 未找到 cargo，跳过 Rust 助手编译（将回退旧后端）。安装 Rust 工具链后重新打包即可内置助手。')
  process.exit(0)
}

if (!existsSync(join(crateDir, 'Cargo.toml'))) {
  console.warn(`[helper] 未找到 crate：${crateDir}，跳过。`)
  process.exit(0)
}

const targets = PLATFORM_TARGETS[plat] ?? []
let anyCopied = false

for (const t of targets) {
  const primary = t.arch === hostArch
  const outDir = join(root, 'resources', 'remote-input-helper', `${plat}-${t.arch}`)
  const releaseBin = join(crateDir, 'target', t.target, 'release', binName)
  const outBin = join(outDir, binName)

  console.log(`[helper] cargo build --release (${plat}-${t.arch} / ${t.target})`)
  try {
    execFileSync(cargo, ['build', '--release', '--target', t.target, '--manifest-path', join(crateDir, 'Cargo.toml')], {
      cwd: crateDir,
      stdio: 'inherit'
    })
  } catch (e) {
    if (primary) {
      console.error(`[helper] 宿主架构 ${t.arch} 编译失败，终止打包。`)
      process.exit(1)
    }
    console.warn(`[helper] 跳过附加架构 ${t.arch}（${t.target}）：编译失败。可先执行 rustup target add ${t.target} 并装好对应链接器后重新打包。`)
    continue
  }

  if (!existsSync(releaseBin)) {
    if (primary) {
      console.error(`[helper] 编译完成但产物不存在：${releaseBin}`)
      process.exit(1)
    }
    console.warn(`[helper] 跳过附加架构 ${t.arch}：产物不存在 ${releaseBin}`)
    continue
  }

  mkdirSync(outDir, { recursive: true })
  let copied = false
  try {
    copied = await copyHelperBin(releaseBin, outBin)
  } catch (e) {
    console.warn(`[helper] 复制 ${t.arch} 产物失败（${e?.code ?? e}），保留旧产物继续打包。`)
  }

  if (copied && plat !== 'win32') {
    try { chmodSync(outBin, 0o755) } catch { /* ignore */ }
  }

  if (copied && existsSync(outBin)) {
    anyCopied = true
    const size = statSync(outBin).size
    console.log(`[helper] 已落盘：${outBin}（${(size / 1024).toFixed(1)} KiB）`)
  } else if (existsSync(outBin)) {
    const size = statSync(outBin).size
    console.warn(`[helper] 未能刷新 ${t.arch} 产物，沿用旧文件：${outBin}（${(size / 1024).toFixed(1)} KiB）`)
  } else {
    console.warn(`[helper] ${t.arch} 无可用助手产物（回退旧后端）。`)
  }
}

if (!anyCopied) {
  console.warn('[helper] 本次未产出任何内置 Rust 助手（打包将不含助手，回退旧后端）。')
}
