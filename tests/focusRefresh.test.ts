import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 离开够久再切回来，就重读会话列表。
 *
 * 为什么需要这条：会话列表的刷新是事件驱动的，但那只覆盖「Codelet 自己的 runtime」。
 * 用户在裸 pi 的 TUI 里说话时那是另一个进程，我们收不到事件 ——
 * 列表一直不动，只有重启才更新。
 *
 * 判据用「离开时长」而不是「上次刷新过了多久」：
 * 点了下别的窗口又点回来不该付重扫磁盘的代价（实测 4 个项目 21 个会话约 180ms）。
 */
const AGENT_DIR = mkdtempSync(join(tmpdir(), 'codelet-focus-agent-'))
process.env.PI_CODING_AGENT_DIR = AGENT_DIR

class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  private managers = new Map<string, SessionManager>()

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async openTab(tabId: string, options: { cwd: string; path?: string }): Promise<void> {
    this.managers.set(tabId, options.path ? SessionManager.open(options.path) : SessionManager.create(options.cwd))
  }
  async closeTab(tabId: string): Promise<void> {
    this.managers.delete(tabId)
  }
  async activateTab(): Promise<void> {}
  async reloadTab(): Promise<void> {}
  tabState(tabId: string): TabRuntimeState {
    const manager = this.managers.get(tabId)
    return {
      ready: Boolean(manager),
      sessionId: manager?.getSessionId() ?? null,
      sessionFile: manager?.getSessionFile() ?? null,
      streaming: false,
      model: null,
      modelFallback: null
    }
  }
  readEntries(): StreamItem[] {
    return []
  }
  async listModels(): Promise<ModelOption[]> {
    return []
  }
  async selectModel(): Promise<void> {}
  async prompt(): Promise<void> {}
  async stop(): Promise<void> {
    this.listeners.clear()
  }
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-focus-'))
  const projects = new ProjectStore(join(dir, 'projects.json'))
  projects.add(dir)
  const state = new HostState({
    pi: new FakePi(),
    tabStore: new TabStore(join(dir, 'tabs.json')),
    projects
  })
  return { dir, state }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('切回窗口时重读会话列表', () => {
  it('init 之前不响应 —— init 自己会读一次', async () => {
    const { dir, state } = await setup()
    const spy = vi.spyOn(state, 'refreshConversations')

    state.noteBlur()
    await sleep(3100)
    await state.refreshOnFocus()
    expect(spy).not.toHaveBeenCalled()

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('从没失焦过（启动后第一次 focus）不读', async () => {
    const { dir, state } = await setup()
    await state.init()
    const spy = vi.spyOn(state, 'refreshConversations')

    await state.refreshOnFocus()
    expect(spy).not.toHaveBeenCalled()

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('只离开一小会儿就回来 —— 不读（别为点一下别的窗口付 180ms）', async () => {
    const { dir, state } = await setup()
    await state.init()
    const spy = vi.spyOn(state, 'refreshConversations')

    state.noteBlur()
    await sleep(300)
    await state.refreshOnFocus()
    expect(spy).not.toHaveBeenCalled()

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('离开够久再回来 —— 读一次', async () => {
    const { dir, state } = await setup()
    await state.init()
    const spy = vi.spyOn(state, 'refreshConversations')

    state.noteBlur()
    await sleep(3100)
    await state.refreshOnFocus()
    expect(spy).toHaveBeenCalledTimes(1)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('同一次离开只触发一次 —— 焦点事件可能连着来好几个', async () => {
    const { dir, state } = await setup()
    await state.init()
    const spy = vi.spyOn(state, 'refreshConversations')

    state.noteBlur()
    await sleep(3100)
    await state.refreshOnFocus()
    await state.refreshOnFocus()
    await state.refreshOnFocus()
    expect(spy).toHaveBeenCalledTimes(1)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('TUI 里聊过的会话，切回窗口就能看到 —— 不用重启', async () => {
    const { dir, state } = await setup()
    await state.init()
    expect(state.snapshot().conversations).toHaveLength(0)

    // 模拟「另一个进程（裸 pi 的 TUI）在同一个目录里写了一个会话」。
    // Codelet 这边收不到任何事件，只能靠重读磁盘。
    const manager = SessionManager.create(dir)
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '在 TUI 里说的一句' }],
      timestamp: Date.now()
    })

    state.noteBlur()
    await sleep(3100)
    await state.refreshOnFocus()

    const conversations = state.snapshot().conversations
    expect(conversations).toHaveLength(1)
    expect(conversations[0].title).toBe('在 TUI 里说的一句')

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
