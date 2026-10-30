import { describe, expect, it } from 'vitest'
import { createTabCloseController, runningTabCloseCopy } from '../host/renderer/src/shell/tabClose'
import type { TabInfo } from '@contract/index'

/**
 * 关掉正在跑的标签（渲染进程这一侧）。
 *
 * 宿主和运行时那两半在 `tests/tabClose.test.ts` 里：
 * 标签从列表里去掉、那一轮先 abort 再 dispose。
 *
 * 这里管的是**用户在界面上点那一下会发生什么**：
 * 正在跑的标签不能直接关 —— 先弹确认框；确认了才关；取消了就当没点过。
 */

/** 造一个标签 */
function makeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: 'tab-1',
    sessionId: 's-1',
    path: '/tmp/s-1.jsonl',
    cwd: '/tmp/demo',
    title: '改一下登录页',
    projectName: 'demo',
    streaming: false,
    ready: true,
    model: null,
    modelFallback: null,
    error: null,
    ...overrides
  }
}

describe('渲染进程：关掉正在跑的标签', () => {
  it('正在跑 → 先弹确认框，不关', async () => {
    const closed: string[] = []
    const controller = createTabCloseController({
      getTab: () => makeTab({ streaming: true }),
      closeTab: async (tabId) => {
        closed.push(tabId)
      }
    })

    await controller.requestClose()

    expect(controller.getState().asking).toBe(true)
    expect(controller.getState().closed).toBe(false)
    // 还没关 —— 那一轮还在跑
    expect(closed).toEqual([])
  })

  it('确认 → 关掉标签', async () => {
    const closed: string[] = []
    const controller = createTabCloseController({
      getTab: () => makeTab({ streaming: true }),
      closeTab: async (tabId) => {
        closed.push(tabId)
      }
    })

    await controller.requestClose()
    await controller.confirm()

    expect(closed).toEqual(['tab-1'])
    expect(controller.getState().asking).toBe(false)
    expect(controller.getState().closed).toBe(true)
  })

  it('取消 → 不关，标签还在', async () => {
    const closed: string[] = []
    const controller = createTabCloseController({
      getTab: () => makeTab({ streaming: true }),
      closeTab: async (tabId) => {
        closed.push(tabId)
      }
    })

    await controller.requestClose()
    const after = controller.cancel()

    expect(closed).toEqual([])
    expect(after.asking).toBe(false)
    expect(after.closed).toBe(false)
  })

  it('没在跑 → 直接关，不弹确认框', async () => {
    const closed: string[] = []
    const controller = createTabCloseController({
      getTab: () => makeTab({ streaming: false }),
      closeTab: async (tabId) => {
        closed.push(tabId)
      }
    })

    await controller.requestClose()

    expect(closed).toEqual(['tab-1'])
    expect(controller.getState().asking).toBe(false)
    expect(controller.getState().closed).toBe(true)
  })

  it('那一轮跑完之后 → 不再问，直接关', async () => {
    // 标签的 streaming 是会变的：确认框亮着的时候那一轮可能正好跑完
    let streaming = true
    const closed: string[] = []
    const controller = createTabCloseController({
      getTab: () => makeTab({ streaming }),
      closeTab: async (tabId) => {
        closed.push(tabId)
      }
    })

    await controller.requestClose()
    expect(controller.getState().asking).toBe(true)

    streaming = false
    controller.cancel()
    await controller.requestClose()

    expect(closed).toEqual(['tab-1'])
    expect(controller.getState().asking).toBe(false)
  })

  it('状态没变就不通知订阅者', async () => {
    const controller = createTabCloseController({
      getTab: () => makeTab({ streaming: true }),
      closeTab: async () => {}
    })
    let notified = 0
    const off = controller.subscribe(() => {
      notified += 1
    })

    await controller.requestClose()
    expect(notified).toBe(1)

    // 已经在问了，再点一次「×」没有新状态
    await controller.requestClose()
    expect(notified).toBe(1)

    off()
    controller.cancel()
    expect(notified).toBe(1)
  })
})

describe('渲染进程：确认框的文案', () => {
  it('说清会中止这一轮，也说清已生成的内容还在', () => {
    const copy = runningTabCloseCopy(makeTab({ title: '改一下登录页' }))

    expect(copy.title).toContain('还在生成')
    expect(copy.body).toContain('改一下登录页')
    expect(copy.body).toContain('中止')
    expect(copy.body).toContain('会话文件')
    expect(copy.confirmText).toBe('中止并关闭')
    expect(copy.cancelText).toBe('取消')
  })
})
