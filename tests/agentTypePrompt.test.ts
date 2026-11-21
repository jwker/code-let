import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
 * 类型提示词怎么进系统提示（ADR-0004）。
 *
 * 拼的是 `appendSystemPrompt`：用户提示词在前，程序片段在后。
 * 空提示词不占位置 —— 不留空串；未知类型什么也拿不到。
 */

const dirs: string[] = []

function draft(overrides: Partial<AgentTypeDraft> = {}): AgentTypeDraft {
  return { name: '写作', description: '', prompt: '', color: 'teal', ...overrides }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-typeprompt-'))
  dirs.push(dir)
  const files = {
    tabs: join(dir, 'tabs.json'),
    agents: join(dir, 'agents.json'),
    types: join(dir, 'agentTypes.json'),
    projects: join(dir, 'projects.json')
  }
  const pi = new FakePi()
  const state = new HostState({
    pi,
    tabStore: new TabStore(files.tabs),
    agentStore: new AgentStore(files.agents),
    agentTypeStore: new AgentTypeStore(files.types),
    projects: new ProjectStore(files.projects),
    trashFile: async () => {}
  })
  return { dir, files, pi, state }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('自定义 agent', () => {
  it('拿到的就是它的提示词那一段', async () => {
    const { dir, state, pi } = setup()
    const created = state.createAgentType(draft({ prompt: '你是写作助手，先问清读者是谁。' }))
    if (!created.ok) throw new Error('创建失败')
    const agent = await state.newAgent(dir, created.type.id)

    expect(pi.promptFragmentsOf(agent.id)).toEqual(['你是写作助手，先问清读者是谁。'])
    await state.dispose()
  })

  it('提示词改了，已经开着的会话不变；重载之后才换', async () => {
    const { dir, state, pi } = setup()
    const created = state.createAgentType(draft({ prompt: '旧提示词' }))
    if (!created.ok) throw new Error('创建失败')
    const agent = await state.newAgent(dir, created.type.id)

    state.updateAgentType(created.type.id, draft({ prompt: '新提示词' }))
    expect(pi.promptFragmentsOf(agent.id)).toEqual(['旧提示词'])

    await state.reloadTab(agent.id)
    expect(pi.reloaded.at(-1)).toEqual({
      agentId: agent.id,
      options: { appendSystemPrompt: ['新提示词'] }
    })
    await state.dispose()
  })

  it('重启之后按当前提示词重新注入', async () => {
    const { dir, files, pi, state } = setup()
    const created = state.createAgentType(draft({ prompt: '第一版' }))
    if (!created.ok) throw new Error('创建失败')
    const agent = await state.newAgent(dir, created.type.id)
    state.updateAgentType(created.type.id, draft({ prompt: '第二版' }))
    await state.dispose()

    // 新进程：agent 记录还在，类型清单还在，runtime 是新的
    const restartedPi = new FakePi()
    const restarted = new HostState({
      pi: restartedPi,
      tabStore: new TabStore(files.tabs),
      agentStore: new AgentStore(files.agents),
      agentTypeStore: new AgentTypeStore(files.types),
      projects: new ProjectStore(files.projects),
      trashFile: async () => {}
    })
    await restarted.activateAgent(agent.id)
    expect(restartedPi.promptFragmentsOf(agent.id)).toEqual(['第二版'])
    expect(pi.promptFragmentsOf(agent.id)).toEqual(['第一版'])
    await restarted.dispose()
  })
})

describe('内置类型', () => {
  it('基础 agent 没提示词就是空数组', async () => {
    const { dir, state, pi } = setup()
    const agent = await state.newAgent(dir, 'general')
    expect(pi.promptFragmentsOf(agent.id) ?? []).toEqual([])
    await state.dispose()
  })

  it('基础 agent 写了提示词就有那一段', async () => {
    const { dir, state, pi } = setup()
    state.updateAgentType('general', draft({ prompt: '回答先给结论。' }))
    const agent = await state.newAgent(dir, 'general')
    expect(pi.promptFragmentsOf(agent.id)).toEqual(['回答先给结论。'])
    await state.dispose()
  })

  it('产品 agent：用户提示词在前，程序片段在后', async () => {
    const { dir, state, pi } = setup()
    state.updateAgentType('product', draft({ prompt: '你是产品经理。' }))
    const agent = await state.newAgent(dir, 'product')
    const fragments = pi.promptFragmentsOf(agent.id) ?? []

    expect(fragments).toHaveLength(2)
    expect(fragments[0]).toBe('你是产品经理。')
    expect(fragments[1]).toContain('data-block')
    expect(fragments[1]).toContain(dir)
    await state.dispose()
  })

  it('产品 agent 没提示词时只有程序片段', async () => {
    const { dir, state, pi } = setup()
    const agent = await state.newAgent(dir, 'product')
    const fragments = pi.promptFragmentsOf(agent.id) ?? []
    expect(fragments).toHaveLength(1)
    expect(fragments[0]).toContain('data-block')
    await state.dispose()
  })

  it('提示词首尾有空格不影响「是否为空」的判断，但内容原样保留', async () => {
    const { dir, state, pi } = setup()
    state.updateAgentType('dev', draft({ prompt: '  只改我点名的文件。\n' }))
    const agent = await state.newAgent(dir, 'dev')
    expect(pi.promptFragmentsOf(agent.id)).toEqual(['  只改我点名的文件。\n'])
    await state.dispose()
  })
})

describe('未知 agent', () => {
  it('拿不到任何片段', async () => {
    const { dir, state, pi } = setup()
    const agent = await state.newAgent(dir, 't-deadbeef')
    expect(pi.promptFragmentsOf(agent.id) ?? []).toEqual([])
    // 默认名不会变成 undefined
    expect(agent.name).toBe('未知 1')
    await state.dispose()
  })
})
