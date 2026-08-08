import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * electron-vite bundles three targets:
 *  - main    → src/main/index.ts  (Node/Electron main process)
 *  - preload → src/preload/index.ts
 *  - renderer → src/renderer/index.html (Vite dev server with HMR)
 *
 * `externalizeDepsPlugin` keeps node_modules as runtime require() calls
 * instead of inlining them — required for playwright (native/binary).
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
