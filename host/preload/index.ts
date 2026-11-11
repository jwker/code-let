import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  IPC_EVENTS,
  type ConsoleEvent,
  type ConsoleExportRequest,
  type ConsoleExportResult,
  type ConsoleFieldResult,
  type ConsoleListResult,
  type ConsoleStats,
  type CodeletApi,
  type CommandArgumentOption,
  type CommandOption,
  type ContextDiffSession,
  type ContextDiffView,
  type ContextSnapshotRef,
  type DeleteConversationsResult,
  type FileContent,
  type FileEntry,
  type FileSearchResult,
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
  openConversation: (path, cwd) => ipcRenderer.invoke(IPC.tabsOpen, { path, cwd }) as Promise<HostSnapshot>,
  newConversation: (cwd, name) =>
    ipcRenderer.invoke(IPC.tabsNew, { cwd, name }) as Promise<HostSnapshot>,
  activateTab: (tabId) => ipcRenderer.invoke(IPC.tabsActivate, { tabId }) as Promise<HostSnapshot>,
  closeTab: (tabId) => ipcRenderer.invoke(IPC.tabsClose, { tabId }) as Promise<HostSnapshot>,
  reloadTab: (tabId) => ipcRenderer.invoke(IPC.tabsReload, { tabId }) as Promise<HostSnapshot>,
  getTabEntries: (tabId) => ipcRenderer.invoke(IPC.tabsEntries, { tabId }) as Promise<StreamItem[]>,
  prompt: (tabId, text, attachments, uploads) =>
    ipcRenderer.invoke(IPC.promptSend, { tabId, text, attachments, uploads }),
  abortPrompt: (tabId) => ipcRenderer.invoke(IPC.promptAbort, { tabId }) as Promise<void>,
  compactTab: (tabId) => ipcRenderer.invoke(IPC.promptCompact, { tabId }) as Promise<void>,
  pickAttachments: () =>
    ipcRenderer.invoke(IPC.attachmentsPick) as Promise<PickAttachmentsResult>,
  getBrowserState: () => ipcRenderer.invoke(IPC.browserGet) as Promise<BrowserState>,
  createBrowserTab: (url) => ipcRenderer.invoke(IPC.browserCreate, { url }) as Promise<BrowserState>,
  closeBrowserTab: (tabId) => ipcRenderer.invoke(IPC.browserClose, { tabId }) as Promise<BrowserState>,
  activateBrowserTab: (tabId) => ipcRenderer.invoke(IPC.browserActivate, { tabId }) as Promise<BrowserState>,
  navigateBrowser: (tabId, url) =>
    ipcRenderer.invoke(IPC.browserNavigate, { tabId, url }) as Promise<BrowserState>,
  browserBack: (tabId) => ipcRenderer.invoke(IPC.browserBack, { tabId }) as Promise<BrowserState>,
  browserForward: (tabId) => ipcRenderer.invoke(IPC.browserForward, { tabId }) as Promise<BrowserState>,
  browserReload: (tabId) => ipcRenderer.invoke(IPC.browserReload, { tabId }) as Promise<BrowserState>,
  setBrowserBounds: (bounds) => ipcRenderer.invoke(IPC.browserBounds, bounds) as Promise<void>,
  setBrowserVisible: (visible) => ipcRenderer.invoke(IPC.browserVisible, { visible }) as Promise<void>,
  getGitStatus: (tabId) =>
    ipcRenderer.invoke(IPC.gitStatus, { tabId }) as Promise<GitStatus>,
  getGitDiff: (tabId, path, scope) =>
    ipcRenderer.invoke(IPC.gitDiff, { tabId, path, scope }) as Promise<GitDiff>,
  getContextDiff: (tabId, baselineId) =>
    ipcRenderer.invoke(IPC.contextDiffGet, { tabId, baselineId }) as Promise<ContextDiffView | null>,
  getContextDiffForTurn: (tabId, turn, baselineId) =>
    ipcRenderer.invoke(IPC.contextDiffTurn, { tabId, turn, baselineId }) as Promise<ContextDiffView | null>,
  listContextDiffSessions: () =>
    ipcRenderer.invoke(IPC.contextDiffSessions) as Promise<ContextDiffSession[]>,
  listContextDiffSnapshots: (tabId) =>
    ipcRenderer.invoke(IPC.contextDiffSnapshots, { tabId }) as Promise<ContextSnapshotRef[]>,
  getContextDiffDetail: (tabId, snapshotId, key) =>
    ipcRenderer.invoke(IPC.contextDiffDetail, { tabId, snapshotId, key }) as Promise<
      { text: string; truncated: boolean } | null
    >,
  openTemporaryChat: () => ipcRenderer.invoke(IPC.temporaryOpen) as Promise<HostSnapshot>,
  closeTemporaryChat: () => ipcRenderer.invoke(IPC.temporaryClose) as Promise<HostSnapshot>,
  promptTemporary: (id, text, uploads) =>
    ipcRenderer.invoke(IPC.temporaryPrompt, { id, text, uploads }) as Promise<void>,
  abortTemporary: (id) => ipcRenderer.invoke(IPC.temporaryAbort, { id }) as Promise<void>,
  listTemporaryModels: (id) => ipcRenderer.invoke(IPC.temporaryModels, { id }) as Promise<ModelOption[]>,
  selectTemporaryModel: (id, provider, modelId) =>
    ipcRenderer.invoke(IPC.temporaryModelSelect, { id, provider, modelId }) as Promise<HostSnapshot>,
  listCommands: (tabId) => ipcRenderer.invoke(IPC.commandsList, { tabId }) as Promise<CommandOption[]>,
  completeCommand: (tabId, name, prefix) =>
    ipcRenderer.invoke(IPC.commandsComplete, { tabId, name, prefix }) as Promise<CommandArgumentOption[]>,
  listThinkingLevels: (tabId) =>
    ipcRenderer.invoke(IPC.thinkingLevels, { tabId }) as Promise<ThinkingLevel[]>,
  selectThinkingLevel: (tabId, level) =>
    ipcRenderer.invoke(IPC.thinkingSelect, { tabId, level }) as Promise<void>,
  dismissExtensionErrors: () => ipcRenderer.invoke(IPC.extensionErrorsDismiss) as Promise<HostSnapshot>,
  searchFiles: (cwd, query, limit, requestId) =>
    ipcRenderer.invoke(IPC.filesSearch, { cwd, query, limit, requestId }) as Promise<FileSearchResult[]>,
  cancelFileSearch: (requestId) => ipcRenderer.invoke(IPC.filesSearchCancel, { requestId }) as Promise<void>,
  copyText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, { text }) as Promise<void>,
  listFiles: (cwd, dir) => ipcRenderer.invoke(IPC.filesList, { cwd, dir }) as Promise<FileEntry[]>,
  readFile: (cwd, path) => ipcRenderer.invoke(IPC.filesRead, { cwd, path }) as Promise<FileContent>,
  openFile: (cwd, path) => ipcRenderer.invoke(IPC.filesOpen, { cwd, path }) as Promise<HostSnapshot>,
  closeFile: (fileId) => ipcRenderer.invoke(IPC.filesClose, { fileId }) as Promise<HostSnapshot>,
  activateFile: (fileId) => ipcRenderer.invoke(IPC.filesActivate, { fileId }) as Promise<HostSnapshot>,
  openFileExternal: (cwd, path) => ipcRenderer.invoke(IPC.filesOpenExternal, { cwd, path }) as Promise<void>,
  reloadFile: (fileId) => ipcRenderer.invoke(IPC.filesReload, { fileId }) as Promise<HostSnapshot>,
  listModels: (tabId) => ipcRenderer.invoke(IPC.modelsList, { tabId }) as Promise<ModelOption[]>,
  selectModel: (tabId, provider, id, persist) =>
    ipcRenderer.invoke(IPC.modelsSelect, { tabId, provider, id, persist }) as Promise<void>,

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
    const handler = (_event: unknown, state: BrowserState): void => listener(state)
    ipcRenderer.on(IPC_EVENTS.browser, handler)
    return () => {
      ipcRenderer.removeListener(IPC_EVENTS.browser, handler)
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
