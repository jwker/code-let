import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  IPC_EVENTS,
  type AnnotationEvent,
  type AnnotationState,
  type ConsoleEvent,
  type ConsoleExportRequest,
  type ConsoleExportResult,
  type ConsoleFieldResult,
  type ConsoleListResult,
  type ConsoleStats,
  type CodeletApi,
  type CommandArgumentOption,
  type CommandOption,
  type DeleteConversationsResult,
  type DocsResult,
  type FileContent,
  type FileListResult,
  type FileSearchResult,
  type BrowserEvent,
  type BrowserState,
  type GitDiff,
  type GitStatus,
  type HostSnapshot,
  type ModelOption,
  type ModelAuthEvent,
  type ModelEntry,
  type ModelSettings,
  type ModelSettingsChange,
  type ProviderInfo,
  type PickAttachmentsResult,
  type SessionEvent,
  type StreamItem,
  type ThinkingLevel
} from '@contract/index'

/**
 * contextBridge 暴露面。
 *
 * 渲染进程只能看到这几个方法，别的什么也摸不到。
 */
const api: CodeletApi = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshotGet) as Promise<HostSnapshot>,
  openProject: () => ipcRenderer.invoke(IPC.projectsOpen) as Promise<HostSnapshot>,
  removeProject: (path) => ipcRenderer.invoke(IPC.projectsRemove, { path }) as Promise<HostSnapshot>,
  deleteConversations: (paths) =>
    ipcRenderer.invoke(IPC.conversationsDelete, { paths }) as Promise<DeleteConversationsResult>,
  renameConversation: (path, name) =>
    ipcRenderer.invoke(IPC.conversationsRename, { path, name }) as Promise<HostSnapshot>,
  openConversation: (path, cwd) => ipcRenderer.invoke(IPC.agentsOpen, { path, cwd }) as Promise<HostSnapshot>,
  newConversation: (cwd, name, type) =>
    ipcRenderer.invoke(IPC.agentsCreate, { cwd, name, type }) as Promise<HostSnapshot>,
  activateAgent: (agentId) =>
    ipcRenderer.invoke(IPC.agentsActivate, { agentId }) as Promise<HostSnapshot>,
  newAgentFrom: (agentId) =>
    ipcRenderer.invoke(IPC.agentsNewFrom, { agentId }) as Promise<HostSnapshot>,
  importConversation: (path) =>
    ipcRenderer.invoke(IPC.agentsImport, { path }) as Promise<HostSnapshot>,
  renameAgent: (agentId, name) =>
    ipcRenderer.invoke(IPC.agentsRename, { agentId, name }) as Promise<HostSnapshot>,
  archiveAgent: (agentId) =>
    ipcRenderer.invoke(IPC.agentsArchive, { agentId }) as Promise<HostSnapshot>,
  restoreAgent: (agentId) =>
    ipcRenderer.invoke(IPC.agentsRestore, { agentId }) as Promise<HostSnapshot>,
  deleteAgent: (agentId) => ipcRenderer.invoke(IPC.agentsDelete, { agentId }) as Promise<HostSnapshot>,
  reloadAgent: (agentId) => ipcRenderer.invoke(IPC.agentsReload, { agentId }) as Promise<HostSnapshot>,
  getAgentEntries: (agentId) =>
    ipcRenderer.invoke(IPC.agentsEntries, { agentId }) as Promise<StreamItem[]>,
  activateProjectTab: (tabId) =>
    ipcRenderer.invoke(IPC.projectsActivateTab, { tabId }) as Promise<HostSnapshot>,
  closeProjectTab: (tabId) =>
    ipcRenderer.invoke(IPC.projectsCloseTab, { tabId }) as Promise<HostSnapshot>,
  setPane: (tabId, pane) =>
    ipcRenderer.invoke(IPC.projectsSetPane, { tabId, pane }) as Promise<HostSnapshot>,
  prompt: (agentId, text, attachments, uploads) =>
    ipcRenderer.invoke(IPC.promptSend, { agentId, text, attachments, uploads }),
  abortPrompt: (agentId) => ipcRenderer.invoke(IPC.promptAbort, { agentId }) as Promise<void>,
  compactAgent: (agentId) => ipcRenderer.invoke(IPC.promptCompact, { agentId }) as Promise<void>,
  pickAttachments: () =>
    ipcRenderer.invoke(IPC.attachmentsPick) as Promise<PickAttachmentsResult>,
  /*
   * 浏览器的每条调用都要带 **host**（PLAN.md D57）。
   *
   * 注意：TypeScript 不报「少传参数」—— 零参函数也能赋给「一个参数」的函数类型，
   * 所以这里的 host 漏传时编译是过的，运行时才会在 schema 校验里炸（host undefined）。
   * 这条靠 `tests/preload.test.ts` 的一条源码断言守着。
   */
  getBrowserState: (host) => ipcRenderer.invoke(IPC.browserGet, { host }) as Promise<BrowserState>,
  createBrowserTab: (host, url) =>
    ipcRenderer.invoke(IPC.browserCreate, { host, url }) as Promise<BrowserState>,
  closeBrowserTab: (host, tabId) =>
    ipcRenderer.invoke(IPC.browserClose, { host, tabId }) as Promise<BrowserState>,
  activateBrowserTab: (host, tabId) =>
    ipcRenderer.invoke(IPC.browserActivate, { host, tabId }) as Promise<BrowserState>,
  navigateBrowser: (host, tabId, url) =>
    ipcRenderer.invoke(IPC.browserNavigate, { host, tabId, url }) as Promise<BrowserState>,
  browserBack: (host, tabId) =>
    ipcRenderer.invoke(IPC.browserBack, { host, tabId }) as Promise<BrowserState>,
  browserForward: (host, tabId) =>
    ipcRenderer.invoke(IPC.browserForward, { host, tabId }) as Promise<BrowserState>,
  browserReload: (host, tabId) =>
    ipcRenderer.invoke(IPC.browserReload, { host, tabId }) as Promise<BrowserState>,
  setBrowserBounds: (bounds) => ipcRenderer.invoke(IPC.browserBounds, bounds) as Promise<void>,
  setBrowserVisible: (host, visible) =>
    ipcRenderer.invoke(IPC.browserVisible, { host, visible }) as Promise<void>,
  /*
   * 标注（只有 `agent:<id>` 宿主有内容）。跟浏览器一样，每条调用都带 host ——
   * 少传参数 TypeScript 不报错，靠 tests/preload.test.ts 的源码断言守着。
   */
  getAnnotation: (host) => ipcRenderer.invoke(IPC.annotationGet, { host }) as Promise<AnnotationState>,
  setAnnotation: (host, enabled) =>
    ipcRenderer.invoke(IPC.annotationSet, { host, enabled }) as Promise<AnnotationState>,
  setAnnotationBadges: (host, keys, numbers) =>
    ipcRenderer.invoke(IPC.annotationBadges, { host, keys, numbers }) as Promise<void>,
  focusAnnotation: (host, key) =>
    ipcRenderer.invoke(IPC.annotationFocus, { host, key }) as Promise<void>,
  getGitStatus: (cwd) => ipcRenderer.invoke(IPC.gitStatus, { cwd }) as Promise<GitStatus>,
  getGitDiff: (cwd, path, scope) =>
    ipcRenderer.invoke(IPC.gitDiff, { cwd, path, scope }) as Promise<GitDiff>,
  openTemporaryChat: () => ipcRenderer.invoke(IPC.temporaryOpen) as Promise<HostSnapshot>,
  closeTemporaryChat: () => ipcRenderer.invoke(IPC.temporaryClose) as Promise<HostSnapshot>,
  promptTemporary: (id, text, uploads) =>
    ipcRenderer.invoke(IPC.temporaryPrompt, { id, text, uploads }) as Promise<void>,
  abortTemporary: (id) => ipcRenderer.invoke(IPC.temporaryAbort, { id }) as Promise<void>,
  listTemporaryModels: (id) => ipcRenderer.invoke(IPC.temporaryModels, { id }) as Promise<ModelOption[]>,
  selectTemporaryModel: (id, provider, modelId) =>
    ipcRenderer.invoke(IPC.temporaryModelSelect, { id, provider, modelId }) as Promise<HostSnapshot>,
  listCommands: (agentId) =>
    ipcRenderer.invoke(IPC.commandsList, { agentId }) as Promise<CommandOption[]>,
  completeCommand: (agentId, name, prefix) =>
    ipcRenderer.invoke(IPC.commandsComplete, { agentId, name, prefix }) as Promise<CommandArgumentOption[]>,
  listThinkingLevels: (agentId) =>
    ipcRenderer.invoke(IPC.thinkingLevels, { agentId }) as Promise<ThinkingLevel[]>,
  selectThinkingLevel: (agentId, level) =>
    ipcRenderer.invoke(IPC.thinkingSelect, { agentId, level }) as Promise<void>,
  dismissExtensionErrors: () => ipcRenderer.invoke(IPC.extensionErrorsDismiss) as Promise<HostSnapshot>,
  searchFiles: (cwd, query, limit, requestId) =>
    ipcRenderer.invoke(IPC.filesSearch, { cwd, query, limit, requestId }) as Promise<FileSearchResult[]>,
  cancelFileSearch: (requestId) => ipcRenderer.invoke(IPC.filesSearchCancel, { requestId }) as Promise<void>,
  copyText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, { text }) as Promise<void>,
  listDocs: (cwd) => ipcRenderer.invoke(IPC.docsList, { cwd }) as Promise<DocsResult>,
  listFiles: (cwd, dir) =>
    ipcRenderer.invoke(IPC.filesList, { cwd, dir }) as Promise<FileListResult>,
  readFile: (cwd, path) => ipcRenderer.invoke(IPC.filesRead, { cwd, path }) as Promise<FileContent>,
  openFile: (cwd, path) => ipcRenderer.invoke(IPC.filesOpen, { cwd, path }) as Promise<HostSnapshot>,
  closeFile: (fileId) => ipcRenderer.invoke(IPC.filesClose, { fileId }) as Promise<HostSnapshot>,
  activateFile: (fileId) => ipcRenderer.invoke(IPC.filesActivate, { fileId }) as Promise<HostSnapshot>,
  openFileExternal: (cwd, path) => ipcRenderer.invoke(IPC.filesOpenExternal, { cwd, path }) as Promise<void>,
  reloadFile: (fileId) => ipcRenderer.invoke(IPC.filesReload, { fileId }) as Promise<HostSnapshot>,
  listModels: (agentId) => ipcRenderer.invoke(IPC.modelsList, { agentId }) as Promise<ModelOption[]>,
  selectModel: (agentId, provider, id, persist) =>
    ipcRenderer.invoke(IPC.modelsSelect, { agentId, provider, id, persist }) as Promise<void>,

  onSnapshot: (listener) => {
    const handler = (_event: unknown, snapshot: HostSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC_EVENTS.snapshot, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.snapshot, handler)
    }
  },

  onSessionEvent: (listener) => {
    const handler = (_event: unknown, events: SessionEvent[]): void => listener(events)
    ipcRenderer.on(IPC_EVENTS.session, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.session, handler)
    }
  },

  onBrowserState: (listener) => {
    const handler = (_event: unknown, payload: BrowserEvent): void => listener(payload)
    ipcRenderer.on(IPC_EVENTS.browser, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.browser, handler)
    }
  },

  onAnnotation: (listener) => {
    const handler = (_event: unknown, payload: AnnotationEvent): void => listener(payload)
    ipcRenderer.on(IPC_EVENTS.annotation, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.annotation, handler)
    }
  },

  listConsoleRecords: () =>
    ipcRenderer.invoke(IPC.consoleList) as Promise<ConsoleListResult>,
  getConsoleField: (recordId, path) =>
    ipcRenderer.invoke(IPC.consoleField, { recordId, path }) as Promise<ConsoleFieldResult | null>,
  getConsoleStats: () => ipcRenderer.invoke(IPC.consoleStats) as Promise<ConsoleStats>,
  deleteConsoleRecord: (recordId) =>
    ipcRenderer.invoke(IPC.consoleDelete, { recordId }) as Promise<{ deleted: number }>,
  deleteConsoleSession: (sessionId) =>
    ipcRenderer.invoke(IPC.consoleDeleteSession, { sessionId }) as Promise<{ deleted: number }>,
  deleteConsoleRecords: (recordIds) =>
    ipcRenderer.invoke(IPC.consoleDeleteRecords, { recordIds }) as Promise<{ deleted: number }>,
  clearConsole: () => ipcRenderer.invoke(IPC.consoleDeleteAll) as Promise<{ deleted: number }>,
  protectConsoleRecord: (id) => ipcRenderer.invoke(IPC.consoleProtect, { id }) as Promise<void>,
  exportConsole: (request: ConsoleExportRequest) =>
    ipcRenderer.invoke(IPC.consoleExport, request) as Promise<ConsoleExportResult>,
  cancelConsoleExport: (jobId) =>
    ipcRenderer.invoke(IPC.consoleExportCancel, { jobId }) as Promise<void>,
  revealConsoleDir: () => ipcRenderer.invoke(IPC.consoleReveal) as Promise<void>,
  openConsoleWindow: () => ipcRenderer.invoke(IPC.consoleWindowOpen) as Promise<void>,
  closeConsoleWindow: () => ipcRenderer.invoke(IPC.consoleWindowClose) as Promise<void>,
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<Record<string, unknown>>,
  setSetting: (id, value) => ipcRenderer.invoke(IPC.settingsSet, { id, value }) as Promise<boolean>,
  openSettingsWindow: () => ipcRenderer.invoke(IPC.settingsOpen) as Promise<void>,

  listProviders: () => ipcRenderer.invoke(IPC.modelProviders) as Promise<ProviderInfo[]>,
  listAllModels: () => ipcRenderer.invoke(IPC.modelList) as Promise<ModelEntry[]>,
  getModelSettings: () => ipcRenderer.invoke(IPC.modelSettingsGet) as Promise<ModelSettings>,
  setModelSetting: (change: ModelSettingsChange) =>
    ipcRenderer.invoke(IPC.modelSettingsSet, change) as Promise<boolean>,
  loginProvider: (providerId, method) =>
    ipcRenderer.invoke(IPC.modelLogin, { providerId, method }) as Promise<void>,
  answerAuthPrompt: (promptId, value) =>
    ipcRenderer.invoke(IPC.modelLoginAnswer, { promptId, value }) as Promise<boolean>,
  cancelLogin: () => ipcRenderer.invoke(IPC.modelLoginCancel) as Promise<void>,
  logoutProvider: (providerId) =>
    ipcRenderer.invoke(IPC.modelLogout, { providerId }) as Promise<boolean>,
  refreshModels: () => ipcRenderer.invoke(IPC.modelRefresh) as Promise<ModelEntry[]>,
  getModelsConfig: () => ipcRenderer.invoke(IPC.modelConfigGet) as Promise<string>,
  setModelsConfig: (content) =>
    ipcRenderer.invoke(IPC.modelConfigSet, { content }) as Promise<boolean>,

  onModelAuthEvent: (listener) => {
    const handler = (_event: unknown, payload: ModelAuthEvent): void => listener(payload)
    ipcRenderer.on(IPC_EVENTS.model, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.model, handler)
    }
  },

  onConsoleEvent: (listener) => {
    const handler = (_event: unknown, payload: ConsoleEvent): void => listener(payload)
    ipcRenderer.on(IPC_EVENTS.console, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.console, handler)
    }
  }
}

contextBridge.exposeInMainWorld('codelet', api)
