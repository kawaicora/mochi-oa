// tools/compile-bytenode.mjs
// 用 bytenode 把主进程/预加载的编译产物 JS 编译成 V8 字节码(.jsc) 二进制，并把原 JS 替换为 loader。
// 运行时解包拿到的是字节码，无法直接还原成明文 JS。
// 用 bytenode 的 -e -ep 指定 Electron 可执行文件，确保字节码 V8 版本与运行时一致。
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
// 在 Node（非 Electron 运行时）下，require('electron') 返回 electron 可执行文件路径
const electronPath = require('electron')
const cli = path.resolve('node_modules/bytenode/lib/cli.js')

function compile(file) {
  if (!fs.existsSync(file)) {
    console.warn('[obf] skip (missing):', file)
    return
  }
  const cmd = `node "${cli}" -e -ep "${electronPath}" -c "${file}"`
  execSync(cmd, { stdio: 'inherit' })
  const base = path.basename(file).replace(/\.js$/, '.jsc')
  // loader：先注册 .jsc 扩展，再加载字节码
  const loader = `require('bytenode');\nrequire('./${base}')`
  fs.writeFileSync(file, loader, 'utf8')
  console.log('[obf] compiled ->', file.replace(/\.js$/, '.jsc'))
}

compile(path.resolve('out/main/index.js'))
compile(path.resolve('out/preload/index.js'))
console.log('[obf] done')
