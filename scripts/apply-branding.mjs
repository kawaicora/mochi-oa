/**
 * 打包品牌注入：electron-builder 前临时把 productName 设为 resources/brand.json 里的 name，
 * 打包结束后还原 package.json（避免 git 噪音）。中文字符走文件写入，不用 shell 参数防乱码。
 * 用法：node scripts/apply-branding.mjs --win | --mac | --linux
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv.find((a) => ['--win', '--mac', '--linux'].includes(a)) || '--win'
const pkgPath = join(root, 'package.json')
const orig = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(orig)

let name = ''
let appId = ''
let description = ''
try {
  const b = JSON.parse(readFileSync(join(root, 'resources', 'brand.json'), 'utf8'))
  if (b && typeof b.name === 'string' && b.name.trim()) name = b.name.trim()
  if (b && typeof b.appId === 'string' && b.appId.trim()) appId = b.appId.trim()
  if (b && typeof b.description === 'string' && b.description.trim()) description = b.description.trim()
} catch {
  /* brand.json 缺失/损坏用 package.json 默认 */
}

console.log(`[branding] productName = ${name || '(默认)'}, appId = ${appId || '(默认)'}, description = ${description || '(默认)'}`)

if (name) {
  pkg.build = pkg.build || {}
  pkg.build.productName = name
}
if (appId) {
  pkg.build = pkg.build || {}
  pkg.build.appId = appId
}
if (description) {
  // 应用描述写 package.json 顶层 description（electron-builder 从顶层读，build.description 不合法）
  pkg.description = description
}
if (name || appId || description) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

try {
  // 用 node 直接跑 electron-builder 的 cli.js（跨平台；直接 spawn .cmd 在 Windows 上会 EINVAL）
  const cli = join(root, 'node_modules', 'electron-builder', 'cli.js')
  execFileSync(process.execPath, [cli, target, '--publish', 'never'], { stdio: 'inherit', cwd: root })
} finally {
  writeFileSync(pkgPath, orig, 'utf8') // 打包结束还原 package.json
}
