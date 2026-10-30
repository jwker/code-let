import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  IPC_EVENTS,
  type CodeletApi,
  type HostSnapshot,
  type ModelOption,
  type SessionEvent,
  type StreamItem
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
  openConversation: (path, cwd) => ipcRenderer.invoke(IPC.tabsOpen, { path, cwd }) as Promise<HostSnapshot>,
  newConversation: (cwd) => ipcRenderer.invoke(IPC.tabsNew, { cwd }) as Promise<HostSnapshot>,
  activateTab: (tabId) => ipcRenderer.invoke(IPC.tabsActivate, { tabId }) as Promise<HostSnapshot>,
  closeTab: (tabId) => ipcRenderer.invoke(IPC.tabsClose, { tabId }) as Promise<HostSnapshot>,
  getTabEntries: (tabId) => ipcRenderer.invoke(IPC.tabsEntries, { tabId }) as Promise<StreamItem[]>,
  prompt: (tabId, text) => ipcRenderer.invoke(IPC.promptSend, { tabId, text }),
  copyText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, { text }) as Promise<void>,
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
  }
}

contextBridge.exposeInMainWorld('codelet', api)
