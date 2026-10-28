import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// electron-vite 始终从工程根目录运行
const root = process.cwd()

const alias = {
  '@contract': resolve(root, 'contract'),
  '@view': resolve(root, 'view'),
  '@ext': resolve(root, 'ext')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(root, 'host/main/index.ts') },
        // Pi 是 ESM-only，且必须外部化：它内部的模块映射要解析到同一份实例
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    resolve: { alias },
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(root, 'host/preload/index.ts') },
        // sandbox: true 的 preload 必须是 CJS
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    },
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve(root, 'host/renderer'),
    resolve: { alias },
    build: {
      outDir: resolve(root, 'out/renderer'),
      rollupOptions: {
        input: { index: resolve(root, 'host/renderer/index.html') }
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
