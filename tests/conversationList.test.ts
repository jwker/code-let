import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { HostState } from '../host/main/state'
import { TabStore } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { HostSnapshot, ModelOption, StreamItem } from '@contract/index'

/**
 * 复现「新会话聊完了也不在左侧列表里，切一下别的会话才冒出来」这个 bug（PLAN.md D19）。
 *
 * 用真 SDK 落盘，假运行时只管发事件 ——
 * 这个 bug 的要害全在时序上：
 *   - Pi 是**先发事件、后写盘**（message_end 事件抛出来时消息还没进会话文件）
 *   - 新会话的 .jsonl 要等**第一条用户消息**才建（没说过话的会话不建文件）
 * 所以「看到用户消息事件就立刻读盘」读到的还是旧列表。
 */
const AGENT_DIR = mkdtempSync(join(tmpdir(), 'codelet-state-agent-'))
const CWD = mkdtempSync(join(tmpdir(), 'codelet-state-cwd-'))
process.env.PI_CODING_AGENT_DIR = AGENT_DIR

/** 假运行时：真 SDK 负责落盘，它只管按真 SDK 的次序发事件 */
class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  private managers = new Map<string, SessionManager>()
  private streaming = new Set<string>()

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(tabId: string, type: string, data: unknown): void {
    for (const listener of this.listeners) listener({ type, data, tabId })
  }

  async openTab(tabId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void> {
    this.managers.set(tabId, options.path ? SessionManager.open(options.path) : SessionManager.create(options.cwd))
  }

  async closeTab(tabId: string): Promise<void> {
    this.managers.delete(tabId)
    this.streaming.delete(tabId)
  }

  async activateTab(): Promise<void> {
    // 不参与
  }

  tabState(tabId: string): TabRuntimeState {
    const manager = this.managers.get(tabId)
    return {
      ready: Boolean(manager),
      sessionId: manager?.getSessionId() ?? null,
      streaming: this.streaming.has(tabId),
      model: null,
      modelFallback: null
    }
  }

  /**
   * 照真 SDK 的次序来：**先发事件、后写盘**。
   * 这正是当初漏掉刷新触发的原因。
   */
  async prompt(tabId: string, text: string): Promise<void> {
    const message = { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() }
    this.emit(tabId, 'message_start', { message })
    this.emit(tabId, 'message_end', { message })
    this.managers.get(tabId)?.appendMessage(message)
  }

  readEntries(): StreamItem[] {
    return []
  }

  // 模型在这份测试里不参与（只盯对话列表的刷新时机）
  async listModels(): Promise<ModelOption[]> {
    return []
  }

  async selectModel(): Promise<void> {
    // 不参与
  }

  async stop(): Promise<void> {
    this.listeners.clear()
  }
}

describe('宿主状态：新会话要自己出现在对话列表里', () => {
  it('发完第一条消息后，新会话就进列表 —— 不用切别的会话才冒出来', async () => {
    const tabStore = new TabStore(join(AGENT_DIR, 'tabs.json'))
    const pi = new FakePi()
    const state = new HostState({ pi, tabStore })

    const snapshots: string[][] = []
    state.on('snapshot', (snapshot: HostSnapshot) => {
      snapshots.push(snapshot.conversations.map((c) => c.title))
    })

    await state.init()
    // 起项目时会读一次列表 —— 这会儿还没有任何会话
    expect(state.snapshot().conversations).toHaveLength(0)

    // 在这个目录里新建会话 → 开成新标签
    await state.newConversation(CWD)
    const tab = state.snapshot().tabs[0]
    expect(tab).toBeTruthy()
    // 空会话不落盘（SDK 的规矩），所以列表里还没有它
    expect(state.snapshot().conversations).toHaveLength(0)

    // 说第一句话 —— 文件这时才落盘
    await pi.prompt(tab.id, '你好，这是新会话的第一条消息')

    // 事件先于写盘发出，所以刷新得等一拍（去抖窗口）
    await new Promise((resolve) => setTimeout(resolve, 250))

    const conversations = state.snapshot().conversations
    expect(conversations).toHaveLength(1)
    expect(conversations[0].id).toBe(tab.sessionId)
    // 标题取首条用户消息
    expect(conversations[0].title).toBe('你好，这是新会话的第一条消息')

    // 快照也确实推下去了 —— 渲染进程靠它更新列表
    expect(snapshots.at(-1)).toEqual(['你好，这是新会话的第一条消息'])

    await state.dispose()
    rmSync(AGENT_DIR, { recursive: true, force: true })
    rmSync(CWD, { recursive: true, force: true })
  })
})
