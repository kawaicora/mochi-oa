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
let pkgName = ''
let appId = ''
let description = ''
let iconPath = ''
try {
  const b = JSON.parse(readFileSync(join(root, 'resources', 'brand.json'), 'utf8'))
  // 字段名严格对应 package.json：显示名用 productName，安装名用 name
  if (b && typeof b.productName === 'string' && b.productName.trim()) name = b.productName.trim()
  if (b && typeof b.name === 'string' && b.name.trim()) pkgName = b.name.trim()
  if (b && typeof b.appId === 'string' && b.appId.trim()) appId = b.appId.trim()
  if (b && typeof b.description === 'string' && b.description.trim()) description = b.description.trim()
  if (b && typeof b.iconPath === 'string' && b.iconPath.trim()) iconPath = b.iconPath.trim()
} catch {
  /* brand.json 缺失/损坏用 package.json 默认 */
}

console.log(`[branding] productName = ${name || '(默认)'}, name = ${pkgName || '(默认)'}, appId = ${appId || '(默认)'}, description = ${description || '(默认)'}, icon = ${iconPath || '(默认)'}`)

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
if (iconPath) {
  // 三端安装包/任务栏图标：指向 resources/ 下的品牌图标（electron-builder 相对项目根，png 可自动转 ico）
  const icon = join('resources', iconPath)
  pkg.build = pkg.build || {}
  pkg.build.win = { ...(pkg.build.win || {}), icon }
  pkg.build.mac = { ...(pkg.build.mac || {}), icon }
  pkg.build.linux = { ...(pkg.build.linux || {}), icon }
}
if (pkgName) {
  // 用 brand.json 的 name 替换 package.json 顶层 name → 安装路径/可执行名随品牌走
  pkg.name = pkgName
  pkg.build = pkg.build || {}
  pkg.build.executableName = pkgName
}
if (name || pkgName || appId || description || iconPath) writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

try {
  // 用 node 直接跑 electron-builder 的 cli.js（跨平台；直接 spawn .cmd 在 Windows 上会 EINVAL）
  const cli = join(root, 'node_modules', 'electron-builder', 'cli.js')
  execFileSync(process.execPath, [cli, target, '--publish', 'never'], { stdio: 'inherit', cwd: root })
} finally {
  writeFileSync(pkgPath, orig, 'utf8') // 打包结束还原 package.json
}
