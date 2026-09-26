// electron.vite.config.ts
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import vue from "@vitejs/plugin-vue";
var __electron_vite_injected_dirname = "D:\\___SYSTEM_PATH\\source\\repos\\mochi-oa";
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/main",
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/main/index.ts") }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: "out/preload",
      lib: { entry: resolve(__electron_vite_injected_dirname, "src/preload/index.ts") }
    }
  },
  renderer: {
    resolve: {
      alias: {
        "@renderer": resolve(__electron_vite_injected_dirname, "src/renderer/src"),
        "@shared": resolve(__electron_vite_injected_dirname, "src/shared")
      }
    },
    plugins: [vue()],
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          index: resolve(__electron_vite_injected_dirname, "src/renderer/index.html"),
          meeting: resolve(__electron_vite_injected_dirname, "src/renderer/meeting.html")
        }
      }
    }
  }
});
export {
  electron_vite_config_default as default
};
