import { app, BrowserWindow, screen, shell } from 'electron'
import { IPC_EVENTS } from '@contract/index'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { registerIpc } from './ipc'
import { applySettings, registerConsoleIpc } from './consoleIpc'
import { broadcastModelEvent, openAuthUrl, registerModelIpc } from './modelIpc'
import { ModelManager } from './modelManager'
import { refreshDockMenu } from './dockMenu'
import { SettingsStore } from './settings'
import { APP_ORIGIN, registerSchemesAsPrivileged, serveRenderer } from './protocol'
import { HostState } from './state'
import { BrowserManager } from './browser'
import {
  isOnSomeDisplay,
  loadWindowState,
  saveWindowState,
  windowStateFile,
  type WindowState
} from './windowState'

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
let disposeModelIpc: (() => void) | null = null
let browser: BrowserManager | null = null

/**
 * 大模型管理。
 *
 * 登录事件发给所有窗口；授权链接顺手在浏览器里打开 ——
 * OAuth 的那一步在浏览器里完成，界面上留一份链接是给人手工兜底的。
 */
const modelManager = new ModelManager({
  emit: (event) => {
    broadcastModelEvent(event)
    if (event.type === 'auth_url') {
      void openAuthUrl(event.url)
    } else if (event.type === 'device_code') {
      void openAuthUrl(event.verificationUri)
    }
  }
})

/**
 * 启动时铺满屏幕。
 *
 * macOS 的 `maximize()` 靠不住（老版本是空操作），所以自己按显示器的工作区算边界 ——
 * 工作区已经把菜单栏与 Dock 排除在外，窗口盖满的是能用的那块。
 *
 * 多屏时铺**光标所在**的那块 —— 跟人正在看的屏幕一致。
 */
function fillScreen(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    win.setBounds(display.workArea)
    return
  }
  win.maximize()
}

/** 窗口状态文件的位置 */
const windowStateFilePath = windowStateFile(app.getPath('userData'))

/** 取当前窗口状态，准备存 */
function currentWindowState(win: BrowserWindow): WindowState {
  const bounds = win.getNormalBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: win.isMaximized()
  }
}

/**
 * 按存下来的状态摆窗口。
 *
 * 位置不在任何一块屏幕上了（显示器拔了），或者压根没存过 —— 返回 false，
 * 交给 `fillScreen` 铺满。
 */
function restoreWindow(win: BrowserWindow, state: WindowState | null): boolean {
  if (!state) return false
  const workAreas = screen.getAllDisplays().map((display) => display.workArea)
  if (!isOnSomeDisplay(state, workAreas)) return false
  win.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height })
  if (state.maximized) win.maximize()
  return true
}

/**
 * 记下窗口的位置与大小。
 *
 * resize / move 在拖动过程中连续触发 —— 拖一下写几十次文件没必要，
 * 停下来再写。关窗时也写一次，把最后的状态留住。
 */
function rememberWindowState(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null
  const write = (): void => {
    if (win.isDestroyed()) return
    saveWindowState(windowStateFilePath, currentWindowState(win))
  }
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, 400)
  }
  win.on('resize', schedule)
  win.on('move', schedule)
  win.on('maximize', schedule)
  win.on('unmaximize', schedule)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    write()
  })
}

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
    // 用户自己调过尺寸就恢复他调过的 —— 恢复不了（没存过、显示器拔了）才铺满屏幕
    if (!restoreWindow(win, loadWindowState(windowStateFilePath))) fillScreen(win)
    rememberWindowState(win)
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
    disposeModelIpc = registerModelIpc(state, modelManager)
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
    disposeModelIpc?.()
    void state.dispose()
  })
}
