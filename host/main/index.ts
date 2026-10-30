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
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    webPreferences: {
      preload: join(currentDir, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.once('ready-to-show', () => win.show())

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
