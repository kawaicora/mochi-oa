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
try {
  const b = JSON.parse(readFileSync(join(root, 'resources', 'brand.json'), 'utf8'))
  if (b && typeof b.name === 'string' && b.name.trim()) name = b.name.trim()
} catch {
  /* brand.json 缺失/损坏用 package.json 默认 productName */
}

console.log(`[branding] productName = ${name || '(默认)'}`)

if (name) {
  pkg.build = pkg.build || {}
  pkg.build.productName = name
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

try {
  const bin = process.platform === 'win32'
    ? join(root, 'node_modules', '.bin', 'electron-builder.cmd')
    : join(root, 'node_modules', '.bin', 'electron-builder')
  execFileSync(bin, [target, '--publish', 'never'], { stdio: 'inherit', cwd: root })
} finally {
  writeFileSync(pkgPath, orig, 'utf8') // 打包结束还原 package.json
}
