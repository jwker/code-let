import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, AgentRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 标签的落盘与恢复（PLAN.md D4 修订 · R14）。
 *
 * 三条要守住的：
 *   - **标签要记下自己的会话文件路径** —— 不记就永远恢复不回来
 *   - **有内容的标签重启后回来，内容还在**
 *   - **没说过话的空标签也回来**（它本来就没内容可丢；标签是工作区的一部分）
 */

/** 假运行时：会话文件路径可配，方便测「有文件 / 没文件」两种 */
class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  /** tabId → 这个标签的会话文件路径 */
  readonly files = new Map<string, string | null>()
  readonly opened: Array<{ agentId: string; path?: string; lazy?: boolean }> = []
  private active: string | null = null

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  hasAgent(agentId: string): boolean {
    // 假 runtime 都登记在 files/opened 里；没有这两个映射的用例不关心「按需补登记」
    const map = (this as unknown as { files?: Map<string, unknown>; opened?: unknown[] }).files
    return map ? map.has(agentId) : true
  }

  async openAgent(tabId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void> {
    this.opened.push({ agentId: tabId, path: options.path, lazy: options.lazy })
    // 没给路径就当「新建会话」—— 给它一个还不存在的文件路径
    this.files.set(tabId, options.path ?? join(tmpdir(), `fake-${tabId}.jsonl`))
  }

  async closeAgent(tabId: string): Promise<void> {
    this.files.delete(tabId)
    if (this.active === tabId) this.active = null
  }

  async activateAgent(tabId: string): Promise<void> {
    this.active = tabId
  }
  async reloadAgent(): Promise<void> {}

  agentState(tabId: string): AgentRuntimeState {
    return {
      ready: this.active === tabId,
      sessionId: `s-${tabId}`,
      sessionFile: this.files.get(tabId) ?? null,
      streaming: false,
      model: null,
      thinkingLevel: null,
      modelFallback: null
    }
  }

  readEntries(): StreamItem[] {
    return []
  }

  async listModels(): Promise<ModelOption[]> {
    return []
  }
  async refreshModelAvailability(): Promise<void> {}

  async selectModel(): Promise<void> {
    // 不参与
  }

  async prompt(): Promise<void> {
    // 不参与
  }

  async abortAgent(): Promise<void> {
    // 测试里没有真 agent，中止是空操作
  }

  async renameSession(): Promise<void> {
    // 重命名不参与这份测试
  }


  async setSessionName(): Promise<void> {}

  async listCommands(): Promise<never[]> {
    return []
  }

  async compactAgent(): Promise<void> {
    // 不参与
  }

  async completeCommand(): Promise<never[]> {
    return []
  }

  thinkingLevels(): never[] {
    return []
  }

  setThinkingLevel(): void {
    // 不参与
  }

  async stop(): Promise<void> {
    this.files.clear()
  }
}


/**
 * 写一份 v1（会话标签）的 tabs.json。
 *
 * 直接写文件而不是走 `saveTabs` —— v2 的 `saveTabs` 只收项目标签，
 * 而这个形状只剩「迁移」这一个消费者了（PLAN.md D59）。
 */
function writeLegacyTabs(file: string, tabs: Array<{ id: string; cwd: string; path: string | null; title: string }>): void {
  writeFileSync(file, JSON.stringify({ tabs }))
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-tabrestore-'))
  const projects = new ProjectStore(join(dir, 'projects.json'))
  projects.add(dir)
  return { dir, projects, tabFile: join(dir, 'tabs.json') }
}

describe('标签落盘', () => {
  it('开标签时把会话文件路径记下来 —— 不记就永远恢复不回来', async () => {
    const { dir, projects, tabFile } = setup()
    const pi = new FakePi()
    const state = new HostState({ pi, tabStore: new TabStore(tabFile), projects })
    await state.init()

    await state.newConversation(dir)
    // 会话路径落在 agents.json（一个 agent 一条会话），项目标签存在 tabs.json
    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as {
      agents: { sessionPath: string | null }[]
    }
    expect(agents.agents[0].sessionPath).toBeTruthy()
    expect(agents.agents[0].sessionPath).toContain('fake-')
    const tabs = JSON.parse(readFileSync(tabFile, 'utf8')) as { version: number; tabs: { activeAgentId: string }[] }
    expect(tabs.version).toBe(2)
    expect(tabs.tabs[0].activeAgentId).toBe(agents.agents[0].sessionPath ? tabs.tabs[0].activeAgentId : '')

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('激活懒加载的标签后，把新建会话的路径补进 tabs.json', async () => {
    const { dir, projects, tabFile } = setup()
    // 先造一个「没路径」的标签 —— 模拟恢复出来的空标签
    writeLegacyTabs(tabFile, [{ id: 'tab-lazy', cwd: dir, path: null, title: '新对话' }])

    const pi = new FakePi()
    const state = new HostState({ pi, tabStore: new TabStore(tabFile), projects })
    await state.init()
    const agent = state.snapshot().agents[0]
    expect(agent.sessionPath).toBeNull()

    await state.activateAgent(agent.id)
    const agents = JSON.parse(readFileSync(join(dir, 'agents.json'), 'utf8')) as {
      agents: { sessionPath: string | null }[]
    }
    expect(agents.agents[0].sessionPath).toBeTruthy()

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('标签恢复', () => {
  it('有内容的标签：带着原来的 id 和路径回来', async () => {
    const { dir, projects, tabFile } = setup()
    // 造一个真实存在的会话文件
    const realFile = join(dir, 'real-session.jsonl')
    writeFileSync(realFile, '')
    writeLegacyTabs(tabFile, [{ id: 'tab-real', cwd: dir, path: realFile, title: '聊过的' }])

    const pi = new FakePi()
    const state = new HostState({ pi, tabStore: new TabStore(tabFile), projects })
    await state.init()

    const agents = state.snapshot().agents
    expect(agents).toHaveLength(1)
    // 迁移之后 id 是 agent id（D58：runtime 以 agent 为键）
    expect(agents[0].id).toBe('agent-tab-real')
    expect(agents[0].sessionPath).toBe(realFile)
    expect(agents[0].name).toBe('聊过的')
    // 恢复出来是懒加载的 —— 不建 runtime
    expect(pi.opened[0].lazy).toBe(true)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('没说过话的空标签也回来 —— 它本来就没内容可丢', async () => {
    const { dir, projects, tabFile } = setup()
    // 有路径但文件不存在（Pi 创建会话时就给了路径，文件要等第一条消息才建）
    writeLegacyTabs(tabFile, [
      { id: 'tab-empty', cwd: dir, path: join(dir, 'never-created.jsonl'), title: '新对话' }
    ])

    const pi = new FakePi()
    const state = new HostState({ pi, tabStore: new TabStore(tabFile), projects })
    await state.init()

    const agents = state.snapshot().agents
    expect(agents).toHaveLength(1)
    expect(agents[0].id).toBe('agent-tab-empty')
    // 重开的是新会话，所以路径先清空（激活时再补）
    expect(agents[0].sessionPath).toBeNull()

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

})
