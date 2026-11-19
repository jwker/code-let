import { BrowserWindow, clipboard, ipcMain } from 'electron'
import {
  EVENT_COALESCE_MS,
  IPC,
  IPC_EVENTS,
  MAX_PAYLOAD_BYTES,
  type AnnotationState,
  type SessionEvent,
  type BrowserState,
  type ThinkingLevel
} from '@contract/index'
import type { BrowserHost } from '@contract/browser'
import {
  annotationBadgesSchema,
  annotationFocusSchema,
  annotationResolveSchema,
  annotationSetSchema,
  browserBoundsSchema,
  browserNavigateSchema,
  browserStateSchema,
  browserTabSchema,
  browserUrlSchema,
  browserVisibleSchema,
  clipboardWriteSchema,
  commandCompleteSchema,
  gitCwdSchema,
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
  projectPrototypeDirSchema,
  promptAbortSchema,
  promptSchema,
  agentIdSchema,
  agentCreateSchema,
  agentImportSchema,
  agentRenameSchema,
  agentOpenSchema,
  projectTabIdSchema,
  projectPaneSchema,
  temporaryIdSchema,
  temporaryModelSelectSchema,
  temporaryPromptSchema,
  thinkingSelectSchema
} from '@contract/schemas'
import { compactSessionEvent, trimMessageUpdate } from '@contract/stream'
import type { HostState } from './state'
import type { BrowserManager } from './browser'
import { listDocs } from './docs'

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

  state.on('session-event', (event: { type: string; data: unknown; agentId: string }) => {
    const compacted = compactSessionEvent(event)
    const data = compacted.type === 'message_update' ? trimMessageUpdate(compacted.data) : compacted.data
    coalescer.push({ type: compacted.type, data, at: Date.now(), agentId: event.agentId })
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

  ipcMain.handle(IPC.projectsPrototypeDir, async (_event, payload: unknown) => {
    const { cwd, prototypeDir } = projectPrototypeDirSchema.parse(payload)
    await state.setProjectPrototypeDir(cwd, prototypeDir)
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

  ipcMain.handle(IPC.agentsOpen, async (_event, payload: unknown) => {
    const { path, cwd } = agentOpenSchema.parse(payload)
    await state.openConversation(path, cwd)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsCreate, async (_event, payload: unknown) => {
    const { cwd, name, type } = agentCreateSchema.parse(payload)
    await state.newConversation(cwd, name, type)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsNewFrom, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    await state.newAgentFrom(agentId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsActivate, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    await state.activateAgent(agentId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsImport, async (_event, payload: unknown) => {
    const { path } = agentImportSchema.parse(payload)
    await state.importConversation(path)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsRename, async (_event, payload: unknown) => {
    const { agentId, name } = agentRenameSchema.parse(payload)
    await state.renameAgent(agentId, name)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsArchive, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    await state.archiveAgent(agentId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsRestore, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    await state.restoreAgent(agentId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsDelete, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    await state.deleteAgent(agentId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsReload, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    await state.reloadTab(agentId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.agentsEntries, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    return state.readEntries(agentId)
  })

  ipcMain.handle(IPC.projectsActivateTab, async (_event, payload: unknown) => {
    const { tabId } = projectTabIdSchema.parse(payload)
    await state.activateProjectTab(tabId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.projectsCloseTab, async (_event, payload: unknown) => {
    const { tabId } = projectTabIdSchema.parse(payload)
    await state.closeProjectTab(tabId)
    return state.snapshot()
  })

  ipcMain.handle(IPC.projectsSetPane, async (_event, payload: unknown) => {
    const { tabId, pane } = projectPaneSchema.parse(payload)
    await state.setPane(tabId, pane)
    return state.snapshot()
  })

  // —— 会话 ——

  ipcMain.handle(IPC.promptSend, async (_event, payload: unknown) => {
    const { agentId, text, attachments, uploads } = promptSchema.parse(payload)
    /*
     * 测试钩子：E2E 要断言「发出去的消息里带着展开后的引用载荷」，
     * 但真模型在测试里不可用。只在设置了 CODELET_USER_DATA 的测试环境里记一份。
     *
     * CODELET_ECHO_PROMPT 是给「只关心发出去的是什么」的用例用的：记下来就返回，
     * 不调模型 —— 这类用例不该为了看一条消息去请求一个真实 provider。
     */
    if (process.env.CODELET_USER_DATA) {
      ;(
        globalThis as unknown as { __codeletLastPrompt?: { agentId: string; text: string } }
      ).__codeletLastPrompt = { agentId, text }
      if (process.env.CODELET_ECHO_PROMPT) return
    }
    await state.prompt(agentId, text, attachments, uploads)
  })

  ipcMain.handle(IPC.promptAbort, async (_event, payload: unknown) => {
    const { agentId } = promptAbortSchema.parse(payload)
    await state.abortPrompt(agentId)
  })

  ipcMain.handle(IPC.promptCompact, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    await state.compactAgent(agentId)
  })

  ipcMain.handle(IPC.clipboardWrite, (_event, payload: unknown) => {
    const { text } = clipboardWriteSchema.parse(payload)
    clipboard.writeText(text)
  })

  // —— 文档（AI 产物） ——
  ipcMain.handle(IPC.docsList, async (_event, payload: unknown) => {
    const { cwd } = gitCwdSchema.parse(payload)
    return listDocs(cwd)
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
    const { agentId } = agentIdSchema.parse(payload)
    return state.listModels(agentId)
  })

  ipcMain.handle(IPC.attachmentsPick, () => state.pickAttachments())

  /** 没有浏览器时的空状态 —— 也要带上 host，否则渲染层分不清是哪一边 */
  const emptyBrowser = (host: string): BrowserState => ({
    host,
    tabs: [],
    activeTabId: null,
    agent: null
  })

  ipcMain.handle(IPC.browserGet, async (_event, payload: unknown) => {
    const { host } = browserStateSchema.parse(payload ?? {})
    return (await getBrowser()?.getState(host)) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.previewEntry, async (_event, payload: unknown) => {
    const { host } = browserStateSchema.parse(payload ?? {})
    return state.previewEntry(host)
  })

  ipcMain.handle(IPC.browserCreate, async (_event, payload: unknown) => {
    const { host, url } = browserUrlSchema.parse(payload ?? {})
    return (await getBrowser()?.create(host, url ?? 'about:blank')) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.browserClose, async (_event, payload: unknown) => {
    const { host, tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.close(host, tabId)) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.browserActivate, async (_event, payload: unknown) => {
    const { host, tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.activate(host, tabId)) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.browserNavigate, async (_event, payload: unknown) => {
    const { host, tabId, url } = browserNavigateSchema.parse(payload)
    return (await getBrowser()?.navigate(host, tabId, url)) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.browserBack, async (_event, payload: unknown) => {
    const { host, tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.back(host, tabId)) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.browserForward, async (_event, payload: unknown) => {
    const { host, tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.forward(host, tabId)) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.browserReload, async (_event, payload: unknown) => {
    const { host, tabId } = browserTabSchema.parse(payload)
    return (await getBrowser()?.reload(host, tabId)) ?? emptyBrowser(host)
  })

  ipcMain.handle(IPC.browserBounds, async (_event, payload: unknown) => {
    const bounds = browserBoundsSchema.parse(payload)
    await getBrowser()?.setBounds(bounds)
  })

  ipcMain.handle(IPC.browserVisible, async (_event, payload: unknown) => {
    const { host, visible } = browserVisibleSchema.parse(payload)
    await getBrowser()?.setVisible(host, visible)
  })

  // —— 标注（只对 `agent:<id>` 宿主有内容） ——

  const emptyAnnotation = (host: BrowserHost): AnnotationState => ({
    host,
    enabled: false,
    numbers: true,
    file: null,
    blocks: []
  })

  ipcMain.handle(IPC.annotationGet, async (_event, payload: unknown) => {
    const { host } = browserStateSchema.parse(payload ?? {})
    return getBrowser()?.annotationState(host) ?? emptyAnnotation(host)
  })

  ipcMain.handle(IPC.annotationSet, async (_event, payload: unknown) => {
    const { host, enabled } = annotationSetSchema.parse(payload)
    return (await getBrowser()?.setAnnotation(host, enabled)) ?? emptyAnnotation(host)
  })

  ipcMain.handle(IPC.annotationBadges, async (_event, payload: unknown) => {
    const { host, keys, numbers } = annotationBadgesSchema.parse(payload)
    await getBrowser()?.setAnnotationBadges(host, keys, numbers)
  })

  ipcMain.handle(IPC.annotationFocus, async (_event, payload: unknown) => {
    const { host, key } = annotationFocusSchema.parse(payload)
    await getBrowser()?.focusAnnotation(host, key)
  })

  ipcMain.handle(IPC.annotationResolve, async (_event, payload: unknown) => {
    const { host, citations } = annotationResolveSchema.parse(payload)
    return getBrowser()?.resolveCitations(host, citations) ?? citations
  })

  ipcMain.handle(IPC.gitStatus, async (_event, payload: unknown) => {
    const { cwd } = gitCwdSchema.parse(payload)
    return state.getGitStatus(cwd)
  })

  ipcMain.handle(IPC.gitDiff, async (_event, payload: unknown) => {
    const { cwd, path, scope } = gitDiffSchema.parse(payload)
    return state.getGitDiff(cwd, path, scope)
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
    const { agentId } = agentIdSchema.parse(payload)
    return state.listCommands(agentId)
  })

  ipcMain.handle(IPC.commandsComplete, async (_event, payload: unknown) => {
    const { agentId, name, prefix } = commandCompleteSchema.parse(payload)
    return state.completeCommand(agentId, name, prefix)
  })

  ipcMain.handle(IPC.thinkingLevels, async (_event, payload: unknown) => {
    const { agentId } = agentIdSchema.parse(payload)
    return state.listThinkingLevels(agentId)
  })

  ipcMain.handle(IPC.thinkingSelect, async (_event, payload: unknown) => {
    const { agentId, level } = thinkingSelectSchema.parse(payload)
    await state.selectThinkingLevel(agentId, level as ThinkingLevel)
    return state.snapshot()
  })

  ipcMain.handle(IPC.extensionErrorsDismiss, () => {
    state.dismissExtensionErrors()
    return state.snapshot()
  })

  ipcMain.handle(IPC.modelsSelect, async (_event, payload: unknown) => {
    const { agentId, provider, id, persist } = modelSelectSchema.parse(payload)
    await state.selectModel(agentId, provider, id, persist)
  })

  return () => {
    coalescer.dispose()
    ipcMain.removeHandler(IPC.snapshotGet)
    ipcMain.removeHandler(IPC.projectsOpen)
    ipcMain.removeHandler(IPC.projectsRemove)
    ipcMain.removeHandler(IPC.projectsPrototypeDir)
    ipcMain.removeHandler(IPC.conversationsDelete)
    ipcMain.removeHandler(IPC.conversationsRename)
    ipcMain.removeHandler(IPC.agentsOpen)
    ipcMain.removeHandler(IPC.agentsCreate)
    ipcMain.removeHandler(IPC.agentsActivate)
    ipcMain.removeHandler(IPC.agentsImport)
    ipcMain.removeHandler(IPC.agentsRename)
    ipcMain.removeHandler(IPC.agentsArchive)
    ipcMain.removeHandler(IPC.agentsReload)
    ipcMain.removeHandler(IPC.agentsEntries)
    ipcMain.removeHandler(IPC.promptSend)
    ipcMain.removeHandler(IPC.promptAbort)
    ipcMain.removeHandler(IPC.promptCompact)
    ipcMain.removeHandler(IPC.clipboardWrite)
    ipcMain.removeHandler(IPC.docsList)
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
    ipcMain.removeHandler(IPC.previewEntry)
    ipcMain.removeHandler(IPC.browserCreate)
    ipcMain.removeHandler(IPC.browserClose)
    ipcMain.removeHandler(IPC.browserActivate)
    ipcMain.removeHandler(IPC.browserNavigate)
    ipcMain.removeHandler(IPC.browserBack)
    ipcMain.removeHandler(IPC.browserForward)
    ipcMain.removeHandler(IPC.browserReload)
    ipcMain.removeHandler(IPC.browserBounds)
    ipcMain.removeHandler(IPC.browserVisible)
    ipcMain.removeHandler(IPC.annotationGet)
    ipcMain.removeHandler(IPC.annotationSet)
    ipcMain.removeHandler(IPC.annotationBadges)
    ipcMain.removeHandler(IPC.annotationFocus)
    ipcMain.removeHandler(IPC.annotationResolve)
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
