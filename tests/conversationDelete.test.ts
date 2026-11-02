import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 删除会话（PLAN.md D23）。
 *
 * 要害在顺序：先摘标签、再关 runtime（abort + dispose），最后才移文件。
 * 文件删了而 runtime 还活着的话，下一条消息会用 appendFileSync
 * 重建一个没有头部的会话文件 —— 会话就坏了。
 *
 * 用真 SDK 落盘（跟 conversationList.test.ts 一样），假运行时只管记账。
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
  private streaming = new Set<string>()
  readonly order: string[]
  readonly closedWhileStreaming: string[] = []
  failClose = false

  constructor(order: string[]) {
    this.order = order
  }

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async openTab(tabId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void> {
    const manager = options.path ? SessionManager.open(options.path) : SessionManager.create(options.cwd)
    this.managers.set(tabId, manager)
  }

  async closeTab(tabId: string): Promise<void> {
    this.order.push(`close:${tabId}`)
    if (this.streaming.has(tabId)) this.closedWhileStreaming.push(tabId)
    if (this.failClose) throw new Error('关标签失败')
    this.managers.delete(tabId)
    this.streaming.delete(tabId)
  }

  async activateTab(tabId: string): Promise<void> {
    this.order.push(`activate:${tabId}`)
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
      streaming: this.streaming.has(tabId),
      model: null,
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

  async selectModel(): Promise<void> {
    // 不参与
  }

  async abortTab(): Promise<void> {
    // 不参与
  }

  async renameSession(): Promise<void> {
    // 重命名不参与这份测试
  }

  async stop(): Promise<void> {
    this.listeners.clear()
  }

  setStreaming(tabId: string, streaming: boolean): void {
    if (streaming) this.streaming.add(tabId)
    else this.streaming.delete(tabId)
  }
}

class FakeTrash {
  readonly order: string[]
  readonly calls: string[] = []
  failOn = new Set<string>()
  gate: Promise<void> | null = null
  started: (() => void) | null = null

  constructor(order: string[]) {
    this.order = order
  }

  async run(path: string): Promise<void> {
    this.order.push(`trash:${path}`)
    this.calls.push(path)
    this.started?.()
    if (this.gate) await this.gate
    if (this.failOn.has(path)) throw new Error('系统废纸篓不可用')
    rmSync(path, { force: true })
  }
}

let env: Env | null = null
let state: HostState | null = null
let previousAgentDir: string | undefined

function setup(): Env {
  const agentDir = mkdtempSync(join(tmpdir(), 'codelet-delete-agent-'))
  const cwd = mkdtempSync(join(tmpdir(), 'codelet-delete-cwd-'))
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const projects = new ProjectStore(join(agentDir, 'projects.json'))
  projects.add(cwd)
  return { agentDir, cwd, projects, tabFile: join(agentDir, 'tabs.json') }
}

async function boot(): Promise<{ env: Env; pi: FakePi; trash: FakeTrash; state: HostState }> {
  env = setup()
  const order: string[] = []
  const pi = new FakePi(order)
  const trash = new FakeTrash(order)
  state = new HostState({
    pi,
    tabStore: new TabStore(env.tabFile),
    projects: env.projects,
    trashFile: (path) => trash.run(path)
  })
  await state.init()
  return { env, pi, trash, state }
}

/** 在 cwd 里说一句话，让它落盘成一条真会话，并返回它的标签与会话文件 */
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

describe('删除会话', () => {
  it('路径不在当前会话列表里 —— 整批拒绝，一条都不删', async () => {
    const { env, state: host, trash } = await boot()
    const stranger = join(env.cwd, '..', 'stranger.jsonl')

    await expect(host.deleteConversations([stranger])).rejects.toThrow('不在当前对话列表里')
    expect(trash.calls).toEqual([])
  })

  it('先关标签、再移文件；文件不在了，列表里也没了', async () => {
    const { env, state: host, pi, trash } = await boot()
    const { tabId, path } = await seed(host, pi, env.cwd, '要被删掉的会话')

    const result = await host.deleteConversations([path])

    expect(trash.calls).toEqual([path])
    expect(existsSync(path)).toBe(false)
    expect(result).toEqual({ deleted: [path], failed: [] })
    expect(host.snapshot().tabs.some((tab) => tab.id === tabId)).toBe(false)
    expect(host.snapshot().conversations).toHaveLength(0)
    // 顺序：关标签在移文件之前
    expect(trash.order.indexOf(`close:${tabId}`)).toBeLessThan(trash.order.indexOf(`trash:${path}`))
  })

  it('只关受影响的标签，其他标签留着', async () => {
    const { env, state: host, pi } = await boot()
    const first = await seed(host, pi, env.cwd, '第一个会话')
    const second = await seed(host, pi, env.cwd, '第二个会话')

    await host.deleteConversations([first.path])

    const tabs = host.snapshot().tabs
    expect(tabs.some((tab) => tab.id === first.tabId)).toBe(false)
    expect(tabs.some((tab) => tab.id === second.tabId)).toBe(true)
    expect(host.snapshot().conversations.map((c) => c.path)).toEqual([second.path])
  })

  it('删掉活动标签后，活动标签落到相邻的一个', async () => {
    const { env, state: host, pi } = await boot()
    const first = await seed(host, pi, env.cwd, '第一个会话')
    const second = await seed(host, pi, env.cwd, '第二个会话')

    await host.activateTab(first.tabId)
    await host.deleteConversations([first.path])

    expect(host.snapshot().activeTabId).toBe(second.tabId)
  })

  it('同路径的文件标签也一起关掉', async () => {
    const { env, state: host, pi } = await boot()
    const { path } = await seed(host, pi, env.cwd, '会话文件也被打开着')

    await host.openFile(env.cwd, path)
    expect(host.snapshot().files).toHaveLength(1)

    await host.deleteConversations([path])

    expect(host.snapshot().files).toHaveLength(0)
    expect(host.snapshot().activeFileId).toBeNull()
  })

  it('文件已经被别处删掉 —— 算删掉，不调 trash', async () => {
    const { env, state: host, pi, trash } = await boot()
    const { path } = await seed(host, pi, env.cwd, '先被别处删掉的会话')
    rmSync(path, { force: true })

    const result = await host.deleteConversations([path])

    expect(trash.calls).toEqual([])
    expect(result.deleted).toEqual([path])
    expect(host.snapshot().conversations).toHaveLength(0)
  })

  it('trash 失败 —— 记失败，文件留下，其他条照常删', async () => {
    const { env, state: host, pi, trash } = await boot()
    const first = await seed(host, pi, env.cwd, '能删掉的会话')
    const second = await seed(host, pi, env.cwd, '删不掉的会话')
    trash.failOn.add(second.path)

    const result = await host.deleteConversations([first.path, second.path])

    expect(result.deleted).toEqual([first.path])
    expect(result.failed).toEqual([{ path: second.path, reason: '系统废纸篓不可用' }])
    expect(host.snapshot().conversations.map((c) => c.path)).toEqual([second.path])
  })

  it('正在跑的标签在关标签时被记下来（abort 走同一条路径）', async () => {
    const { env, state: host, pi } = await boot()
    const { tabId, path } = await seed(host, pi, env.cwd, '正在跑的会话')
    pi.setStreaming(tabId, true)

    await host.deleteConversations([path])

    expect(pi.closedWhileStreaming).toEqual([tabId])
  })

  it('关标签失败 —— 整批中止，不碰文件', async () => {
    const { env, state: host, pi, trash } = await boot()
    const { path } = await seed(host, pi, env.cwd, '关标签会失败的会话')
    pi.failClose = true

    await expect(host.deleteConversations([path])).rejects.toThrow('关标签失败')
    expect(trash.calls).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  it('并发的第二个删除请求被拒绝', async () => {
    const { env, state: host, pi, trash } = await boot()
    const first = await seed(host, pi, env.cwd, '第一个会话')
    const second = await seed(host, pi, env.cwd, '第二个会话')

    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    trash.gate = gate
    trash.started = started

    const running = host.deleteConversations([first.path, second.path])
    await startedPromise
    await expect(host.deleteConversations([second.path])).rejects.toThrow('上一次删除还没结束')
    release()
    await running
  })
})
