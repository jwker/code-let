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
 * 窗口获得焦点时重读会话列表。
 *
 * 为什么需要这条：会话列表的刷新是事件驱动的，但那只覆盖「Codelet 自己的 runtime」。
 * 用户在裸 pi 的 TUI 里说话时那是另一个进程，我们收不到事件 ——
 * 列表一直不动，只有重启才更新。所以补一个「切回窗口就重读」。
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

describe('窗口获得焦点时重读会话列表', () => {
  it('init 之前不响应 —— init 自己会读一次，别重复扫', async () => {
    const { dir, state } = await setup()
    const spy = vi.spyOn(state, 'refreshConversations')

    await state.refreshOnFocus()
    expect(spy).not.toHaveBeenCalled()

    await state.init()
    spy.mockClear()
    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('切回窗口会重读一次', async () => {
    const { dir, state } = await setup()
    await state.init()

    const spy = vi.spyOn(state, 'refreshConversations')
    // init 末尾把「上次焦点刷新」设成了当下，先等过限流窗口
    await new Promise((resolve) => setTimeout(resolve, 2100))
    await state.refreshOnFocus()
    expect(spy).toHaveBeenCalledTimes(1)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('快速反复切窗口只读一次 —— 每次都要解析那几个项目的 jsonl', async () => {
    const { dir, state } = await setup()
    await state.init()

    const spy = vi.spyOn(state, 'refreshConversations')
    await new Promise((resolve) => setTimeout(resolve, 2100))
    await state.refreshOnFocus()
    await state.refreshOnFocus()
    await state.refreshOnFocus()
    expect(spy).toHaveBeenCalledTimes(1)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('TUI 里聊过的新会话，切回窗口就能看到 —— 不用重启', async () => {
    const { dir, state } = await setup()
    await state.init()
    expect(state.snapshot().conversations).toHaveLength(0)

    // 模拟「另一个进程（裸 pi 的 TUI）在同一个目录里写了一个会话」
    // 注意：Codelet 这边收不到任何事件，只能靠重读磁盘
    const manager = SessionManager.create(dir)
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '在 TUI 里说的一句' }],
      timestamp: Date.now()
    })

    await new Promise((resolve) => setTimeout(resolve, 2100))
    await state.refreshOnFocus()

    const conversations = state.snapshot().conversations
    expect(conversations).toHaveLength(1)
    expect(conversations[0].title).toBe('在 TUI 里说的一句')

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
