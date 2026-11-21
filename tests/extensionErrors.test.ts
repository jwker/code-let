import { treeStubs } from './support/runtimeTree'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEvent, PiEventListener, PiRuntimePort, AgentRuntimeState } from '../host/main/pi/runtime'
import type { CommandOption, ModelOption, StreamItem } from '@contract/index'

/**
 * 扩展错误的界面出口（PLAN.md D30）。
 *
 * 加载/执行错误走 extension_error 宿主事件，进快照；不进会话事件流。
 * 同一个错误只保留一条，最多 20 条，可以整批清除。
 */

class FakePi implements PiRuntimePort {
  // 树操作：这些用例用不到，挂一份空实现
  readTree = treeStubs.readTree
  navigateTree = treeStubs.navigateTree
  forkTree = treeStubs.forkTree
  labelTree = treeStubs.labelTree

  private listeners = new Set<PiEventListener>()

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: PiEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  hasAgent(agentId: string): boolean {
    // 假 runtime 都登记在 files/opened 里；没有这两个映射的用例不关心「按需补登记」
    const map = (this as unknown as { files?: Map<string, unknown>; opened?: unknown[] }).files
    return map ? map.has(agentId) : true
  }

  async openAgent(): Promise<void> {}
  async closeAgent(): Promise<void> {}
  async activateAgent(): Promise<void> {}
  async reloadAgent(): Promise<void> {}
  agentState(): AgentRuntimeState {
    return {
      ready: false,
      sessionId: null,
      sessionFile: null,
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
  async selectModel(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setSessionName(): Promise<void> {}
  async listCommands(): Promise<CommandOption[]> {
    return []
  }
  async compactAgent(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abortAgent(): Promise<void> {}
  async completeCommand(): Promise<never[]> {
    return []
  }

  thinkingLevels(): never[] {
    return []
  }

  setThinkingLevel(): void {
    // 不参与
  }

  async stop(): Promise<void> {}
}

const dirs: string[] = []
let state: HostState | null = null

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codelet-ext-error-'))
  dirs.push(root)
  const pi = new FakePi()
  state = new HostState({
    pi,
    projects: new ProjectStore(join(root, 'projects.json')),
    tabStore: new TabStore(join(root, 'tabs.json')),
    trashFile: async () => {}
  })
  return { pi, host: state }
}

afterEach(async () => {
  await state?.dispose()
  state = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('扩展错误', () => {
  it('加载错误进快照，不混进会话事件流', async () => {
    const { pi, host } = setup()
    await host.init()
    const sessionEvents: string[] = []
    host.on('session-event', (event: { type: string }) => sessionEvents.push(event.type))

    pi.emit({
      type: 'extension_error',
      agentId: 'tab-1',
      data: { kind: 'load', path: '/ext/x.js', message: 'boom', at: 1 }
    })

    expect(host.snapshot().extensionErrors).toEqual([
      { kind: 'load', path: '/ext/x.js', message: 'boom', at: 1, agentId: 'tab-1' }
    ])
    expect(sessionEvents).toEqual([])
  })

  it('同一个错误只留一条；执行错误带 event', async () => {
    const { pi, host } = setup()
    await host.init()

    const load = { kind: 'load', path: '/ext/x.js', message: 'boom', at: 1 }
    pi.emit({ type: 'extension_error', agentId: 'tab-1', data: load })
    pi.emit({ type: 'extension_error', agentId: 'tab-1', data: { ...load, at: 2 } })
    expect(host.snapshot().extensionErrors).toHaveLength(1)
    expect(host.snapshot().extensionErrors[0].at).toBe(2)

    pi.emit({
      type: 'extension_error',
      agentId: 'tab-1',
      data: { kind: 'runtime', path: '/ext/x.js', event: 'command', message: 'bad', at: 3 }
    })
    expect(host.snapshot().extensionErrors).toHaveLength(2)
    expect(host.snapshot().extensionErrors[1]).toMatchObject({ kind: 'runtime', event: 'command' })
  })

  it('清除后为空', async () => {
    const { pi, host } = setup()
    await host.init()
    pi.emit({
      type: 'extension_error',
      agentId: 'tab-1',
      data: { kind: 'load', path: '/ext/x.js', message: 'boom', at: 1 }
    })
    host.dismissExtensionErrors()
    expect(host.snapshot().extensionErrors).toEqual([])
  })
})
