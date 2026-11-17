import { describe, expect, it } from 'vitest'
import {
  BrowserPools,
  PROJECT_BROWSER,
  agentBrowserHost,
  isBrowserHost
} from '../host/main/browserPools'

/**
 * 浏览器的宿主隔离（PLAN.md D57）。
 *
 * 这条是**安全边界**，不是整洁问题：agent 的 `browser_*` 工具只能碰自己的宿主。
 * 共用一个池的话，agent 点一下就把用户正在看的那一页换掉了。
 *
 * 池的记账逻辑是纯的（不 import electron），所以能在 node 里直接测。
 */

interface Tab {
  id: string
}

describe('宿主键', () => {
  it('只认 project 和 agent:<id>', () => {
    expect(isBrowserHost('project')).toBe(true)
    expect(isBrowserHost('agent:a1')).toBe(true)
    expect(isBrowserHost('agent:')).toBe(false)
    expect(isBrowserHost('project ')).toBe(false)
    expect(isBrowserHost('agent')).toBe(false)
    expect(isBrowserHost(undefined)).toBe(false)
    expect(isBrowserHost(1)).toBe(false)
  })

  it('agent 宿主带上 agent id', () => {
    expect(agentBrowserHost('a1')).toBe('agent:a1')
  })
})

describe('标签池按宿主分开', () => {
  const pools = () => new BrowserPools<Tab>()

  it('两个宿主的标签互不可见', () => {
    const p = pools()
    p.add(PROJECT_BROWSER, { id: 'b1' })
    p.add(agentBrowserHost('a1'), { id: 'b2' })

    expect(p.list(PROJECT_BROWSER).map((tab) => tab.id)).toEqual(['b1'])
    expect(p.list(agentBrowserHost('a1')).map((tab) => tab.id)).toEqual(['b2'])
    expect(p.list(agentBrowserHost('a2'))).toEqual([])
  })

  it('跨宿主找一个标签找不到 —— 这就是隔离', () => {
    const p = pools()
    p.add(agentBrowserHost('a1'), { id: 'b2' })
    expect(p.find(PROJECT_BROWSER, 'b2')).toBeNull()
    expect(p.find(agentBrowserHost('a2'), 'b2')).toBeNull()
    expect(p.find(agentBrowserHost('a1'), 'b2')).not.toBeNull()
  })

  it('跨宿主切活动标签被拒绝，不报错也不生效', () => {
    const p = pools()
    p.add(PROJECT_BROWSER, { id: 'b1' })
    p.add(agentBrowserHost('a1'), { id: 'b2' })

    expect(p.setActive(PROJECT_BROWSER, 'b2')).toBe(false)
    expect(p.activeTabId(PROJECT_BROWSER)).toBe('b1')
    // 自己的宿主里可以切
    expect(p.setActive(agentBrowserHost('a1'), 'b2')).toBe(true)
    expect(p.activeTabId(agentBrowserHost('a1'))).toBe('b2')
  })

  it('新加的标签自动成为活动', () => {
    const p = pools()
    p.add(PROJECT_BROWSER, { id: 'b1' })
    p.add(PROJECT_BROWSER, { id: 'b2' })
    expect(p.activeTabId(PROJECT_BROWSER)).toBe('b2')
  })

  it('关掉活动标签之后落到相邻的一个，不是跳回第一个', () => {
    const p = pools()
    p.add(PROJECT_BROWSER, { id: 'b1' })
    p.add(PROJECT_BROWSER, { id: 'b2' })
    p.add(PROJECT_BROWSER, { id: 'b3' })
    p.setActive(PROJECT_BROWSER, 'b2')

    const removed = p.remove(PROJECT_BROWSER, 'b2')
    expect(removed?.tab.id).toBe('b2')
    expect(removed?.nextActive?.id).toBe('b3')
    expect(p.activeTabId(PROJECT_BROWSER)).toBe('b3')
  })

  it('关掉最后一个 → 活动清空，池还在', () => {
    const p = pools()
    p.add(PROJECT_BROWSER, { id: 'b1' })
    p.remove(PROJECT_BROWSER, 'b1')
    expect(p.activeTabId(PROJECT_BROWSER)).toBeNull()
    expect(p.list(PROJECT_BROWSER)).toEqual([])
  })

  it('删一个不存在的标签返回 null，不动活动', () => {
    const p = pools()
    p.add(PROJECT_BROWSER, { id: 'b1' })
    expect(p.remove(PROJECT_BROWSER, '没有这个')).toBeNull()
    expect(p.activeTabId(PROJECT_BROWSER)).toBe('b1')
  })

  it('全量遍历能拿到所有宿主的标签 —— 收摊时要用', () => {
    const p = pools()
    p.add(PROJECT_BROWSER, { id: 'b1' })
    p.add(agentBrowserHost('a1'), { id: 'b2' })
    expect(p.allTabs().map((entry) => `${entry.host}:${entry.tab.id}`).sort()).toEqual([
      'agent:a1:b2',
      'project:b1'
    ])
  })
})
