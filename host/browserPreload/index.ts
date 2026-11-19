import { ipcRenderer } from 'electron'

/*
 * 通道名照抄 `contract/index.ts` 的 `BROWSER_ANNOTATION_CHANNEL`，故意不 import。
 *
 * 沙箱里的 preload 只能 require('electron') 和白名单模块 —— 一旦两个 preload 入口
 * 共用一个模块，打包器就会拆出共享 chunk，preload 里那句 `require('./chunks/…')`
 * 会把整个 preload 弄失效（渲染层退回假宿主）。这条一致性由
 * `tests/annotationRegistry.test.ts` 的源码断言守着。
 */
const BROWSER_ANNOTATION_CHANNEL = 'host:browser:annotation'

/**
 * 原型预览页面的 preload。
 *
 * 只做一件事：把注入脚本 `post` 出来的标注消息转给主进程。
 * 注入脚本本身不 import electron —— 它只知道「调用 post(message)」，
 * 由这一层决定 post 到底走 IPC 还是 postMessage（`host/main/annotationScript.ts`）。
 */
window.addEventListener('message', (event: MessageEvent) => {
  // 只收这个窗口自己发出的消息；iframe 里别的东西不算
  if (event.source !== window) return
  const data = event.data as { __codeletAnnotation?: unknown; message?: unknown } | null
  if (!data || data.__codeletAnnotation !== true) return
  const message = data.message
  if (!message || typeof message !== 'object') return
  ipcRenderer.send(BROWSER_ANNOTATION_CHANNEL, message)
})
