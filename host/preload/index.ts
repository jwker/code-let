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
  switchProject: (path) => ipcRenderer.invoke(IPC.projectsSwitch, { path }) as Promise<HostSnapshot>,
  newConversation: () => ipcRenderer.invoke(IPC.conversationsNew) as Promise<HostSnapshot>,
  switchConversation: (path) => ipcRenderer.invoke(IPC.conversationsSwitch, { path }) as Promise<HostSnapshot>,
  getSessionEntries: () => ipcRenderer.invoke(IPC.sessionEntries) as Promise<StreamItem[]>,
  prompt: (text) => ipcRenderer.invoke(IPC.promptSend, { text }) as Promise<void>,
  copyText: (text) => ipcRenderer.invoke(IPC.clipboardWrite, { text }) as Promise<void>,
  listModels: () => ipcRenderer.invoke(IPC.modelsList) as Promise<ModelOption[]>,
  selectModel: (provider, id, persist) =>
    ipcRenderer.invoke(IPC.modelsSelect, { provider, id, persist }) as Promise<void>,

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
