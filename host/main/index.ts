import { app, BrowserWindow, shell } from 'electron'
import { IPC_EVENTS } from '@contract/index'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { registerIpc } from './ipc'
import { applySettings, registerConsoleIpc } from './consoleIpc'
import { refreshDockMenu } from './dockMenu'
import { SettingsStore } from './settings'
import { APP_ORIGIN, registerSchemesAsPrivileged, serveRenderer } from './protocol'
import { HostState } from './state'
import { BrowserManager } from './browser'

/*
 * 自动化测试用：把 userData 指到临时目录。
 *
 * 必须在 HostState 构造之前设置 —— ProjectStore / TabStore 在构造函数里就
 * 读 app.getPath('userData')，晚一步就会写到真实用户目录。
 */
if (process.env.CODELET_USER_DATA) {
  app.setPath('userData', process.env.CODELET_USER_DATA)
}

// 必须在 app.ready 之前注册，否则相对路径 / fetch / ES module 脚本会失效
registerSchemesAsPrivileged()

const currentDir = dirname(fileURLToPath(import.meta.url))
const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const isDev = Boolean(rendererDevUrl)

const state = new HostState({
  contextDiffDir: join(app.getPath('userData'), 'context-diff'),
  consoleDir: join(app.getPath('userData'), 'debug-console')
})
/** 设置的取值：存在应用数据目录里 */
const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
let disposeIpc: (() => void) | null = null
let disposeConsoleIpc: (() => void) | null = null
let browser: BrowserManager | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // 非 macOS 的 Dock/任务栏图标从窗口上取。macOS 走上面 whenReady 里的 app.dock
    ...(process.platform === 'darwin'
      ? {}
      : { icon: join(currentDir, '../../build/icon.png') }),
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

  browser = new BrowserManager(win, (state) => {
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed()) target.webContents.send(IPC_EVENTS.browser, state)
    }
  })
  state.attachBrowser(browser)
  /*
   * 自动化测试用的钩子：E2E 要直接驱动浏览器工具（快照、点击、截图），
   * 走模型太慢。只在设置了 CODELET_USER_DATA 的测试环境里挂。
   */
  if (process.env.CODELET_USER_DATA) {
    ;(globalThis as unknown as { __codeletBrowser?: BrowserManager }).__codeletBrowser = browser
    /*
     * 导出用的保存对话框同理：原生面板 Playwright 点不到，
     * 测试里换成直接返回路径。默认落到临时目录里。
     */
    ;(globalThis as unknown as { __codeletSaveDialog?: unknown }).__codeletSaveDialog = {
      showSaveDialog: async (options: { defaultPath?: string }) => ({
        canceled: false,
        filePath: join(tmpdir(), options.defaultPath ?? 'codelet-console.zip')
      })
    }
  }
  // 必须在窗口真正销毁前移除原生 view；窗口关闭后再 removeChildView 可能卡住。
  win.on('close', () => {
    browser?.dispose()
    browser = null
  })

  win.once('ready-to-show', () => {
    win.setTitle('Codelet')
    refreshDockMenu()
    win.show()
  })
  win.on('closed', () => refreshDockMenu())

  /*
   * 离开够久再切回来，就重读一次会话列表。
   *
   * 会话列表的刷新本来是事件驱动的，但那只覆盖「Codelet 自己的 runtime」——
   * 用户在裸 pi 的 TUI 里说话时，那是另一个进程，我们收不到事件，
   * 列表就一直不动，只有重启才更新。
   *
   * 用 blur / focus 配对而不是「每次 focus 都读」：
   * 一次重读要解析那几个项目的 jsonl（实测 180ms），
   * 点了下别的窗口又点回来不该付这个代价。
   */
  win.on('blur', () => state.noteBlur())
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
    /*
     * 开发时 Dock 里是 Electron 的默认图标 —— 因为跑的是 node_modules 里那个
     * Electron 二进制，不是我们的 .app 包，包里没有 icon.icns。
     * 手动塞一个进去，省得开一次 dev 就看一次蓝电子。
     *
     * 打包之后这段不执行：.app 自带 Contents/Resources/icon.icns，
     * 系统按 Info.plist 自己找，不需要也不应该在这里再设一次。
     */
    if (isDev && process.platform === 'darwin') {
      app.dock?.setIcon(join(currentDir, '../../build/icon.png'))
    }

    if (!isDev) {
      serveRenderer(join(currentDir, '../renderer'))
    }

    disposeIpc = registerIpc(state, () => browser)
    disposeConsoleIpc = registerConsoleIpc(state, settings)
    // 设置里的开关和上限要落到存储上 —— 开关是运行时状态，打开就生效
    applySettings(state, settings)
    // 老记录补上会话标题（只读一小块，不解压整个容器）
    setTimeout(() => {
      try {
        state.console.backfillTitles()
      } catch {
        // 补不上不影响主流程
      }
    }, 2000)
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
    disposeConsoleIpc?.()
    void state.dispose()
  })
}
