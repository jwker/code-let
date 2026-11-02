import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'
import { applyEvent, entriesToItems } from '@contract/stream'
import { summarizeTurn } from '../host/renderer/src/conversation/turnMeta'

/**
 * 中止正在跑的一轮。
 *
 * 三件事要管住：
 *   - 宿主：中止期间快照里能看到 `aborting`（界面靠它显示「停止中」），结束就消失
 *   - 宿主：连点两下只调一次 `abortTab`
 *   - 渲染：`stopReason === "aborted"` 的消息要一路传到「已中止」标记上
 */

class FakePi implements PiRuntimePort {
  private tabs = new Map<string, { streaming: boolean }>()
  readonly calls: string[] = []
  /** 让 abortTab 挂住，好观察「中止进行中」的快照 */
  holdAbort: Promise<void> | null = null

  onEvent(): () => void {
    return () => {}
  }

  async openTab(tabId: string): Promise<void> {
    this.tabs.set(tabId, { streaming: false })
  }

  async closeTab(tabId: string): Promise<void> {
    this.tabs.delete(tabId)
  }

  async activateTab(): Promise<void> {}
  async reloadTab(): Promise<void> {}

  tabState(tabId: string): TabRuntimeState {
    const tab = this.tabs.get(tabId)
    return {
      ready: Boolean(tab),
      sessionId: tab ? `s-${tabId}` : null,
      sessionFile: null,
      streaming: tab?.streaming ?? false,
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

  async abortTab(tabId: string): Promise<void> {
    this.calls.push(`abort:${tabId}`)
    if (this.holdAbort) await this.holdAbort
    const tab = this.tabs.get(tabId)
    if (tab) tab.streaming = false
  }

  async stop(): Promise<void> {}

  /** 测试用：设置某个标签是否在跑 */
  setStreaming(tabId: string, streaming: boolean): void {
    const tab = this.tabs.get(tabId)
    if (tab) tab.streaming = streaming
  }
}

function makeState(pi: FakePi): { state: HostState; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-abort-'))
  const state = new HostState({
    pi,
    tabStore: new TabStore(dir),
    projects: new ProjectStore(dir),
    pickDirectory: async () => null
  })
  return { state, dir }
}

describe('中止某个标签', () => {
  it('中止期间快照里有 aborting，结束后消失', async () => {
    const pi = new FakePi()
    const { state, dir } = makeState(pi)
    try {
      await state.init()
      await state.newConversation(dir)
      const tabId = state.snapshot().activeTabId!
      pi.setStreaming(tabId, true)

      // 让 abortTab 挂住，好在「进行中」这个时刻看快照
      let release!: () => void
      pi.holdAbort = new Promise<void>((r) => {
        release = r
      })

      const done = state.abortPrompt(tabId)
      // 让 abortPrompt 跑到 await 之前
      await Promise.resolve()

      expect(state.snapshot().aborting).toContain(tabId)

      release()
      await done

      expect(state.snapshot().aborting).not.toContain(tabId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('连点两次只调一次 abortTab', async () => {
    const pi = new FakePi()
    const { state, dir } = makeState(pi)
    try {
      await state.init()
      await state.newConversation(dir)
      const tabId = state.snapshot().activeTabId!
      pi.setStreaming(tabId, true)

      let release!: () => void
      pi.holdAbort = new Promise<void>((r) => {
        release = r
      })

      const first = state.abortPrompt(tabId)
      await Promise.resolve()
      // 第二次直接返回 —— 已经在停了
      await state.abortPrompt(tabId)

      release()
      await first

      expect(pi.calls.filter((c) => c === `abort:${tabId}`)).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('没在跑的标签不发中止', async () => {
    const pi = new FakePi()
    const { state, dir } = makeState(pi)
    try {
      await state.init()
      await state.newConversation(dir)
      const tabId = state.snapshot().activeTabId!

      await state.abortPrompt(tabId)

      // runtime 自己判断 isStreaming，宿主照样转达 —— 但快照要干净
      expect(state.snapshot().aborting).not.toContain(tabId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('abortTab 抛错也要把 aborting 清掉', async () => {
    const pi = new FakePi()
    const { state, dir } = makeState(pi)
    try {
      await state.init()
      await state.newConversation(dir)
      const tabId = state.snapshot().activeTabId!
      pi.setStreaming(tabId, true)
      pi.abortTab = async () => {
        throw new Error('停止失败')
      }

      await expect(state.abortPrompt(tabId)).rejects.toThrow('停止失败')
      // 不清掉的话按钮会永远停在「停止中」
      expect(state.snapshot().aborting).not.toContain(tabId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('中止标记从消息里推', () => {
  it('历史：stopReason 是 aborted 的助手消息带 aborted', () => {
    const items = entriesToItems([
      { type: 'message', message: { role: 'user', content: '写个测试' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我先改 files.test.ts，然后' }],
          stopReason: 'aborted'
        }
      }
    ])
    const answer = items.filter((i) => i.kind === 'message' && i.role === 'assistant')[0]
    expect(answer.kind === 'message' && answer.aborted).toBe(true)
  })

  it('历史：正常结束的不带 aborted', () => {
    const items = entriesToItems([
      { type: 'message', message: { role: 'user', content: '写个测试' } },
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '好了' }],
          stopReason: 'stop'
        }
      }
    ])
    const answer = items.filter((i) => i.kind === 'message' && i.role === 'assistant')[0]
    expect(answer.kind === 'message' && answer.aborted).toBeUndefined()
  })

  it('实时流：message_end 里带 aborted', () => {
    let items: StreamItem[] = applyEvent([], {
      type: 'message_start',
      data: { message: { role: 'assistant', content: [] } }
    })
    items = applyEvent(items, {
      type: 'message_update',
      data: { type: 'text_delta', contentIndex: 0, delta: '我先改测试' }
    })
    items = applyEvent(items, {
      type: 'message_end',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '我先改测试' }],
          stopReason: 'aborted'
        }
      }
    })
    expect(items[0].kind === 'message' && items[0].aborted).toBe(true)
  })

  it('轮聚合：整轮扫一遍，答案项没带也能推出来', () => {
    // 一条助手消息拆成「正文 → 工具 → 正文」时，标记挂在第一项上
    const body: StreamItem[] = [
      { kind: 'message', role: 'assistant', text: '先看看现状', aborted: true },
      { kind: 'tool', callId: 't1', name: 'bash', status: 'ok' },
      { kind: 'message', role: 'assistant', text: '我把断言补上' }
    ]
    const summary = summarizeTurn(body)
    expect(summary?.aborted).toBe(true)
    expect(summary?.answer).toBe('我把断言补上')
  })

  it('轮聚合：正常结束的轮不是 aborted', () => {
    const body: StreamItem[] = [{ kind: 'message', role: 'assistant', text: '好了' }]
    expect(summarizeTurn(body)?.aborted).toBe(false)
  })
})
