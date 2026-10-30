import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import javascriptObfuscator from 'vite-plugin-javascript-obfuscator'
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      sourcemap: true,
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
    ],
    build: {
      outDir: 'out/renderer',
      // minify: 'esbuild',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        output: {
          sourcemapExcludeSources: false
        },
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          meeting: resolve(__dirname, 'src/renderer/meeting.html'),
          task: resolve(__dirname, 'src/renderer/task.html'),
          screenshot: resolve(__dirname, 'src/renderer/screenshot.html'),
          toolbar: resolve(__dirname, 'src/renderer/toolbar.html'),
          preview: resolve(__dirname, 'src/renderer/preview.html'),
          remote: resolve(__dirname, 'src/renderer/remote.html')
        }
      }
    }
  }
})
