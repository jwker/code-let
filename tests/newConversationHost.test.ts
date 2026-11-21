import { treeStubs } from './support/runtimeTree'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostState } from '../host/main/state'
import { TabStore } from '../host/main/tabs'
import { ProjectStore } from '../host/main/projects'
import type { PiRuntimePort, AgentRuntimeState } from '../host/main/pi/runtime'

/**
 * 新建对话时定的名字要落到两处：标签标题，以及 Pi 的会话名。
 *
 * 会话文件在第一条消息之前还不存在，所以这里验的是「名字交给谁了」——
 * Pi 自己会在落盘时把它写出去。
 */

class FakePi implements PiRuntimePort {
  // 树操作：这些用例用不到，挂一份空实现
  readTree = treeStubs.readTree
  navigateTree = treeStubs.navigateTree
  forkTree = treeStubs.forkTree
  labelTree = treeStubs.labelTree

  tabs = new Map<string, AgentRuntimeState>()
  named: Array<{ agentId: string; name: string }> = []
  private seq = 0

  hasAgent(agentId: string): boolean {
    // 假 runtime 都登记在 files/opened 里；没有这两个映射的用例不关心「按需补登记」
    const map = (this as unknown as { files?: Map<string, unknown>; opened?: unknown[] }).files
    return map ? map.has(agentId) : true
  }

  async openAgent(tabId: string): Promise<void> {
    this.seq += 1
    this.tabs.set(tabId, {
      ready: true,
      sessionId: `s-${this.seq}`,
      sessionFile: `/fake/session-${this.seq}.jsonl`,
      streaming: false,
      model: null,
      thinkingLevel: null,
      modelFallback: null
    })
  }

  agentState(tabId: string): AgentRuntimeState {
    return (
      this.tabs.get(tabId) ?? {
        ready: false,
        sessionId: null,
        sessionFile: null,
        streaming: false,
        model: null,
        thinkingLevel: null,
        modelFallback: null
      }
    )
  }

  async setSessionName(agentId: string, name: string): Promise<void> {
    this.named.push({ agentId, name })
  }

  onEvent = () => () => {}
  async closeAgent(): Promise<void> {}
  async activateAgent(): Promise<void> {}
  async reloadAgent(): Promise<void> {}
  readEntries = () => []
  async listModels() {
    return []
  }
  async refreshModelAvailability(): Promise<void> {}
  async selectModel(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async listCommands() {
    return []
  }
  async completeCommand() {
    return []
  }
  thinkingLevels = () => []
  setThinkingLevel(): void {}
  async compactAgent(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abortAgent(): Promise<void> {}
  async stop(): Promise<void> {}
}

function makeState(): { state: HostState; pi: FakePi } {
  const pi = new FakePi()
  const dir = mkdtempSync(join(tmpdir(), 'codelet-newconv-'))
  const state = new HostState({
    pi,
    tabStore: new TabStore(join(dir, 'tabs.json')),
    projects: new ProjectStore(join(dir, 'projects.json')),
    trashFile: async () => {}
  })
  return { state, pi }
}

describe('新建对话的名字', () => {
  it('给了名字就同时当标签标题和 Pi 的会话名', async () => {
    const { state, pi } = makeState()
    await state.newConversation('/tmp/project', '会话123')
    const snapshot = state.snapshot()
    expect(snapshot.agents[0]!.name).toBe('会话123')
    expect(pi.named).toEqual([{ agentId: snapshot.agents[0]!.id, name: '会话123' }])
  })

  it('名字两头的空格会去掉', async () => {
    const { state, pi } = makeState()
    await state.newConversation('/tmp/project', '  会话007  ')
    expect(state.snapshot().agents[0]!.name).toBe('会话007')
    expect(pi.named[0]!.name).toBe('会话007')
  })

  it('没有名字就不去动 Pi 的会话名（标题退回首条消息）', async () => {
    const { state, pi } = makeState()
    await state.newConversation('/tmp/project')
    // 没填名字的 agent 先用默认名（D53）；第一条消息落盘后由会话标题接管
    expect(state.snapshot().agents[0]!.name).toBe('基础 1')
    expect(pi.named).toHaveLength(0)
  })

  it('只有空格也算没名字', async () => {
    const { state, pi } = makeState()
    await state.newConversation('/tmp/project', '   ')
    expect(pi.named).toHaveLength(0)
  })
})
