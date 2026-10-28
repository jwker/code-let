import { BrowserWindow, ipcMain } from 'electron'
import {
  EVENT_COALESCE_MS,
  IPC,
  IPC_EVENTS,
  MAX_PAYLOAD_BYTES,
  type SessionEvent
} from '@contract/index'
import { promptSchema, switchConversationSchema, switchProjectSchema } from '@contract/schemas'
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

  state.on('session-event', (event: { type: string; data: unknown }) => {
    const data = event.type === 'message_update' ? trimMessageUpdate(event.data) : event.data
    coalescer.push({ type: event.type, data, at: Date.now() })
  })

  ipcMain.handle(IPC.snapshotGet, () => state.snapshot())

  ipcMain.handle(IPC.sessionEntries, () => state.readEntries())

  ipcMain.handle(IPC.projectsOpen, async () => {
    await state.openProject()
    return state.snapshot()
  })

  ipcMain.handle(IPC.projectsSwitch, async (_event, payload: unknown) => {
    const { path } = switchProjectSchema.parse(payload)
    await state.switchProject(path, { remember: true })
    return state.snapshot()
  })

  ipcMain.handle(IPC.conversationsNew, async () => {
    await state.newConversation()
    return state.snapshot()
  })

  ipcMain.handle(IPC.conversationsSwitch, async (_event, payload: unknown) => {
    const { path } = switchConversationSchema.parse(payload)
    await state.switchConversation(path)
    return state.snapshot()
  })

  ipcMain.handle(IPC.promptSend, async (_event, payload: unknown) => {
    const { text } = promptSchema.parse(payload)
    await state.prompt(text)
  })

  return () => {
    coalescer.dispose()
    ipcMain.removeHandler(IPC.snapshotGet)
    ipcMain.removeHandler(IPC.sessionEntries)
    ipcMain.removeHandler(IPC.projectsOpen)
    ipcMain.removeHandler(IPC.projectsSwitch)
    ipcMain.removeHandler(IPC.conversationsNew)
    ipcMain.removeHandler(IPC.conversationsSwitch)
    ipcMain.removeHandler(IPC.promptSend)
  }
}
