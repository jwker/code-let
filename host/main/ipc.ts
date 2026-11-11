import { BrowserWindow, clipboard, ipcMain } from 'electron'
import {
  EVENT_COALESCE_MS,
  IPC,
  IPC_EVENTS,
  MAX_PAYLOAD_BYTES,
  type SessionEvent,
  type ThinkingLevel
} from '@contract/index'
import {
  browserBoundsSchema,
  browserNavigateSchema,
  browserTabSchema,
  browserUrlSchema,
  browserVisibleSchema,
  clipboardWriteSchema,
  commandCompleteSchema,
  gitDiffSchema,
  conversationRenameSchema,
  conversationsDeleteSchema,
  fileIdSchema,
  fileOpenSchema,
  fileReadSchema,
  filesListSchema,
  filesSearchCancelSchema,
  filesSearchSchema,
  modelSelectSchema,
  projectPathSchema,
  promptAbortSchema,
  promptSchema,
  tabIdSchema,
  tabNewSchema,
  tabOpenSchema,
  temporaryIdSchema,
  temporaryModelSelectSchema,
  temporaryPromptSchema,
  thinkingSelectSchema
} from '@contract/schemas'
import { compactSessionEvent, trimMessageUpdate } from '@contract/stream'
import type { HostState } from './state'
import type { BrowserManager } from './browser'

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

export function registerIpc(
  state: HostState,
  getBrowser: () => BrowserManager | null = () => null
): () => void {
  const coalescer = new Coalescer((events) => {
    broadcast(IPC_EVENTS.session, events.map((e) => ({ ...e, data: capPayload(e.data) })))
  })

  state.on('snapshot', (snapshot) => {
    broadcast(IPC_EVENTS.snapshot, snapshot)
  })

  state.on('session-event', (event: { type: string; data: unknown; tabId: string }) => {
    const compacted = compactSessionEvent(event)
    const data = compacted.type === 'message_update' ? trimMessageUpdate(compacted.data) : compacted.data
    coalescer.push({ type: compacted.type, data, at: Date.now(), tabId: event.tabId })
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

  ipcMain.handle(IPC.conversationsDelete, async (_event, payload: unknown) => {
    const { paths } = conversationsDeleteSchema.parse(payload)
    return state.deleteConversations(paths)
  })

  ipcMain.handle(IPC.conversationsRename, async (_event, payload: unknown) => {
    const { path, name } = conversationRenameSchema.parse(payload)
    await state.renameConversation(path, name)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsOpen, async (_event, payload: unknown) => {
    const { path, cwd } = tabOpenSchema.parse(payload)
    await state.openConversation(path, cwd)
    return state.snapshot()
  })

  ipcMain.handle(IPC.tabsNew, async (_event, payload: unknown) => {
    const { cwd, name } = tabNewSchema.parse(payload)
    await state.newConversation(cwd, name)
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
    const { tabId, text, attachments, uploads } = promptSchema.parse(payload)
    await state.prompt(tabId, text, attachments, uploads)
  })

  ipcMain.handle(IPC.promptAbort, async (_event, payload: unknown) => {
    const { tabId } = promptAbortSchema.parse(payload)
    await state.abortPrompt(tabId)
  })

  ipcMain.handle(IPC.promptCompact, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    await state.compactTab(tabId)
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

  ipcMain.handle(IPC.filesSearch, async (_event, payload: unknown) => {
    const { cwd, query, limit, requestId } = filesSearchSchema.parse(payload)
    return state.searchFiles(cwd, query, limit, requestId)
  })

  ipcMain.handle(IPC.filesSearchCancel, async (_event, payload: unknown) => {
    const { requestId } = filesSearchCancelSchema.parse(payload)
    state.cancelFileSearch(requestId)
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

  ipcMain.handle(IPC.filesOpenExternal, async (_event, payload: unknown) => {
    const { cwd, path } = fileReadSchema.parse(payload)
    await state.openFileExternal(cwd, path)
  })

  ipcMain.handle(IPC.filesReload, async (_event, payload: unknown) => {
    const { fileId } = fileIdSchema.parse(payload)
    await state.reloadFile(fileId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.modelsList, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    return state.listModels(tabId)
  })

  ipcMain.handle(IPC.attachmentsPick, () => state.pickAttachments())

  ipcMain.handle(IPC.browserGet, () => getBrowser()?.state() ?? { tabs: [], activeTabId: null })

  ipcMain.handle(IPC.browserCreate, async (_event, payload: unknown) => {
    const { url } = browserUrlSchema.parse(payload ?? {})
    return (await getBrowser()?.create(url ?? 'about:blank')) ?? { tabs: [], activeTabId: null }
  })

  ipcMain.handle(IPC.browserClose, async (_event, payload: unknown) => {
    const { tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.close(tabId)) ?? { tabs: [], activeTabId: null }
  })

  ipcMain.handle(IPC.browserActivate, async (_event, payload: unknown) => {
    const { tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.activate(tabId)) ?? { tabs: [], activeTabId: null }
  })

  ipcMain.handle(IPC.browserNavigate, async (_event, payload: unknown) => {
    const { tabId, url } = browserNavigateSchema.parse(payload)
    return (await getBrowser()?.navigate(tabId, url)) ?? { tabs: [], activeTabId: null }
  })

  ipcMain.handle(IPC.browserBack, async (_event, payload: unknown) => {
    const { tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.back(tabId)) ?? { tabs: [], activeTabId: null }
  })

  ipcMain.handle(IPC.browserForward, async (_event, payload: unknown) => {
    const { tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.forward(tabId)) ?? { tabs: [], activeTabId: null }
  })

  ipcMain.handle(IPC.browserReload, async (_event, payload: unknown) => {
    const { tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.reload(tabId)) ?? { tabs: [], activeTabId: null }
  })

  ipcMain.handle(IPC.browserBounds, async (_event, payload: unknown) => {
    const bounds = browserBoundsSchema.parse(payload)
    await getBrowser()?.setBounds(bounds)
  })

  ipcMain.handle(IPC.browserVisible, async (_event, payload: unknown) => {
    const { visible } = browserVisibleSchema.parse(payload)
    await getBrowser()?.setVisible(visible)
  })

  ipcMain.handle(IPC.gitStatus, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    return state.getGitStatus(tabId)
  })

  ipcMain.handle(IPC.gitDiff, async (_event, payload: unknown) => {
    const { tabId, path, scope } = gitDiffSchema.parse(payload)
    return state.getGitDiff(tabId, path, scope)
  })

  ipcMain.handle(IPC.temporaryOpen, () => state.openTemporaryChat())
  ipcMain.handle(IPC.temporaryClose, () => state.closeTemporaryChat())
  ipcMain.handle(IPC.temporaryPrompt, async (_event, payload: unknown) => {
    const { id, text, uploads } = temporaryPromptSchema.parse(payload)
    await state.promptTemporary(id, text, uploads)
  })
  ipcMain.handle(IPC.temporaryAbort, async (_event, payload: unknown) => {
    const { id } = temporaryIdSchema.parse(payload)
    await state.abortTemporary(id)
  })
  ipcMain.handle(IPC.temporaryModels, async (_event, payload: unknown) => {
    const { id } = temporaryIdSchema.parse(payload)
    return state.listTemporaryModels(id)
  })
  ipcMain.handle(IPC.temporaryModelSelect, async (_event, payload: unknown) => {
    const { id, provider, modelId } = temporaryModelSelectSchema.parse(payload)
    return state.selectTemporaryModel(id, provider, modelId)
  })

  ipcMain.handle(IPC.commandsList, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    return state.listCommands(tabId)
  })

  ipcMain.handle(IPC.commandsComplete, async (_event, payload: unknown) => {
    const { tabId, name, prefix } = commandCompleteSchema.parse(payload)
    return state.completeCommand(tabId, name, prefix)
  })

  ipcMain.handle(IPC.thinkingLevels, async (_event, payload: unknown) => {
    const { tabId } = tabIdSchema.parse(payload)
    return state.listThinkingLevels(tabId)
  })

  ipcMain.handle(IPC.thinkingSelect, async (_event, payload: unknown) => {
    const { tabId, level } = thinkingSelectSchema.parse(payload)
    await state.selectThinkingLevel(tabId, level as ThinkingLevel)
    return state.snapshot()
  })

  ipcMain.handle(IPC.extensionErrorsDismiss, () => {
    state.dismissExtensionErrors()
    return state.snapshot()
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
    ipcMain.removeHandler(IPC.conversationsDelete)
    ipcMain.removeHandler(IPC.conversationsRename)
    ipcMain.removeHandler(IPC.tabsOpen)
    ipcMain.removeHandler(IPC.tabsNew)
    ipcMain.removeHandler(IPC.tabsActivate)
    ipcMain.removeHandler(IPC.tabsClose)
    ipcMain.removeHandler(IPC.tabsReload)
    ipcMain.removeHandler(IPC.tabsEntries)
    ipcMain.removeHandler(IPC.promptSend)
    ipcMain.removeHandler(IPC.promptAbort)
    ipcMain.removeHandler(IPC.promptCompact)
    ipcMain.removeHandler(IPC.clipboardWrite)
    ipcMain.removeHandler(IPC.filesList)
    ipcMain.removeHandler(IPC.filesSearch)
    ipcMain.removeHandler(IPC.filesSearchCancel)
    ipcMain.removeHandler(IPC.filesRead)
    ipcMain.removeHandler(IPC.filesOpen)
    ipcMain.removeHandler(IPC.filesClose)
    ipcMain.removeHandler(IPC.filesActivate)
    ipcMain.removeHandler(IPC.filesOpenExternal)
    ipcMain.removeHandler(IPC.filesReload)
    ipcMain.removeHandler(IPC.modelsList)
    ipcMain.removeHandler(IPC.attachmentsPick)
    ipcMain.removeHandler(IPC.browserGet)
    ipcMain.removeHandler(IPC.browserCreate)
    ipcMain.removeHandler(IPC.browserClose)
    ipcMain.removeHandler(IPC.browserActivate)
    ipcMain.removeHandler(IPC.browserNavigate)
    ipcMain.removeHandler(IPC.browserBack)
    ipcMain.removeHandler(IPC.browserForward)
    ipcMain.removeHandler(IPC.browserReload)
    ipcMain.removeHandler(IPC.browserBounds)
    ipcMain.removeHandler(IPC.browserVisible)
    ipcMain.removeHandler(IPC.gitStatus)
    ipcMain.removeHandler(IPC.gitDiff)
    ipcMain.removeHandler(IPC.temporaryOpen)
    ipcMain.removeHandler(IPC.temporaryClose)
    ipcMain.removeHandler(IPC.temporaryPrompt)
    ipcMain.removeHandler(IPC.temporaryAbort)
    ipcMain.removeHandler(IPC.temporaryModels)
    ipcMain.removeHandler(IPC.temporaryModelSelect)
    ipcMain.removeHandler(IPC.commandsList)
    ipcMain.removeHandler(IPC.commandsComplete)
    ipcMain.removeHandler(IPC.thinkingLevels)
    ipcMain.removeHandler(IPC.thinkingSelect)
    ipcMain.removeHandler(IPC.extensionErrorsDismiss)
    ipcMain.removeHandler(IPC.modelsSelect)
  }
}
