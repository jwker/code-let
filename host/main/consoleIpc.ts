import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC, IPC_EVENTS, type ConsoleExportRequest } from '@contract/index'
import type { ConsoleEvent, ConsoleExportProgress } from '@contract/console'
import { APP_ORIGIN } from './protocol'
import { refreshDockMenu } from './dockMenu'
import type { HostState } from './state'
import type { SettingsStore } from './settings'
import { writeZip, type ZipEntry } from './zip'

/**
 * 调试控制台与设置相关的 IPC。
 *
 * 导出在主进程做：几个 GB 的包不能搬进渲染进程。
 * 主进程边读边写 zip，边报进度，渲染进程只发指令和收进度。
 */

/** 正在进行的导出 —— 用来取消 */
const jobs = new Map<string, { cancelled: boolean }>()

function broadcast(event: ConsoleEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.console, event)
  }
}

function report(jobId: string, progress: Omit<ConsoleExportProgress, 'jobId'>): void {
  broadcast({ type: 'export', progress: { jobId, ...progress } })
}

/** 保存对话框的参数 —— 只用到这几个 */
interface SaveDialogOptions {
  title: string
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

/**
 * 调保存对话框。
 *
 * 自动化测试里可以换掉 —— 存到 `globalThis.__codeletSaveDialog` 上，
 * 免得测试卡在原生对话框上（原生面板 Playwright 点不到）。
 */
async function showSaveDialog(
  parent: BrowserWindow | undefined,
  options: SaveDialogOptions
): Promise<{ canceled: boolean; filePath?: string }> {
  const override = (
    globalThis as unknown as {
      __codeletSaveDialog?: {
        showSaveDialog: (
          options: SaveDialogOptions
        ) => Promise<{ canceled: boolean; filePath?: string }>
      }
    }
  ).__codeletSaveDialog
  if (override) return override.showSaveDialog(options)
  return parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
}

export function registerConsoleIpc(state: HostState, settings: SettingsStore): () => void {
  // 存储那边写完一条记录就推一下 —— 列表和统计跟着变
  const onUpdated = (): void => {
    broadcast({ type: 'updated', stats: state.console.stats() })
  }
  state.on('console-updated', onUpdated)

  ipcMain.handle(IPC.consoleList, () => {
    // 顺带把老记录的会话标题补上 —— 只第一次费工夫
    state.console.backfillTitles()
    return state.console.list()
  })

  ipcMain.handle(IPC.consoleField, (_event, payload: unknown) => {
    const { recordId, path } = payload as { recordId?: unknown; path?: unknown }
    if (typeof recordId !== 'string' || typeof path !== 'string') return null
    return state.console.readField(recordId, path)
  })

  ipcMain.handle(IPC.consoleStats, () => state.console.stats())

  ipcMain.handle(IPC.consoleDelete, (_event, payload: unknown) => {
    const { recordId } = payload as { recordId?: unknown }
    if (typeof recordId !== 'string') return { deleted: 0 }
    const deleted = state.console.deleteRecord(recordId) ? 1 : 0
    broadcast({ type: 'updated', stats: state.console.stats() })
    return { deleted }
  })

  ipcMain.handle(IPC.consoleDeleteSession, (_event, payload: unknown) => {
    const { sessionId } = payload as { sessionId?: unknown }
    if (typeof sessionId !== 'string') return { deleted: 0 }
    const deleted = state.console.deleteSession(sessionId)
    broadcast({ type: 'updated', stats: state.console.stats() })
    return { deleted }
  })

  ipcMain.handle(IPC.consoleDeleteRecords, (_event, payload: unknown) => {
    const { recordIds } = payload as { recordIds?: unknown }
    if (!Array.isArray(recordIds)) return { deleted: 0 }
    const ids = recordIds.filter((id): id is string => typeof id === 'string')
    const deleted = state.console.deleteRecords(ids)
    broadcast({ type: 'updated', stats: state.console.stats() })
    return { deleted }
  })

  ipcMain.handle(IPC.consoleDeleteAll, () => {
    const deleted = state.console.deleteAll()
    broadcast({ type: 'updated', stats: state.console.stats() })
    return { deleted }
  })

  ipcMain.handle(IPC.consoleReveal, async () => {
    const dir = state.console.directory
    await shell.openPath(dir)
  })

  ipcMain.handle(IPC.consoleWindowOpen, async () => {
    await openConsoleWindow()
  })

  ipcMain.handle(IPC.consoleWindowClose, () => {
    consoleWindow?.close()
  })

  ipcMain.handle(IPC.consoleExport, async (_event, payload: unknown) => {
    const request = payload as ConsoleExportRequest
    const scope = request?.scope
    if (scope !== 'record' && scope !== 'records' && scope !== 'sessions' && scope !== 'all') {
      return { ok: false, jobId: '', message: '导出范围不对' }
    }
    const jobId = `job-${Date.now()}-${Math.floor(Math.random() * 1000)}`
    const job = { cancelled: false }
    jobs.set(jobId, job)

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    /*
     * 保存对话框必须挂在窗口上。
     *
     * 不给父窗口的话，macOS 会把它当成一个独立窗口弹出来 —— 可能出现在应用窗口后面，
     * 用户看着就是「点了没反应」。给了父窗口它就是挂在窗口上的面板，不会跑到后面去。
     */
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options = {
      title: '导出请求记录',
      defaultPath: `codelet-console-${stamp}.zip`,
      filters: [{ name: 'zip 压缩包', extensions: ['zip'] }]
    }
    const save = await showSaveDialog(parent, options)
    if (save.canceled || !save.filePath) {
      jobs.delete(jobId)
      return { ok: false, jobId, cancelled: true }
    }

    try {
      const { files, records } = state.console.collectExportFiles(
        scope,
        request.recordId,
        request.sessionIds,
        request.recordIds
      )
      const manifest = JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          records: records.map((record) => ({
            id: record.id,
            sessionId: record.sessionId,
            sessionName: record.sessionName,
            capturedAt: record.capturedAt,
            model: record.model,
            providerStatus: record.providerStatus,
            sizes: record.sizes,
            truncated: record.truncated
          }))
        },
        null,
        2
      )

      async function* entries(): AsyncGenerator<ZipEntry> {
        yield { name: 'manifest.json', data: Buffer.from(manifest, 'utf8') }
        for (const file of files) {
          if (job.cancelled) return
          yield { name: file.name, data: await readFile(file.path) }
        }
      }

      report(jobId, { state: 'running', done: 0, total: files.length + 1, bytes: 0 })
      const result = await writeZip(save.filePath, entries(), (done, bytes) => {
        report(jobId, { state: 'running', done, total: files.length + 1, bytes })
      })
      if (job.cancelled) {
        report(jobId, { state: 'cancelled', done: result.count, total: files.length + 1, bytes: result.bytes })
        return { ok: false, jobId, cancelled: true }
      }
      report(jobId, {
        state: 'done',
        done: result.count,
        total: files.length + 1,
        bytes: result.bytes,
        path: save.filePath
      })
      return { ok: true, jobId, path: save.filePath, bytes: result.bytes }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report(jobId, { state: 'failed', done: 0, total: 0, bytes: 0, message })
      return { ok: false, jobId, message }
    } finally {
      jobs.delete(jobId)
    }
  })

  ipcMain.handle(IPC.consoleExportCancel, (_event, payload: unknown) => {
    const { jobId } = payload as { jobId?: unknown }
    if (typeof jobId !== 'string') return
    const job = jobs.get(jobId)
    if (job) job.cancelled = true
  })

  // —— 设置 ——

  ipcMain.handle(IPC.settingsGet, () => settings.all())

  ipcMain.handle(IPC.settingsSet, (_event, payload: unknown) => {
    const { id, value } = payload as { id?: unknown; value?: unknown }
    if (typeof id !== 'string') return false
    const ok = settings.set(id, value)
    if (ok) applySettings(state, settings)
    return ok
  })

  ipcMain.handle(IPC.settingsOpen, async () => {
    await openSettingsWindow()
  })

  return () => {
    state.off('console-updated', onUpdated)
    ipcMain.removeHandler(IPC.consoleList)
    ipcMain.removeHandler(IPC.consoleField)
    ipcMain.removeHandler(IPC.consoleStats)
    ipcMain.removeHandler(IPC.consoleDelete)
    ipcMain.removeHandler(IPC.consoleDeleteSession)
    ipcMain.removeHandler(IPC.consoleDeleteRecords)
    ipcMain.removeHandler(IPC.consoleDeleteAll)
    ipcMain.removeHandler(IPC.consoleReveal)
    ipcMain.removeHandler(IPC.consoleWindowOpen)
    ipcMain.removeHandler(IPC.consoleWindowClose)
    ipcMain.removeHandler(IPC.consoleExport)
    ipcMain.removeHandler(IPC.consoleExportCancel)
    ipcMain.removeHandler(IPC.settingsGet)
    ipcMain.removeHandler(IPC.settingsSet)
    ipcMain.removeHandler(IPC.settingsOpen)
    jobs.clear()
  }
}

/** 设置落到控制台存储上 —— 开关即时生效 */
export function applySettings(state: HostState, settings: SettingsStore): void {
  const record = settings.get('console.record')
  state.console.setEnabled(record !== false)
  const max = settings.get('console.maxRecordBytes')
  if (typeof max === 'number') state.console.setMaxRecordBytes(max)
}

/** 设置窗口 —— 复用同一个渲染页面，靠查询参数区分 */
let settingsWindow: BrowserWindow | null = null

/** 控制台的独立窗口（从右侧面板分离出去的） */
let consoleWindow: BrowserWindow | null = null

/** 渲染页面上的地址：开发时是 vite dev server，打包后走 app:// 协议 */
function rendererUrl(param: string): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return devUrl ? `${devUrl}?window=${param}` : `${APP_ORIGIN}/index.html?window=${param}`
}

export async function openConsoleWindow(): Promise<void> {
  if (consoleWindow && !consoleWindow.isDestroyed()) {
    consoleWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 560,
    height: 860,
    minWidth: 380,
    minHeight: 420,
    title: '调试控制台',
    show: false,
    webPreferences: {
      preload: join(currentDir(), '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  consoleWindow = win
  win.on('closed', () => {
    consoleWindow = null
    refreshDockMenu()
  })
  await win.loadURL(rendererUrl('console'))
  // 文档里的 <title> 会盖掉窗口标题 —— 加载完再设一次
  win.setTitle('调试控制台')
  refreshDockMenu()
  win.show()
}

export async function openSettingsWindow(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 720,
    height: 520,
    title: '设置',
    show: false,
    webPreferences: {
      preload: join(currentDir(), '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  settingsWindow = win
  win.on('closed', () => {
    settingsWindow = null
    refreshDockMenu()
  })
  await win.loadURL(rendererUrl('settings'))
  win.setTitle('设置')
  refreshDockMenu()
  win.show()
}

function currentDir(): string {
  // out/main/index.mjs → out/main
  return fileURLToPath(new URL('.', import.meta.url))
}
