import { describe, expect, it } from 'vitest'
import type { BrowserAgentActivity, BrowserState } from '@contract/index'
import { createBrowserFocusController } from '../host/renderer/src/shell/browserFocus'

function activity(tool: string): BrowserAgentActivity {
  return { tool, label: tool, at: 1 }
}

function state(agent: BrowserAgentActivity | null): BrowserState {
  return { tabs: [], activeTabId: null, agent }
}

describe('agent 操作浏览器时把右侧面板切到浏览器', () => {
  it('来了一份新的活动记录 → 切过去', () => {
    let focused = 0
    const controller = createBrowserFocusController(() => {
      focused += 1
    })
    controller.handle(state(activity('browser_click')))
    expect(focused).toBe(1)
  })

  it('同一份活动记录被重复推 → 不切', () => {
    let focused = 0
    const controller = createBrowserFocusController(() => {
      focused += 1
    })
    const same = activity('browser_click')
    controller.handle(state(same))
    controller.handle(state(same))
    expect(focused).toBe(1)
  })

  it('又换了一份新的活动记录 → 再切一次', () => {
    let focused = 0
    const controller = createBrowserFocusController(() => {
      focused += 1
    })
    controller.handle(state(activity('browser_click')))
    controller.handle(state(activity('browser_type')))
    expect(focused).toBe(2)
  })

  it('没有活动记录（用户自己在面板里点）→ 不切', () => {
    let focused = 0
    const controller = createBrowserFocusController(() => {
      focused += 1
    })
    controller.handle(state(null))
    expect(focused).toBe(0)
  })
})
