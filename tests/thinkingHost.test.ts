import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEvent, PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type {
  CommandArgumentOption,
  CommandOption,
  ModelOption,
  StreamItem,
  ThinkingLevel
} from '@contract/index'

/**
 * 思考等级与命令参数补全的宿主转发（D31）。
 *
 * 宿主只做两件事：把渲染进程的请求交给 runtime，把 runtime 的事实抄进快照。
 * 参数候选来自扩展的 `getArgumentCompletions`，可用等级来自当前模型。
 */

class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  private tabs = new Map<string, ThinkingLevel>()
  /** `selectThinkingLevel` 的调用记录 */
  readonly sets: { tabId: string; level: ThinkingLevel }[] = []
  /** 参数补全的调用记录 */
  readonly completions: { tabId: string; name: string; prefix: string }[] = []

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async openTab(tabId: string): Promise<void> {
    this.tabs.set(tabId, 'medium')
  }
  async closeTab(tabId: string): Promise<void> {
    this.tabs.delete(tabId)
  }
  async activateTab(): Promise<void> {}
  async reloadTab(): Promise<void> {}
  tabState(tabId: string): TabRuntimeState {
    return {
      ready: this.tabs.has(tabId),
      sessionId: this.tabs.has(tabId) ? `s-${tabId}` : null,
      sessionFile: null,
      streaming: false,
      model: null,
      thinkingLevel: this.tabs.get(tabId) ?? null,
      modelFallback: null
    }
  }
  readEntries(): StreamItem[] {
    return []
  }
  async listModels(): Promise<ModelOption[]> {
    return []
  }
  async selectModel(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async listCommands(): Promise<CommandOption[]> {
    return []
  }
  async completeCommand(
    tabId: string,
    name: string,
    prefix: string
  ): Promise<CommandArgumentOption[]> {
    this.completions.push({ tabId, name, prefix })
    return ['staging', 'production']
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value }))
  }
  thinkingLevels(tabId: string): ThinkingLevel[] {
    return this.tabs.has(tabId) ? ['off', 'low', 'medium', 'high'] : []
  }
  setThinkingLevel(tabId: string, level: ThinkingLevel): void {
    this.sets.push({ tabId, level })
    this.tabs.set(tabId, level)
  }
  async compactTab(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abortTab(): Promise<void> {}
  async stop(): Promise<void> {}

  emit(event: PiEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

const dirs: string[] = []
let state: HostState | null = null

afterEach(async () => {
  await state?.dispose()
  state = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(): { pi: FakePi; host: HostState; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'codelet-thinking-'))
  dirs.push(root)
  const cwd = join(root, 'project')
  const projects = new ProjectStore(join(root, 'projects.json'))
  projects.add(cwd)
  const pi = new FakePi()
  state = new HostState({
    pi,
    projects,
    tabStore: new TabStore(join(root, 'tabs.json')),
    trashFile: async () => {}
  })
  return { pi, host: state, cwd }
}

describe('思考等级', () => {
  it('列表透传 runtime；设置后写回快照', async () => {
    const { pi, host, cwd } = setup()
    await host.init()
    await host.newConversation(cwd)
    const tabId = host.snapshot().activeTabId
    if (!tabId) throw new Error('没有活动标签')

    expect(host.snapshot().session.thinkingLevel).toBe('medium')
    expect(await host.listThinkingLevels(tabId)).toEqual(['off', 'low', 'medium', 'high'])

    await host.selectThinkingLevel(tabId, 'high')
    expect(pi.sets).toEqual([{ tabId, level: 'high' }])
    expect(host.snapshot().session.thinkingLevel).toBe('high')

    await expect(host.selectThinkingLevel(tabId, 'max')).rejects.toThrow('不支持')
    expect(pi.sets).toEqual([{ tabId, level: 'high' }])
  })

  it('没有 runtime 时列表为空，不抛错', async () => {
    const { host } = setup()
    await host.init()
    expect(await host.listThinkingLevels('missing')).toEqual([])
  })
})

describe('命令参数补全', () => {
  it('前缀原样转发给扩展，候选原样返回', async () => {
    const { pi, host, cwd } = setup()
    await host.init()
    await host.newConversation(cwd)
    const tabId = host.snapshot().activeTabId
    if (!tabId) throw new Error('没有活动标签')

    expect(await host.completeCommand(tabId, 'deploy', 'st')).toEqual([
      { value: 'staging', label: 'staging' }
    ])
    expect(pi.completions).toEqual([{ tabId, name: 'deploy', prefix: 'st' }])
  })
})
