import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentTypeDraft } from '@contract/index'
import { AgentTypeStore } from '../host/main/agentTypes'
import { AgentStore } from '../host/main/agents'
import { ProjectStore } from '../host/main/projects'
import { HostState } from '../host/main/state'
import { TabStore } from '../host/main/tabs'
import { FakePi } from './support/fakePi'

/**
 * agent 类型定义清单的落盘与宿主动作（ADR-0004）。
 *
 * 守住三件事：内置三个的名字/颜色只读而提示词可改；自定义 agent 能增删改并重启读回；
 * **有 agent 在用就不让删**。
 */

const dirs: string[] = []

function draft(overrides: Partial<AgentTypeDraft> = {}): AgentTypeDraft {
  return { name: '写作', description: '写点东西', prompt: '', color: 'blue', ...overrides }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-agenttypes-'))
  dirs.push(dir)
  const files = {
    tabs: join(dir, 'tabs.json'),
    agents: join(dir, 'agents.json'),
    types: join(dir, 'agentTypes.json')
  }
  const pi = new FakePi()
  const state = new HostState({
    pi,
    tabStore: new TabStore(files.tabs),
    agentStore: new AgentStore(files.agents),
    agentTypeStore: new AgentTypeStore(files.types),
    projects: new ProjectStore(join(dir, 'projects.json')),
    trashFile: async () => {}
  })
  return { dir, files, pi, state }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T
}

describe('内置三个', () => {
  it('名字、说明、颜色来自代码，提示词可以是空的', () => {
    const { state } = setup()
    const types = state.listAgentTypes()
    expect(types.slice(0, 3).map((def) => def.name)).toEqual(['基础', '开发', '产品'])
    expect(types.slice(0, 3).every((def) => def.builtin)).toBe(true)
    expect(types.slice(0, 3).every((def) => def.prompt === '')).toBe(true)
  })

  it('只收提示词：名字与颜色传进来也改不了', () => {
    const { state } = setup()
    const result = state.updateAgentType(
      'general',
      draft({ name: '改个名', description: '改说明', prompt: '你是万能的。', color: 'red' })
    )
    expect(result.ok).toBe(true)
    const def = state.listAgentTypes().find((item) => item.id === 'general')
    expect(def).toMatchObject({ name: '基础', description: '普通对话，没有额外能力。', prompt: '你是万能的。' })
    expect(def?.color).toBeNull()
  })

  it('清空提示词等于没改 —— 不留下空串', () => {
    const { dir, files, state } = setup()
    state.updateAgentType('general', draft({ prompt: '  ' }))
    expect(state.listAgentTypes()[0]?.prompt).toBe('  ')
    state.updateAgentType('general', draft({ prompt: '' }))
    const saved = readJson<{ prompts: Record<string, string> }>(files.types)
    expect(saved.prompts.general).toBeUndefined()
    expect(new AgentTypeStore(files.types).list()[0]?.prompt).toBe('')
    expect(dir).toBeTruthy()
  })

  it('内置的不能删', () => {
    const { state } = setup()
    expect(state.removeAgentType('product')).toEqual({
      ok: false,
      error: '内置的 agent 类型不能删除'
    })
  })

  it('提示词超长被拒', () => {
    const { state } = setup()
    expect(state.updateAgentType('dev', draft({ prompt: '写'.repeat(4001) }))).toEqual({
      ok: false,
      error: '提示词最多 4000 个字'
    })
  })
})

describe('自定义 agent', () => {
  it('新建后落盘，重启读回', () => {
    const { files, state } = setup()
    const result = state.createAgentType(draft())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.type.id).toMatch(/^t-[0-9a-f]{8}$/)
    expect(result.type.builtin).toBe(false)
    expect(result.type.color).toBe('blue')

    const reloaded = new AgentTypeStore(files.types).list()
    expect(reloaded).toHaveLength(4)
    expect(reloaded[3]).toMatchObject({ name: '写作', description: '写点东西', color: 'blue' })
  })

  it('按创建顺序排在后面，不按名字排', () => {
    const { state } = setup()
    state.createAgentType(draft({ name: '乙' }))
    state.createAgentType(draft({ name: '甲' }))
    expect(state.listAgentTypes().map((def) => def.name)).toEqual(['基础', '开发', '产品', '乙', '甲'])
  })

  it('改名不改 id', () => {
    const { state } = setup()
    const created = state.createAgentType(draft())
    if (!created.ok) throw new Error('创建失败')
    const updated = state.updateAgentType(created.type.id, draft({ name: '写手', color: 'berry' }))
    expect(updated.ok && updated.type).toMatchObject({
      id: created.type.id,
      name: '写手',
      color: 'berry'
    })
  })

  it('重名被拒，包括跟内置三个重名', () => {
    const { state } = setup()
    state.createAgentType(draft())
    expect(state.createAgentType(draft())).toEqual({
      ok: false,
      error: '已经有同名的 agent'
    })
    expect(state.createAgentType(draft({ name: '基础' }))).toEqual({
      ok: false,
      error: '已经有同名的 agent'
    })
  })

  it('最多 50 个', () => {
    const { state } = setup()
    for (let i = 0; i < 50; i += 1) {
      const result = state.createAgentType(draft({ name: `第 ${i} 个` }))
      expect(result.ok).toBe(true)
    }
    expect(state.createAgentType(draft({ name: '第 51 个' }))).toEqual({
      ok: false,
      error: '最多 50 个自定义 agent'
    })
  })

  it('有 agent 在用就不让删；不用了才能删', async () => {
    const { dir, state, pi } = setup()
    const created = state.createAgentType(draft())
    if (!created.ok) throw new Error('创建失败')
    const agent = await state.newAgent(dir, created.type.id)
    expect(pi.promptFragmentsOf(agent.id)).toEqual([])

    expect(state.removeAgentType(created.type.id)).toEqual({
      ok: false,
      error: '有 1 个 agent 在用',
      usedBy: 1
    })

    await state.deleteAgent(agent.id)
    expect(state.removeAgentType(created.type.id)).toEqual({ ok: true })
    expect(state.listAgentTypes()).toHaveLength(3)
    await state.dispose()
  })

  it('自定义类型建 agent 时默认名用它的名字', async () => {
    const { dir, state } = setup()
    const created = state.createAgentType(draft({ name: '写作' }))
    if (!created.ok) throw new Error('创建失败')
    const agent = await state.newAgent(dir, created.type.id)
    expect(agent.name).toBe('写作 1')
    await state.dispose()
  })
})

describe('坏文件', () => {
  it('agentTypes.json 坏了按空清单启动，agents.json 里的记录一条不丢', () => {
    const { dir, files, state } = setup()
    void state
    writeFileSync(files.types, '{ 这不是 json', 'utf8')
    writeFileSync(
      files.agents,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: 'a1',
            name: '写作 1',
            // 这个类型在清单里已经找不到了
            type: 't-deadbeef',
            instance: 1,
            cwd: dir,
            sessionPath: null,
            lastActiveAt: 1
          }
        ]
      }),
      'utf8'
    )

    const restarted = new HostState({
      pi: new FakePi(),
      tabStore: new TabStore(files.tabs),
      agentStore: new AgentStore(files.agents),
      agentTypeStore: new AgentTypeStore(files.types),
      projects: new ProjectStore(join(dir, 'projects.json')),
      trashFile: async () => {}
    })
    expect(restarted.listAgentTypes()).toHaveLength(3)
    expect(restarted.snapshot().agents).toHaveLength(1)
    expect(restarted.snapshot().agents[0]?.type).toBe('t-deadbeef')
  })

  it('新版本写的文件不覆盖', () => {
    const { files } = setup()
    writeFileSync(files.types, JSON.stringify({ version: 2, types: [{ whatever: true }] }), 'utf8')
    const store = new AgentTypeStore(files.types)
    expect(store.list()).toHaveLength(3)
    expect(store.create(draft(), 1)).toEqual({
      ok: false,
      error: '这个文件是更新版本的应用写的，改不了'
    })
    // 文件原样不动
    expect(readJson<{ version: number }>(files.types).version).toBe(2)
  })
})

describe('推送', () => {
  it('增删改都发一份新的清单', () => {
    const { state } = setup()
    const seen: number[] = []
    state.on('agent-types', (types: unknown[]) => seen.push(types.length))
    const created = state.createAgentType(draft())
    if (!created.ok) throw new Error('创建失败')
    state.updateAgentType(created.type.id, draft({ name: '写手' }))
    state.removeAgentType(created.type.id)
    expect(seen).toEqual([4, 4, 3])
  })
})
