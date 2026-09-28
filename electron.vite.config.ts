import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import javascriptObfuscator from 'vite-plugin-javascript-obfuscator'
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [
      vue(),
      javascriptObfuscator({
        // 指定需要混淆的文件，通常排除 node_modules
        include: ['src/**/*.{js,ts,vue}'], 
        exclude: ['node_modules/**'],
        // 混淆选项，参考 javascript-obfuscator
        options: {
          compact: true, // 压缩代码
          controlFlowFlattening: true, // 控制流扁平化（核心混淆手段）
          controlFlowFlatteningThreshold: 0.75,
          stringArray: true, // 字符串数组化
          stringArrayEncoding: ['base64'], // 字符串 Base64 编码
          stringArrayThreshold: 0.75,
          identifierNamesGenerator: 'hexadecimal', // 变量名十六进制化
          renameGlobals: false, // 不要重命名全局变量，防止破坏 Vue/Pinia
          selfDefending: true, // 自我防御，防止格式化
          debugProtection: true, // 防止调试
          disableConsoleOutput: true, // 移除 console
        }
      })
    ],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          meeting: resolve(__dirname, 'src/renderer/meeting.html'),
          task: resolve(__dirname, 'src/renderer/task.html')
        }
      }
    }
  }
})
