import { BrowserWindow, clipboard, ipcMain } from 'electron'
import {
  EVENT_COALESCE_MS,
  IPC,
  IPC_EVENTS,
  MAX_PAYLOAD_BYTES,
  type SessionEvent
} from '@contract/index'
import {
  clipboardWriteSchema,
  fileIdSchema,
  fileOpenSchema,
  fileReadSchema,
  filesListSchema,
  modelSelectSchema,
  projectPathSchema,
  promptSchema,
  tabIdSchema,
  tabNewSchema,
  tabOpenSchema
} from '@contract/schemas'
import { trimMessageUpdate } from '@contract/stream'
import type { HostState } from './state'

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * 把事件负载压到上限以内。
 *
 * 超长内容截断，不静默丢弃 —— 截断处留标记，渲染进程能看出被切过。
 */
function capPayload(value: unknown): unknown {
  const json = JSON.stringify(value)
  if (json === undefined) return null
  if (json.length <= MAX_PAYLOAD_BYTES) return value
  return {
    __truncated: true,
    __originalBytes: json.length,
    preview: json.slice(0, 4096)
  }
}

/** 增量事件按窗口合并，避免每条事件都过一次 IPC */
class Coalescer {
  private queue: SessionEvent[] = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly flushTo: (events: SessionEvent[]) => void,
    private readonly interval = EVENT_COALESCE_MS
  ) {}

  push(event: SessionEvent): void {
    this.queue.push(event)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const batch = this.queue
      this.queue = []
      if (batch.length > 0) this.flushTo(batch)
    }, this.interval)
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.queue = []
  }
}

export function registerIpc(state: HostState): () => void {
  const coalescer = new Coalescer((events) => {
    broadcast(IPC_EVENTS.session, events.map((e) => ({ ...e, data: capPayload(e.data) })))
  })

  state.on('snapshot', (snapshot) => {
    broadcast(IPC_EVENTS.snapshot, snapshot)
  })

  state.on('session-event', (event: { type: string; data: unknown; tabId: string }) => {
    const data = event.type === 'message_update' ? trimMessageUpdate(event.data) : event.data
    coalescer.push({ type: event.type, data, at: Date.now(), tabId: event.tabId })
  })

  ipcMain.handle(IPC.snapshotGet, () => state.snapshot())

  // —— 标签 ——

  ipcMain.handle(IPC.projectsOpen, async () => {
    await state.openProject()
    return state.snapshot()
  })

  ipcMain.handle(IPC.projectsRemove, async (_event, payload: unknown) => {
    const { path } = projectPathSchema.parse(payload)
    await state.removeProject(path)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsOpen, async (_event, payload: unknown) => {
    const { path, cwd } = tabOpenSchema.parse(payload)
    await state.openConversation(path, cwd)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsNew, async (_event, payload: unknown) => {
    const { cwd } = tabNewSchema.parse(payload)
    await state.newConversation(cwd)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsActivate, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    await state.activateTab(tabId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsClose, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    await state.closeTab(tabId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsReload, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    await state.reloadTab(tabId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsEntries, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    return state.readEntries(tabId)
  })

  // —— 会话 ——

  ipcMain.handle(IPC.promptSend, async (_event, payload: unknown) => {
    const { tabId, text } = promptSchema.parse(payload)
    await state.prompt(tabId, text)
  })

  ipcMain.handle(IPC.clipboardWrite, (_event, payload: unknown) => {
    const { text } = clipboardWriteSchema.parse(payload)
    clipboard.writeText(text)
  })

  // —— 文件 ——

  ipcMain.handle(IPC.filesList, async (_event, payload: unknown) => {
    const { cwd, dir } = filesListSchema.parse(payload)
    return state.listFiles(cwd, dir)
  })

  ipcMain.handle(IPC.filesRead, async (_event, payload: unknown) => {
    const { cwd, path } = fileReadSchema.parse(payload)
    return state.readFile(cwd, path)
  })

  ipcMain.handle(IPC.filesOpen, async (_event, payload: unknown) => {
    const { cwd, path } = fileOpenSchema.parse(payload)
    await state.openFile(cwd, path)
    return state.snapshot()
  })

  ipcMain.handle(IPC.filesClose, async (_event, payload: unknown) => {
    const { fileId } = fileIdSchema.parse(payload)
    await state.closeFile(fileId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.filesActivate, async (_event, payload: unknown) => {
    const { fileId } = fileIdSchema.parse(payload)
    await state.activateFile(fileId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.modelsList, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    return state.listModels(tabId)
  })

  ipcMain.handle(IPC.modelsSelect, async (_event, payload: unknown) => {
    const { tabId, provider, id, persist } = modelSelectSchema.parse(payload)
    await state.selectModel(tabId, provider, id, persist)
  })

  return () => {
    coalescer.dispose()
    ipcMain.removeHandler(IPC.snapshotGet)
    ipcMain.removeHandler(IPC.projectsOpen)
    ipcMain.removeHandler(IPC.projectsRemove)
    ipcMain.removeHandler(IPC.tabsOpen)
    ipcMain.removeHandler(IPC.tabsNew)
    ipcMain.removeHandler(IPC.tabsActivate)
    ipcMain.removeHandler(IPC.tabsClose)
    ipcMain.removeHandler(IPC.tabsReload)
    ipcMain.removeHandler(IPC.tabsEntries)
    ipcMain.removeHandler(IPC.promptSend)
    ipcMain.removeHandler(IPC.clipboardWrite)
    ipcMain.removeHandler(IPC.filesList)
    ipcMain.removeHandler(IPC.filesRead)
    ipcMain.removeHandler(IPC.filesOpen)
    ipcMain.removeHandler(IPC.filesClose)
    ipcMain.removeHandler(IPC.filesActivate)
    ipcMain.removeHandler(IPC.modelsList)
    ipcMain.removeHandler(IPC.modelsSelect)
  }
}
