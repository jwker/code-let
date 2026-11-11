import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HostState } from '../host/main/state'
import { TabStore } from '../host/main/tabs'
import { ProjectStore } from '../host/main/projects'
import type { PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'

/**
 * 新建对话时定的名字要落到两处：标签标题，以及 Pi 的会话名。
 *
 * 会话文件在第一条消息之前还不存在，所以这里验的是「名字交给谁了」——
 * Pi 自己会在落盘时把它写出去。
 */

class FakePi implements PiRuntimePort {
  tabs = new Map<string, TabRuntimeState>()
  named: Array<{ tabId: string; name: string }> = []
  private seq = 0

  async openTab(tabId: string): Promise<void> {
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

  tabState(tabId: string): TabRuntimeState {
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

  async setSessionName(tabId: string, name: string): Promise<void> {
    this.named.push({ tabId, name })
  }

  onEvent = () => () => {}
  async closeTab(): Promise<void> {}
  async activateTab(): Promise<void> {}
  async reloadTab(): Promise<void> {}
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
  async compactTab(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abortTab(): Promise<void> {}
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
    expect(snapshot.tabs[0]!.title).toBe('会话123')
    expect(pi.named).toEqual([{ tabId: snapshot.tabs[0]!.id, name: '会话123' }])
  })

  it('名字两头的空格会去掉', async () => {
    const { state, pi } = makeState()
    await state.newConversation('/tmp/project', '  会话007  ')
    expect(state.snapshot().tabs[0]!.title).toBe('会话007')
    expect(pi.named[0]!.name).toBe('会话007')
  })

  it('没有名字就不去动 Pi 的会话名（标题退回首条消息）', async () => {
    const { state, pi } = makeState()
    await state.newConversation('/tmp/project')
    expect(state.snapshot().tabs[0]!.title).toBe('新对话')
    expect(pi.named).toHaveLength(0)
  })

  it('只有空格也算没名字', async () => {
    const { state, pi } = makeState()
    await state.newConversation('/tmp/project', '   ')
    expect(pi.named).toHaveLength(0)
  })
})
