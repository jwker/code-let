import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 会话在**别处**被改过（比如在裸 pi 的 TUI 里聊了几句）。
 *
 * Pi 的 `SessionManager.open()` 只在构造时把文件读进内存，之后不再重读 ——
 * 所以别的进程写了，这个标签的内容流不知道。标出来让用户自己决定要不要重载，
 * **不自动同步**：重建 runtime 会丢掉当前状态，而且如果别处还在写，重建完很快又落后。
 *
 * 关键：**我们自己写文件不能把自己标成「有外部更新」**。
 */
const AGENT_DIR = mkdtempSync(join(tmpdir(), 'codelet-stale-agent-'))
process.env.PI_CODING_AGENT_DIR = AGENT_DIR

class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  private files = new Map<string, string | null>()
  private active: string | null = null

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** 假装 Pi 发了个事件 —— 测「自己写完之后不该被标 stale」 */
  emit(type: string, tabId: string): void {
    for (const listener of this.listeners) listener({ type, data: {}, tabId })
  }
  async openTab(tabId: string, options: { cwd: string; path?: string }): Promise<void> {
    this.files.set(tabId, options.path ?? join(tmpdir(), `fake-${tabId}.jsonl`))
  }
  async closeTab(tabId: string): Promise<void> {
    this.files.delete(tabId)
  }
  async activateTab(tabId: string): Promise<void> {
    this.active = tabId
  }
  async reloadTab(): Promise<void> {}
  tabState(tabId: string): TabRuntimeState {
    return {
      ready: this.active === tabId,
      sessionId: `s-${tabId}`,
      sessionFile: this.files.get(tabId) ?? null,
      streaming: false,
      model: null,
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
  async prompt(): Promise<void> {}
  async stop(): Promise<void> {}
}

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-stale-'))
  const sessionFile = join(dir, 'session.jsonl')
  writeFileSync(sessionFile, '')
  const projects = new ProjectStore(join(dir, 'projects.json'))
  projects.add(dir)
  const tabFile = join(dir, 'tabs.json')
  new TabStore(tabFile).saveTabs([{ id: 'tab-1', cwd: dir, path: sessionFile, title: '聊过的' }])

  const pi = new FakePi()
  const state = new HostState({ pi, tabStore: new TabStore(tabFile), projects })
  await state.init()
  return { dir, sessionFile, pi, state }
}

/** 把文件时间往后推，模拟「别处刚写过」 */
function touchFuture(file: string, ms = 60_000): void {
  const t = new Date(Date.now() + ms)
  utimesSync(file, t, t)
}

describe('会话在别处被改过', () => {
  it('刚打开时不是 stale', async () => {
    const { dir, state } = await setup()
    expect(state.snapshot().tabs[0].stale).toBe(false)
    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件在别处被改过 → 标记 stale', async () => {
    const { dir, sessionFile, state } = await setup()
    touchFuture(sessionFile)
    await state.refreshConversations()
    expect(state.snapshot().tabs[0].stale).toBe(true)
    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('★ 自己写完（agent_settled）不算外部更新', async () => {
    const { dir, sessionFile, pi, state } = await setup()
    // 模拟「我们这一轮写了文件」
    touchFuture(sessionFile)
    pi.emit('agent_settled', 'tab-1')
    await state.refreshConversations()
    expect(state.snapshot().tabs[0].stale).toBe(false)
    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('重新加载之后 stale 清掉', async () => {
    const { dir, sessionFile, state } = await setup()
    touchFuture(sessionFile)
    await state.refreshConversations()
    expect(state.snapshot().tabs[0].stale).toBe(true)

    await state.reloadTab('tab-1')
    expect(state.snapshot().tabs[0].stale).toBe(false)
    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
