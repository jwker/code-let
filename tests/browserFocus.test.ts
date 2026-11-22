import { describe, expect, it } from 'vitest'
import type { BrowserAgentActivity, BrowserEvent, BrowserState } from '@contract/index'
import { createBrowserFocusController } from '../host/renderer/src/shell/browserFocus'

function activity(tool: string): BrowserAgentActivity {
  return { tool, label: tool, at: 1 }
}

function state(agent: BrowserAgentActivity | null, host = 'project'): BrowserEvent {
  const value: BrowserState = { host, tabs: [], activeTabId: null, agent }
  return { host, state: value }
}

/** 记下被通知的宿主 —— 调用方靠它判断要不要打开右栏 */
function track(): { focused: string[]; onFocus: (host: string) => void } {
  const focused: string[] = []
  return { focused, onFocus: (host) => focused.push(host) }
}

describe('agent 操作浏览器时打开右栏的浏览器功能区', () => {
  it('项目级宿主来了新活动 → 通知一次，带的是 project', () => {
    const { focused, onFocus } = track()
    createBrowserFocusController(onFocus).handle(state(activity('browser_click')))
    expect(focused).toEqual(['project'])
  })

  it('agent 宿主来了新活动 → 也通知，带的是那个 agent 的宿主', () => {
    const { focused, onFocus } = track()
    createBrowserFocusController(onFocus).handle(state(activity('browser_open'), 'agent:a1'))
    expect(focused).toEqual(['agent:a1'])
  })

  it('同一份活动记录被重复推 → 不重复触发', () => {
    const { focused, onFocus } = track()
    const controller = createBrowserFocusController(onFocus)
    const same = activity('browser_click')
    controller.handle(state(same))
    controller.handle(state(same))
    expect(focused).toHaveLength(1)
  })

  it('又换了一份新的活动记录 → 再通知一次', () => {
    const { focused, onFocus } = track()
    const controller = createBrowserFocusController(onFocus)
    controller.handle(state(activity('browser_click')))
    controller.handle(state(activity('browser_type')))
    expect(focused).toHaveLength(2)
  })

  it('没有活动记录（用户自己在面板里点）→ 不通知', () => {
    const { focused, onFocus } = track()
    createBrowserFocusController(onFocus).handle(state(null))
    expect(focused).toHaveLength(0)
  })

  it('活动记录过期后被清空、再出现新的 → 照样通知', () => {
    const { focused, onFocus } = track()
    const controller = createBrowserFocusController(onFocus)
    controller.handle(state(activity('browser_click')))
    controller.handle(state(null))
    controller.handle(state(activity('browser_click')))
    expect(focused).toHaveLength(2)
  })
})
