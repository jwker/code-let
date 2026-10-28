/// <reference types="vite/client" />

import type { CodeletApi } from '@contract/index'

declare global {
  interface Window {
    /**
     * preload 暴露的宿主能力。
     * 在 Electron 里一定有；在普通浏览器里打开（预览模式）时没有。
     */
    codelet?: CodeletApi
  }
}

export {}
