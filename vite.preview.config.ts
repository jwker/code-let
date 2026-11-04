import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 只跑渲染进程，用普通浏览器预览（走 mock 宿主）
const root = process.cwd()

export default defineConfig({
  root: resolve(root, 'host/renderer'),
  resolve: {
    alias: {
      '@contract': resolve(root, 'contract'),
      '@view': resolve(root, 'view'),
      '@ext': resolve(root, 'ext')
    }
  },
  server: { port: 5174, strictPort: true },
  plugins: [react(), tailwindcss()]
})
