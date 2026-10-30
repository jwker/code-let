import { app, BrowserWindow, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIpc } from './ipc'
import { APP_ORIGIN, registerSchemesAsPrivileged, serveRenderer } from './protocol'
import { HostState } from './state'

// 必须在 app.ready 之前注册，否则相对路径 / fetch / ES module 脚本会失效
registerSchemesAsPrivileged()

const currentDir = dirname(fileURLToPath(import.meta.url))
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(rendererDevUrl)

const state = new HostState()
let disposeIpc: (() => void) | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // 渲染进程还没画之前的窗口底色 —— 默认主题是亮色
    backgroundColor: '#f4f4f5',
    // macOS：标题栏整条交给渲染进程，红绿灯压在自绘标题栏左侧
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    // 标题栏 44px，红绿灯 12px —— 居中放（(44-12)/2 = 16）
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 16 } : undefined,
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

  /*
   * 窗口重新获得焦点时重读会话列表。
   *
   * 会话列表的刷新本来是事件驱动的，但那只覆盖「Codelet 自己的 runtime」——
   * 用户在裸 pi 的 TUI 里说话时，那是另一个进程，我们收不到事件，
   * 列表就一直不动，只有重启才更新。切回窗口是最自然的「我期望它是最新的」时刻。
   */
  win.on('focus', () => {
    void state.refreshOnFocus()
  })

  if (isDev) {
    void win.loadURL(rendererDevUrl as string)
  } else {
    void win.loadURL(`${APP_ORIGIN}/index.html`)
  }

  // 外链走系统浏览器，不在应用里开窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(async () => {
    if (!isDev) {
      serveRenderer(join(currentDir, '../renderer'))
    }

    disposeIpc = registerIpc(state)
    createWindow()
    // 初始化失败不能把窗口晾在这儿 —— 记下来，界面还在，能看到错误
    await state.init().catch((error) => {
      console.error('宿主状态初始化失败:', error)
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeIpc?.()
    void state.dispose()
  })
}
