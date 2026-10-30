import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import { PiRuntime } from '../host/main/pi/runtime'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 关掉正在跑的标签（PLAN.md D4 修订）。
 *
 * 两条路都要管住：
 *   - 宿主侧：标签从列表里去掉，活动标签落到相邻的一个，落盘也跟着改；
 *   - 运行时侧：**先 abort 等那一轮结算，再 dispose** ——
 *     照 `runtime.dispose()` 直接关，半截轮次可能没落盘。
 */

/** 假运行时：记下宿主对它做了什么 */
class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  private tabs = new Map<string, { cwd: string; streaming: boolean }>()
  /** 宿主调过的方法，按次序记 */
  readonly calls: string[] = []

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async openTab(tabId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void> {
    this.tabs.set(tabId, { cwd: options.cwd, streaming: false })
  }

  async closeTab(tabId: string): Promise<void> {
    this.calls.push(`close:${tabId}`)
    this.tabs.delete(tabId)
  }

  async activateTab(tabId: string): Promise<void> {
    this.calls.push(`activate:${tabId}`)
  }

  tabState(tabId: string): TabRuntimeState {
    const tab = this.tabs.get(tabId)
    return {
      ready: Boolean(tab),
      sessionId: tab ? `s-${tabId}` : null,
      streaming: tab?.streaming ?? false,
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

  async selectModel(): Promise<void> {
    // 不参与
  }

  async prompt(): Promise<void> {
    // 不参与
  }

  async stop(): Promise<void> {
    this.tabs.clear()
  }

  /** 把某个标签标成「正在跑」 */
  markStreaming(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) tab.streaming = true
  }
}

/**
 * 起一个没有标签的宿主状态。
 *
 * `init()` 会开一个「退路标签」—— 接着最近的那个会话，没有会话就在当前目录里开新的。
 * 这里要的是空标签栏，所以先把它关掉。
 */
async function emptyState(pi: FakePi, store: TabStore, projects: ProjectStore): Promise<HostState> {
  const state = new HostState({ pi, tabStore: store, projects })
  await state.init()
  for (const tab of state.snapshot().tabs) {
    await state.closeTab(tab.id)
  }
  return state
}

describe('宿主状态：关掉正在跑的标签', () => {
  it('标签从列表里去掉，快照里也不再是 streaming', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-tabclose-'))
    const store = new TabStore(join(dir, 'tabs.json'))
    // 项目清单：会话清单只列清单里的项目
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const pi = new FakePi()
    const state = await emptyState(pi, store, projects)
    await state.newConversation(dir)
    const tab = state.snapshot().tabs[0]
    pi.markStreaming(tab.id)
    expect(state.snapshot().tabs[0].streaming).toBe(true)

    await state.closeTab(tab.id)

    expect(state.snapshot().tabs).toHaveLength(0)
    expect(state.snapshot().activeTabId).toBeNull()
    // 运行时先被告知收摊 —— abort 那一轮就在这条路上
    expect(pi.calls).toContain(`close:${tab.id}`)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('关掉活动标签 → 活动标签落到相邻的一个，并且激活它', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-tabclose-'))
    const store = new TabStore(join(dir, 'tabs.json'))
    // 项目清单：会话清单只列清单里的项目
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const pi = new FakePi()
    const state = await emptyState(pi, store, projects)
    await state.newConversation(dir)
    await state.newConversation(dir)
    await state.newConversation(dir)
    const tabs = state.snapshot().tabs
    const middle = tabs[1]
    await state.activateTab(middle.id)
    pi.markStreaming(middle.id)

    await state.closeTab(middle.id)

    const after = state.snapshot()
    expect(after.tabs.map((t) => t.id)).toEqual([tabs[0].id, tabs[2].id])
    // 落在原来位置的邻居上（index 1 现在是第三个标签）
    expect(after.activeTabId).toBe(tabs[2].id)
    expect(pi.calls).toContain(`activate:${tabs[2].id}`)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('关掉的不是活动标签 → 活动标签不动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-tabclose-'))
    const store = new TabStore(join(dir, 'tabs.json'))
    // 项目清单：会话清单只列清单里的项目
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const pi = new FakePi()
    const state = await emptyState(pi, store, projects)
    await state.newConversation(dir)
    await state.newConversation(dir)
    const tabs = state.snapshot().tabs
    const active = state.snapshot().activeTabId

    await state.closeTab(tabs[0].id)

    expect(state.snapshot().activeTabId).toBe(active)
    expect(state.snapshot().tabs.map((t) => t.id)).toEqual([tabs[1].id])

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('关掉的标签不再落盘 —— 重启不会把它捡回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-tabclose-'))
    const file = join(dir, 'tabs.json')
    const store = new TabStore(file)
    // 项目清单：会话清单只列清单里的项目
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const pi = new FakePi()
    const state = await emptyState(pi, store, projects)
    await state.newConversation(dir)
    const tab = state.snapshot().tabs[0]
    await state.closeTab(tab.id)

    const saved = JSON.parse(readFileSync(file, 'utf8')) as { tabs: { id: string }[] }
    expect(saved.tabs.map((t) => t.id)).not.toContain(tab.id)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('运行时：关掉正在跑的标签', () => {
  it('先 abort 等那一轮结算，再 dispose', async () => {
    const runtime = new PiRuntime()
    const order: string[] = []
    let aborted = false

    // 造一条记录塞进去 —— 真实的 session 跑起来要凭据，测不动
    const record = {
      tabId: 'tab-1',
      cwd: '/tmp',
      path: null,
      bus: {},
      unbind: null,
      sessionManager: null,
      runtime: {
        session: {
          isStreaming: true,
          abort: async (): Promise<void> => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            aborted = true
            order.push('abort')
          }
        },
        dispose: async (): Promise<void> => {
          order.push('dispose')
        }
      }
    }
    ;(runtime as unknown as { tabs: Map<string, unknown> }).tabs.set('tab-1', record)

    await runtime.closeTab('tab-1')

    // abort 结算完才 dispose —— 半截轮次不能被丢掉
    expect(aborted).toBe(true)
    expect(order).toEqual(['abort', 'dispose'])
    // 关掉之后运行时不再有这个标签
    expect(runtime.tabState('tab-1').ready).toBe(false)
    expect(runtime.tabState('tab-1').streaming).toBe(false)
  })

  it('没在跑的时候不 abort', async () => {
    const runtime = new PiRuntime()
    const order: string[] = []
    const record = {
      tabId: 'tab-2',
      cwd: '/tmp',
      path: null,
      bus: {},
      unbind: null,
      sessionManager: null,
      runtime: {
        session: {
          isStreaming: false,
          abort: async (): Promise<void> => {
            order.push('abort')
          }
        },
        dispose: async (): Promise<void> => {
          order.push('dispose')
        }
      }
    }
    ;(runtime as unknown as { tabs: Map<string, unknown> }).tabs.set('tab-2', record)

    await runtime.closeTab('tab-2')

    expect(order).toEqual(['dispose'])
  })
})
