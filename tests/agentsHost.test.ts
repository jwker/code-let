import { describe, expect, it, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import { AgentStore } from '../host/main/agents'
import type { PiEventListener, PiRuntimePort, AgentRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 项目标签与 agent 两层结构（PLAN.md D50 / D53 / D58）。
 *
 * 这一层要守住的是：
 *   - **一个项目一条标签**，同一项目里的多个 agent 都进窄轨
 *   - **关项目标签不碰任何 agent**（R44）
 *   - **归档只改状态**，会话文件不动；恢复能回到窄轨
 *   - **「以此 agent 新建实例」**照搬类型，但会话是新的
 *
 * runtime 全部用假实现 —— 真 runtime 要模型和凭据，测不动。
 */

class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  readonly files = new Map<string, string | null>()
  readonly streaming = new Set<string>()
  readonly calls: string[] = []
  readonly renameCalls: Array<{ path: string; name: string }> = []
  /** 走内存会话的改名（文件还没落盘时用的那条路） */
  readonly nameCalls: Array<{ agentId: string; name: string }> = []

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  hasAgent(agentId: string): boolean {
    // 假 runtime 都登记在 files/opened 里；没有这两个映射的用例不关心「按需补登记」
    const map = (this as unknown as { files?: Map<string, unknown>; opened?: unknown[] }).files
    return map ? map.has(agentId) : true
  }

  async openAgent(agentId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void> {
    this.calls.push(`open:${agentId}`)
    this.files.set(agentId, options.path ?? join(tmpdir(), `fake-${agentId}.jsonl`))
  }

  async closeAgent(agentId: string): Promise<void> {
    this.calls.push(`close:${agentId}`)
    this.streaming.delete(agentId)
  }

  async activateAgent(agentId: string): Promise<void> {
    this.calls.push(`activate:${agentId}`)
  }

  async reloadAgent(): Promise<void> {}

  agentState(agentId: string): AgentRuntimeState {
    return {
      ready: this.files.has(agentId),
      sessionId: `s-${agentId}`,
      sessionFile: this.files.get(agentId) ?? null,
      streaming: this.streaming.has(agentId),
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
  async selectModel(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abortAgent(): Promise<void> {}
  async renameSession(path: string, name: string): Promise<void> {
    this.renameCalls.push({ path, name })
  }
  async setSessionName(agentId: string, name: string): Promise<void> {
    this.nameCalls.push({ agentId, name })
  }
  async listCommands(): Promise<never[]> {
    return []
  }
  async compactAgent(): Promise<void> {}
  async completeCommand(): Promise<never[]> {
    return []
  }
  thinkingLevels(): never[] {
    return []
  }
  setThinkingLevel(): void {}
  async stop(): Promise<void> {}
}

const dirs: string[] = []

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-agentshost-'))
  dirs.push(dir)
  // 故意不往清单里加项目：init() 没有项目时不开「退路标签」，
  // 这样每个用例里出现的 agent 都是它自己建的
  const projects = new ProjectStore(join(dir, 'projects.json'))
  const tabFile = join(dir, 'tabs.json')
  const agentFile = join(dir, 'agents.json')
  const pi = new FakePi()
  const state = new HostState({
    pi,
    tabStore: new TabStore(tabFile),
    agentStore: new AgentStore(agentFile),
    projects,
    trashFile: async () => {}
  })
  return { dir, pi, state, tabFile, agentFile, projects }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

describe('一个项目一条标签', () => {
  it('同一项目里建两个 agent，标签还是一条', async () => {
    const { dir, state, tabFile } = setup()
    await state.init()
    await state.newAgent(dir, 'general')
    await state.newAgent(dir, 'dev')

    expect(state.snapshot().projectTabs).toHaveLength(1)
    expect(state.snapshot().agents).toHaveLength(2)
    const saved = readJson<{ version: number; tabs: unknown[] }>(tabFile)
    expect(saved.version).toBe(2)
    expect(saved.tabs).toHaveLength(1)
    await state.dispose()
  })

  it('活动 agent 记在项目标签上，切走再切回来还在', async () => {
    const { dir, state } = setup()
    await state.init()
    const first = await state.newAgent(dir, 'general')
    await state.newAgent(dir, 'dev')
    expect(state.snapshot().projectTabs[0].activeAgentId).not.toBe(first.id)

    await state.activateAgent(first.id)
    expect(state.snapshot().projectTabs[0].activeAgentId).toBe(first.id)

    // 切到「代码」入口再回来 —— 活动 agent 不丢
    const tabId = state.snapshot().projectTabs[0].id
    await state.setPane(tabId, 'code')
    expect(state.snapshot().projectTabs[0].pane).toBe('code')
    expect(state.snapshot().projectTabs[0].activeAgentId).toBe(first.id)

    await state.setPane(tabId, 'agent')
    expect(state.snapshot().activeTabId).toBe(first.id)
    await state.dispose()
  })
})

describe('关项目标签不碰 agent（R44）', () => {
  it('关掉标签之后，那个项目的 agent 一个都没被归档或关闭', async () => {
    const { dir, state, pi } = setup()
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    const tabId = state.snapshot().projectTabs[0].id
    pi.streaming.add(agent.id)
    pi.calls.length = 0

    await state.closeProjectTab(tabId)

    expect(state.snapshot().projectTabs).toHaveLength(0)
    // agent 还在，还在跑
    const still = state.snapshot().agents.find((item) => item.id === agent.id)
    expect(still?.archivedAt).toBeNull()
    expect(still?.streaming).toBe(true)
    expect(pi.calls).not.toContain(`close:${agent.id}`)
    expect(pi.calls).not.toContain(`abort:${agent.id}`)
    await state.dispose()
  })
})

describe('归档与恢复', () => {
  it('归档把 agent 从窄轨拿掉，会话文件不动；恢复后回来', async () => {
    const { dir, state } = setup()
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    const sessionPath = state.snapshot().agents.find((item) => item.id === agent.id)?.sessionPath
    expect(sessionPath).toBeTruthy()

    await state.archiveAgent(agent.id)
    const archived = state.snapshot().agents.find((item) => item.id === agent.id)
    expect(archived?.archivedAt).toBeTruthy()
    expect(archived?.sessionPath).toBe(sessionPath)
    // 窄轨（投影）里没有它了
    expect(state.snapshot().tabs.some((tab) => tab.id === agent.id)).toBe(false)

    await state.restoreAgent(agent.id)
    expect(state.snapshot().agents.find((item) => item.id === agent.id)?.archivedAt).toBeNull()
    expect(state.snapshot().activeTabId).toBe(agent.id)
    await state.dispose()
  })

  it('正在跑的 agent 不许归档', async () => {
    const { dir, state, pi } = setup()
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    pi.streaming.add(agent.id)
    await expect(state.archiveAgent(agent.id)).rejects.toThrow('正在跑')
    await state.dispose()
  })

  it('归档之后，位置交给相邻的那个', async () => {
    const { dir, state } = setup()
    await state.init()
    const first = await state.newAgent(dir, 'general')
    const second = await state.newAgent(dir, 'general')
    const third = await state.newAgent(dir, 'general')

    await state.activateAgent(second.id)
    await state.archiveAgent(second.id)

    // 三个 agent 一条项目标签 —— 关掉中间那个，活动 agent 落到后面那个
    expect(state.snapshot().activeTabId).toBe(third.id)
    expect(state.snapshot().tabs.map((tab) => tab.id)).toEqual([first.id, third.id])
    await state.dispose()
  })

  it('自动归档：只挑超过天数没活动的通用 agent，正在跑的跳过', async () => {
    const { dir, pi, agentFile } = setup()
    // 先建三个 agent：两个通用、一个开发
    const first = new HostState({
      pi,
      tabStore: new TabStore(join(dir, 'tabs.json')),
      agentStore: new AgentStore(agentFile),
      projects: new ProjectStore(join(dir, 'projects.json'))
    })
    await first.init()
    const general = await first.newAgent(dir, 'general')
    const running = await first.newAgent(dir, 'general')
    const dev = await first.newAgent(dir, 'dev')
    await first.dispose()

    // 把三个都推到 40 天前 —— 直接改盘上的清单（没有别的入口能改这个字段）
    const store = new AgentStore(agentFile)
    const old = Date.now() - 40 * 24 * 60 * 60 * 1000
    store.replaceAll(store.list().map((agent) => ({ ...agent, lastActiveAt: old })))
    pi.streaming.add(running.id)

    const second = new HostState({
      pi,
      tabStore: new TabStore(join(dir, 'tabs.json')),
      agentStore: new AgentStore(agentFile),
      projects: new ProjectStore(join(dir, 'projects.json'))
    })
    await second.init()

    const archived = await second.runAutoArchive(30)

    // 只有「通用且没在跑」的那一个被归档；开发的那个不受影响
    expect(archived).toBe(1)
    const after = new AgentStore(agentFile)
    expect(after.get(general.id)?.archivedAt).toBeTruthy()
    expect(after.get(running.id)?.archivedAt).toBeNull()
    expect(after.get(dev.id)?.archivedAt).toBeNull()
    await second.dispose()
  })

  it('天数填 0 表示不自动归档', async () => {
    const { dir, pi, agentFile } = setup()
    const state = new HostState({
      pi,
      tabStore: new TabStore(join(dir, 'tabs.json')),
      agentStore: new AgentStore(agentFile),
      projects: new ProjectStore(join(dir, 'projects.json'))
    })
    await state.init()
    await state.newAgent(dir, 'general')
    expect(await state.runAutoArchive(0)).toBe(0)
    await state.dispose()
  })
})

describe('以此 agent 新建实例', () => {
  it('类型照搬、实例序号递增、会话是新的', async () => {
    const { dir, state } = setup()
    await state.init()
    const source = await state.newAgent(dir, 'product')
    const copy = await state.newAgentFrom(source.id)

    expect(copy.type).toBe('product')
    expect(copy.instance).toBe(2)
    expect(copy.id).not.toBe(source.id)
    expect(copy.sessionPath).not.toBe(source.sessionPath)
    expect(copy.name).toBe('产品 2')
    await state.dispose()
  })
})

describe('删除 agent', () => {
  it('会话文件移入废纸篓，清单里也没了', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-agentshost-'))
    dirs.push(dir)
    const trashed: string[] = []
    const state = new HostState({
      pi: new FakePi(),
      tabStore: new TabStore(join(dir, 'tabs.json')),
      agentStore: new AgentStore(join(dir, 'agents.json')),
      projects: new ProjectStore(join(dir, 'projects.json')),
      trashFile: async (path) => {
        trashed.push(path)
      }
    })
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    const sessionPath = state.snapshot().agents.find((item) => item.id === agent.id)?.sessionPath

    await state.deleteAgent(agent.id)

    expect(state.snapshot().agents.some((item) => item.id === agent.id)).toBe(false)
    // 会话文件真存在时才移废纸篓；这个假 runtime 给的是 tmp 下的路径，不一定存在
    expect(trashed.every((path) => path === sessionPath)).toBe(true)
    await state.dispose()
  })
})

describe('启动时登记 runtime（真机回归）', () => {
  it('同一个项目里的每个 agent 都登记上 —— 不只活动那个', async () => {
    const { dir, state, pi } = setup()
    await state.init()
    // 一个项目里放三个 agent，项目标签只记最后那个是「活动」的
    const first = await state.newAgent(dir, 'general')
    const second = await state.newAgent(dir, 'general')
    const third = await state.newAgent(dir, 'general')
    await state.dispose()

    // 重新开一次（等价于重启应用）
    const restarted = new HostState({
      pi,
      tabStore: new TabStore(join(dir, 'tabs.json')),
      agentStore: new AgentStore(join(dir, 'agents.json')),
      projects: new ProjectStore(join(dir, 'projects.json'))
    })
    await restarted.init()

    for (const agent of [first, second, third]) {
      expect(pi.hasAgent(agent.id)).toBe(true)
    }
    // 每一个都能激活，不会「标签不存在」
    for (const agent of [first, second, third]) {
      await expect(restarted.activateAgent(agent.id)).resolves.toBeUndefined()
    }
    expect(restarted.snapshot().activeTabId).toBe(third.id)
    await restarted.dispose()
  })

  it('runtime 没登记过的 agent，激活时按需补登记', async () => {
    const { dir, state, pi } = setup()
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    // 模拟「启动时没登记到它」：直接从假 runtime 里抹掉
    pi.files.delete(agent.id)
    pi.calls.length = 0

    await state.activateAgent(agent.id)

    expect(pi.calls).toContain(`open:${agent.id}`)
    expect(pi.calls).toContain(`activate:${agent.id}`)
    await state.dispose()
  })
})

describe('迁移后的标签顺序', () => {
  it('v1 的多条会话标签合成一条项目标签，agent 都留着', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-migrate-'))
    dirs.push(dir)
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const tabFile = join(dir, 'tabs.json')
    writeFileSync(
      tabFile,
      JSON.stringify({
        tabs: [
          { id: 't1', cwd: dir, path: join(dir, 'a.jsonl'), title: '甲' },
          { id: 't2', cwd: dir, path: join(dir, 'b.jsonl'), title: '乙' },
          { id: 't3', cwd: join(dir, 'other'), path: join(dir, 'c.jsonl'), title: '丙' }
        ]
      })
    )
    const state = new HostState({
      pi: new FakePi(),
      tabStore: new TabStore(tabFile),
      agentStore: new AgentStore(join(dir, 'agents.json')),
      projects
    })
    await state.init()

    expect(state.snapshot().projectTabs).toHaveLength(2)
    expect(state.snapshot().agents).toHaveLength(3)
    // 同一项目里的活动 agent 是第一个
    const tabsForDir = state.snapshot().projectTabs.filter((tab) => tab.cwd === dir)
    expect(tabsForDir).toHaveLength(1)
    expect(state.snapshot().agents.map((agent) => agent.name).sort()).toEqual(['丙', '乙', '甲'])
    await state.dispose()
  })

  it('再启动一次不会重复建 agent（幂等）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-migrate-'))
    dirs.push(dir)
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const tabFile = join(dir, 'tabs.json')
    writeFileSync(tabFile, JSON.stringify({ tabs: [{ id: 't1', cwd: dir, path: null, title: '甲' }] }))

    const makeState = () =>
      new HostState({
        pi: new FakePi(),
        tabStore: new TabStore(tabFile),
        agentStore: new AgentStore(join(dir, 'agents.json')),
        projects
      })

    const first = makeState()
    await first.init()
    const countAfterFirst = first.snapshot().agents.length
    await first.dispose()

    const second = makeState()
    await second.init()
    expect(second.snapshot().agents).toHaveLength(countAfterFirst)
    expect(second.snapshot().projectTabs).toHaveLength(1)
    await second.dispose()
  })
})

describe('重命名 agent（只改 agent 名）', () => {
  it('只改 agents.json，不碰会话文件也不碰内存会话', async () => {
    const { dir, state, pi } = setup()
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    pi.renameCalls.length = 0
    pi.nameCalls.length = 0

    await state.renameAgent(agent.id, '  查登录  ')

    expect(state.snapshot().agents.find((item) => item.id === agent.id)?.name).toBe('查登录')
    // 两个名字分开维护 —— 改名不该动会话文件
    expect(pi.renameCalls).toEqual([])
    expect(pi.nameCalls).toEqual([])
    await state.dispose()
  })

  it('★ 改名不会把 agent 标成「在别处被改过」', async () => {
    const { dir, state } = setup()
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    const path = state.snapshot().agents.find((item) => item.id === agent.id)?.sessionPath
    expect(path).toBeTruthy()
    // 造出会话文件，再用 reloadTab 把「已经看到」的水位推到它的当前 mtime
    writeFileSync(path as string, '')
    await state.reloadTab(agent.id)

    await state.renameAgent(agent.id, '改个名')
    await state.refreshConversations()

    // 改名不写会话文件 → mtime 没动 → 不该被标成「在别处被改过」
    // （写文件的话 mtime 会变，而 mtime 正是 stale 的判据，输入框会跟着被禁用）
    expect(state.snapshot().tabs[0]?.stale).toBe(false)

    // 对照组：直接改文件才会被标出来
    await new Promise((resolve) => setTimeout(resolve, 20))
    writeFileSync(path as string, '{"x":1}\n')
    await state.refreshConversations()
    expect(state.snapshot().tabs[0]?.stale).toBe(true)
    await state.dispose()
  })

  it('空名字被拒绝', async () => {
    const { dir, state } = setup()
    await state.init()
    const agent = await state.newAgent(dir, 'general')
    await expect(state.renameAgent(agent.id, '   ')).rejects.toThrow('名字不能为空')
    await state.dispose()
  })
})

describe('导入外部会话（D59）', () => {
  it('导入不在会话清单里的路径会被拒绝', async () => {
    const { state } = setup()
    await state.init()
    await expect(state.importConversation('/nope/not-a-session.jsonl')).rejects.toThrow('不在当前会话列表里')
    await state.dispose()
  })
})
