import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 重命名会话（PLAN.md D24）。
 *
 * 名字写进 Pi 的会话文件（`session_info` 条目）。会话开着就走 runtime，
 * 没开着就打开文件追加一条。宿主重读列表之后，侧栏标题与标签标题一起变。
 */

interface Env {
  agentDir: string
  cwd: string
  projects: ProjectStore
  tabFile: string
}

class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  private managers = new Map<string, SessionManager>()
  readonly renameCalls: Array<{ path: string; name: string }> = []

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async openTab(tabId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void> {
    const manager = options.path ? SessionManager.open(options.path) : SessionManager.create(options.cwd)
    this.managers.set(tabId, manager)
  }

  async closeTab(tabId: string): Promise<void> {
    this.managers.delete(tabId)
  }

  async activateTab(): Promise<void> {
    // 不参与
  }

  async reloadTab(): Promise<void> {
    // 不参与
  }

  tabState(tabId: string): TabRuntimeState {
    const manager = this.managers.get(tabId)
    return {
      ready: Boolean(manager),
      sessionId: manager?.getSessionId() ?? null,
      sessionFile: manager?.getSessionFile() ?? null,
      streaming: false,
      model: null,
      thinkingLevel: null,
      modelFallback: null
    }
  }

  async prompt(tabId: string, text: string): Promise<void> {
    const message = { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() }
    this.managers.get(tabId)?.appendMessage(message)
  }

  readEntries(): StreamItem[] {
    return []
  }
  readBranchEntries(): unknown[] {
    return []
  }

  async listModels(): Promise<ModelOption[]> {
    return []
  }

  async selectModel(): Promise<void> {
    // 不参与
  }

  async abortTab(): Promise<void> {
    // 不参与
  }

  /** 跟真运行时一样：有活着的 manager 走它，没有就打开文件追加 */
  async renameSession(path: string, name: string): Promise<void> {
    this.renameCalls.push({ path, name })
    const manager = [...this.managers.values()].find((candidate) => candidate.getSessionFile() === path)
    if (manager) {
      manager.appendSessionInfo(name)
      return
    }
    SessionManager.open(path).appendSessionInfo(name)
  }

  async listCommands(): Promise<never[]> {
    return []
  }

  async compactTab(): Promise<void> {
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
    this.listeners.clear()
  }
}

let env: Env | null = null
let state: HostState | null = null
let previousAgentDir: string | undefined

function setup(): Env {
  const agentDir = mkdtempSync(join(tmpdir(), 'codelet-rename-agent-'))
  const cwd = mkdtempSync(join(tmpdir(), 'codelet-rename-cwd-'))
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const projects = new ProjectStore(join(agentDir, 'projects.json'))
  projects.add(cwd)
  return { agentDir, cwd, projects, tabFile: join(agentDir, 'tabs.json') }
}

async function boot(): Promise<{ env: Env; pi: FakePi; state: HostState }> {
  env = setup()
  const pi = new FakePi()
  state = new HostState({
    pi,
    tabStore: new TabStore(env.tabFile),
    projects: env.projects,
    trashFile: async () => {}
  })
  await state.init()
  return { env, pi, state }
}

async function seed(
  host: HostState,
  pi: FakePi,
  cwd: string,
  text: string
): Promise<{ tabId: string; path: string }> {
  await host.newConversation(cwd)
  const tabId = host.snapshot().activeTabId
  if (!tabId) throw new Error('新标签没建出来')
  await pi.prompt(tabId, text)
  await host.refreshConversations()
  const conversation = host.snapshot().conversations.find((c) => c.title === text)
  if (!conversation) throw new Error('会话没有落盘')
  return { tabId, path: conversation.path }
}

afterEach(async () => {
  await state?.dispose()
  state = null
  if (env) {
    rmSync(env.agentDir, { recursive: true, force: true })
    rmSync(env.cwd, { recursive: true, force: true })
    env = null
  }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  previousAgentDir = undefined
})

describe('重命名会话', () => {
  it('路径不在当前列表里 —— 拒绝，不写文件', async () => {
    const { env, state: host, pi } = await boot()
    const stranger = join(env.cwd, '..', 'stranger.jsonl')

    await expect(host.renameConversation(stranger, '新名字')).rejects.toThrow('不在当前对话列表里')
    expect(pi.renameCalls).toEqual([])
  })

  it('没开着的会话 —— 打开文件追加 session_info，列表标题跟着变', async () => {
    const { env, state: host, pi } = await boot()
    const { tabId, path } = await seed(host, pi, env.cwd, '原始第一条消息')
    await host.closeTab(tabId)

    await host.renameConversation(path, '改过的名字')

    const conversation = host.snapshot().conversations.find((c) => c.path === path)
    expect(conversation?.name).toBe('改过的名字')
    expect(conversation?.title).toBe('改过的名字')
    expect(SessionManager.open(path).getSessionName()).toBe('改过的名字')
  })

  it('开着的会话 —— 走 runtime，标签标题与 tabs.json 一起更新', async () => {
    const { env, state: host, pi } = await boot()
    const { tabId, path } = await seed(host, pi, env.cwd, '原始第一条消息')

    // 前后空格由宿主去掉
    await host.renameConversation(path, '  新标题  ')

    expect(pi.renameCalls).toEqual([{ path, name: '新标题' }])
    expect(SessionManager.open(path).getSessionName()).toBe('新标题')
    expect(host.snapshot().conversations[0]?.title).toBe('新标题')
    expect(host.snapshot().tabs.find((tab) => tab.id === tabId)?.title).toBe('新标题')

    const saved = JSON.parse(readFileSync(env.tabFile, 'utf8')) as { tabs: Array<{ id: string; title: string }> }
    expect(saved.tabs.find((tab) => tab.id === tabId)?.title).toBe('新标题')
  })

  it('空名字 —— 清掉自定义名，标题退回首条用户消息', async () => {
    const { env, state: host, pi } = await boot()
    const { path } = await seed(host, pi, env.cwd, '原始第一条消息')

    await host.renameConversation(path, '自定义名字')
    expect(host.snapshot().conversations[0]?.title).toBe('自定义名字')

    await host.renameConversation(path, '')
    const conversation = host.snapshot().conversations[0]
    expect(conversation?.name).toBeNull()
    expect(conversation?.title).toBe('原始第一条消息')
    expect(SessionManager.open(path).getSessionName()).toBeUndefined()
  })

  it('名字里的换行会被 Pi 压成空格', async () => {
    const { env, state: host, pi } = await boot()
    const { path } = await seed(host, pi, env.cwd, '原始第一条消息')

    await host.renameConversation(path, '第一行\n第二行')

    expect(host.snapshot().conversations[0]?.title).toBe('第一行 第二行')
  })
})
