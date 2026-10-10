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
          controlFlowFlattening: false, // 控制流扁平化（核心混淆手段）  不要开 会奔溃
          controlFlowFlatteningThreshold: 0.75,
          stringArray: true, // 字符串数组化
          stringArrayEncoding: ['base64'], // 字符串 Base64 编码
          stringArrayThreshold: 0.75,
          identifierNamesGenerator: 'hexadecimal', // 变量名十六进制化
          renameGlobals: false, // 不要重命名全局变量，防止破坏 Vue/Pinia
          selfDefending: false, // 自我防御，防止格式化  不要开 会奔溃
          debugProtection: false, // 防调试代码会干扰渲染/导致乱码，关闭
          disableConsoleOutput: false, // 保留 console：DevTools(Shift+Ctrl+I) 里能看到日志；编辑器窗口不打印日志（已在组件内移除）
          // 动态 import() 的模块说明符必须保持字面量：
          // 一旦被搬进字符串数组，Rollup 无法静态分析该 import → 不会单独分包，
          // 生产（打包后）运行时会因解析不到模块而失败（PDF/Word/Excel/3D/FLV 预览都依赖这一点）。
          reservedStrings: [
            'pdfjs-dist',
            'docx-preview',
            'xlsx',
            'jszip',
            'flv.js',
            'three/examples/jsm/loaders/OBJLoader.js',
            'three/examples/jsm/loaders/FBXLoader.js',
            'three/examples/jsm/loaders/STLLoader.js',
            'three/examples/jsm/loaders/GLTFLoader.js',
            'three/examples/jsm/controls/OrbitControls.js'
          ]
        }
      })
    ],
    build: {
      outDir: 'out/renderer',
      minify: 'esbuild',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          meeting: resolve(__dirname, 'src/renderer/meeting.html'),
          task: resolve(__dirname, 'src/renderer/task.html'),
          screenshot: resolve(__dirname, 'src/renderer/screenshot.html'),
          toolbar: resolve(__dirname, 'src/renderer/toolbar.html')
        }
      }
    }
  }
})
