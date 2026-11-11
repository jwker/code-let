import { BrowserWindow, ipcMain, shell } from 'electron'
import { IPC, IPC_EVENTS, type ModelAuthEvent } from '@contract/index'
import type { ModelManager } from './modelManager'
import type { HostState } from './state'

/**
 * 大模型管理的 IPC。
 *
 * 登录过程是「一问一答」的：主进程发起，渲染进程显示 URL / 验证码 / 输入框，
 * 再把答案送回来。所以登录的事件走单向上行通道（`IPC_EVENTS.model`），
 * 提问的答案走一条反向的 invoke。
 */

/** 把登录事件发给所有窗口 */
function broadcast(event: ModelAuthEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_EVENTS.model, event)
  }
}

export function registerModelIpc(state: HostState, manager: ModelManager): () => void {
  ipcMain.handle(IPC.modelProviders, () => manager.providers())
  ipcMain.handle(IPC.modelList, () => manager.models())
  ipcMain.handle(IPC.modelSettingsGet, () => manager.readSettings())
  ipcMain.handle(IPC.modelSettingsSet, (_event, payload: unknown) => manager.writeSettings(payload as never))

  ipcMain.handle(IPC.modelLogin, async (_event, payload: unknown) => {
    const { providerId, method } = payload as { providerId?: unknown; method?: unknown }
    if (typeof providerId !== 'string') return
    if (method !== 'oauth' && method !== 'api_key') return
    // 登录是长流程 —— 不在这儿等它结束，等它自己发事件
    void manager.login(providerId, method)
  })

  ipcMain.handle(IPC.modelLoginAnswer, (_event, payload: unknown) => {
    const { promptId, value } = payload as { promptId?: unknown; value?: unknown }
    if (typeof promptId !== 'string' || typeof value !== 'string') return false
    return manager.answerPrompt(promptId, value)
  })

  ipcMain.handle(IPC.modelLoginCancel, () => {
    manager.cancelLogin()
  })

  ipcMain.handle(IPC.modelLogout, async (_event, payload: unknown) => {
    const { providerId } = payload as { providerId?: unknown }
    if (typeof providerId !== 'string') return false
    const ok = await manager.logout(providerId)
    if (ok) await state.pi.refreshModelAvailability()
    return ok
  })

  ipcMain.handle(IPC.modelRefresh, async () => {
    const models = await manager.refresh()
    // 凭据可能变了 —— 别的标签也得重查一遍
    await state.pi.refreshModelAvailability()
    return models
  })

  ipcMain.handle(IPC.modelConfigGet, () => manager.readConfig())

  ipcMain.handle(IPC.modelConfigSet, async (_event, payload: unknown) => {
    const { content } = payload as { content?: unknown }
    if (typeof content !== 'string') return false
    const ok = await manager.writeConfig(content)
    if (ok) await state.pi.refreshModelAvailability()
    return ok
  })

  return () => {
    ipcMain.removeHandler(IPC.modelProviders)
    ipcMain.removeHandler(IPC.modelList)
    ipcMain.removeHandler(IPC.modelSettingsGet)
    ipcMain.removeHandler(IPC.modelSettingsSet)
    ipcMain.removeHandler(IPC.modelLogin)
    ipcMain.removeHandler(IPC.modelLoginAnswer)
    ipcMain.removeHandler(IPC.modelLoginCancel)
    ipcMain.removeHandler(IPC.modelLogout)
    ipcMain.removeHandler(IPC.modelRefresh)
    ipcMain.removeHandler(IPC.modelConfigGet)
    ipcMain.removeHandler(IPC.modelConfigSet)
  }
}

/**
 * 登录时给「授权链接」开浏览器。
 *
 * OAuth 的 URL 要在浏览器里完成授权；设备码那类则给一个验证地址。
 *
 * 自动化测试里会打开真浏览器 —— 设 `CODELET_NO_OPEN_BROWSER` 可以不去开，
 * 界面上照样显示链接，测的是渲染那一段。
 */
export async function openAuthUrl(url: string): Promise<void> {
  if (process.env.CODELET_NO_OPEN_BROWSER) return
  await shell.openExternal(url)
}

export { broadcast as broadcastModelEvent }
