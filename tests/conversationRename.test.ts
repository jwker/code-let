import { treeStubs } from './support/runtimeTree'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, AgentRuntimeState } from '../host/main/pi/runtime'
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
  // 树操作：这些用例用不到，挂一份空实现
  readTree = treeStubs.readTree
  navigateTree = treeStubs.navigateTree
  forkTree = treeStubs.forkTree
  labelTree = treeStubs.labelTree

  private listeners = new Set<PiEventListener>()
  private managers = new Map<string, SessionManager>()
  readonly renameCalls: Array<{ path: string; name: string }> = []

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
    const manager = options.path ? SessionManager.open(options.path) : SessionManager.create(options.cwd)
    this.managers.set(tabId, manager)
  }

  async closeAgent(tabId: string): Promise<void> {
    this.managers.delete(tabId)
  }

  async activateAgent(): Promise<void> {
    // 不参与
  }

  async reloadAgent(): Promise<void> {
    // 不参与
  }

  agentState(tabId: string): AgentRuntimeState {
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

  async listModels(): Promise<ModelOption[]> {
    return []
  }
  async refreshModelAvailability(): Promise<void> {}

  async selectModel(): Promise<void> {
    // 不参与
  }

  async abortAgent(): Promise<void> {
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
): Promise<{ agentId: string; path: string }> {
  await host.newConversation(cwd)
  const tabId = host.snapshot().activeAgentId
  if (!tabId) throw new Error('新标签没建出来')
  await pi.prompt(tabId, text)
  await host.refreshConversations()
  const conversation = host.snapshot().conversations.find((c) => c.title === text)
  if (!conversation) throw new Error('会话没有落盘')
  return { agentId: tabId, path: conversation.path }
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
    const { agentId: tabId, path } = await seed(host, pi, env.cwd, '原始第一条消息')
    // 归档 = 关掉 runtime，会话文件留着 —— 这样它就成了「没开着的那条会话」
    await host.archiveAgent(tabId)

    await host.renameConversation(path, '改过的名字')

    const conversation = host.snapshot().conversations.find((c) => c.path === path)
    expect(conversation?.name).toBe('改过的名字')
    expect(conversation?.title).toBe('改过的名字')
    expect(SessionManager.open(path).getSessionName()).toBe('改过的名字')
  })

  it('开着的会话 —— 只改会话名，agent 名不动（两个名字分开维护）', async () => {
    const { env, state: host, pi } = await boot()
    const { agentId: tabId, path } = await seed(host, pi, env.cwd, '原始第一条消息')

    // 前后空格由宿主去掉
    await host.renameConversation(path, '  新标题  ')

    expect(pi.renameCalls).toEqual([{ path, name: '新标题' }])
    expect(SessionManager.open(path).getSessionName()).toBe('新标题')
    expect(host.snapshot().conversations[0]?.title).toBe('新标题')

    /*
     * agent 名**不跟着变**：会话名属于会话文件（裸 pi 也看得到），
     * agent 名是窄轨里的本地名字，由「重命名 agent」改。
     * 两者混在一起改的后果是改一次会话名就动一次文件 mtime，被误判成「在别处被改过」。
     */
    const saved = JSON.parse(readFileSync(join(env.agentDir, 'agents.json'), 'utf8')) as {
      agents: Array<{ id: string; name: string }>
    }
    expect(saved.agents.find((agent) => agent.id === tabId)?.name).not.toBe('新标题')
    // 快照里 agent 的会话名跟着变了，窄轨的悬停气泡靠它显示第二行
    expect(host.snapshot().agents.find((agent) => agent.id === tabId)?.sessionTitle).toBe('新标题')
  })

  it('改名动的是会话文件，但不能把自己标成「在别处改过」', async () => {
    const { env, state: host, pi } = await boot()
    const { agentId, path } = await seed(host, pi, env.cwd, '要改名的会话')
    // 正常聊完一轮：这一轮自己写的东西算「已看到」
    host.handleSessionEvent({ type: 'agent_settled', data: {}, agentId })
    expect(host.snapshot().agents.find((agent) => agent.id === agentId)?.stale).toBe(false)

    // 拉开一点时间，保证下一次写入的 mtime 确实更新
    await new Promise((resolve) => setTimeout(resolve, 20))
    await host.renameConversation(path, '改过的名字')

    expect(host.snapshot().agents.find((agent) => agent.id === agentId)?.stale).toBe(false)
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
