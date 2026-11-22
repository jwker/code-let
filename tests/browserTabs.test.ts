import { describe, expect, it } from 'vitest'
import {
  BrowserTabs,
  PROJECT_BROWSER,
  agentBrowserHost,
  isBrowserHost,
  type BrowserHost
} from '../host/main/browserTabs'

/**
 * 浏览器的宿主隔离（ADR-0005）。
 *
 * 项目级和 agent 预览共用一张标签表，隔离靠「查标签必须带宿主」。这条是**安全边界**：
 * agent 的 `browser_*` 工具只能碰自己的宿主，拿别人的标签必须失败。
 *
 * 标签表的记账逻辑是纯的（不 import electron），所以能在 node 里直接测。
 */

interface Tab {
  id: string
  host: BrowserHost
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

describe('合并成一份标签表', () => {
  const table = () => new BrowserTabs<Tab>()
  const tab = (id: string, host: BrowserHost): Tab => ({ id, host })
  const project = PROJECT_BROWSER
  const agentA = agentBrowserHost('a1')

  it('两个宿主的标签在同一张表里，按宿主取拿不到别人的', () => {
    const t = table()
    t.add(tab('b1', project))
    t.add(tab('b2', agentA))

    expect(t.allTabs().map((item) => item.id).sort()).toEqual(['b1', 'b2'])
    expect(t.list(project).map((item) => item.id)).toEqual(['b1'])
    expect(t.list(agentA).map((item) => item.id)).toEqual(['b2'])
    expect(t.list(agentBrowserHost('a2'))).toEqual([])
    expect(t.find(project, 'b2')).toBeNull()
    expect(t.find(agentA, 'b1')).toBeNull()
  })

  it('切宿主再切回来，各宿主的活动标签各记一份', () => {
    const t = table()
    t.add(tab('p1', project))
    t.add(tab('p2', project))
    t.add(tab('a1', agentA))
    t.add(tab('a2', agentA))

    // 两个宿主各选一个
    t.setActive(project, 'p1')
    t.setActive(agentA, 'a1')
    expect(t.active(project)?.id).toBe('p1')
    expect(t.active(agentA)?.id).toBe('a1')

    // 宿主之间来回切，活动标签不互相覆盖
    expect(t.active(agentA)?.id).toBe('a1')
    expect(t.active(project)?.id).toBe('p1')
  })

  it('跨宿主切活动被拒绝，两个宿主都不变', () => {
    const t = table()
    t.add(tab('b1', project))
    t.add(tab('b2', agentA))

    expect(t.setActive(project, 'b2')).toBe(false)
    expect(t.setActive(agentA, 'b1')).toBe(false)
    expect(t.active(project)?.id).toBe('b1')
    expect(t.active(agentA)?.id).toBe('b2')
  })

  it('关掉一个宿主的标签，不影响另一个宿主的标签和活动', () => {
    const t = table()
    t.add(tab('p1', project))
    t.add(tab('p2', project))
    t.add(tab('a1', agentA))
    t.setActive(project, 'p1')

    t.remove(project, 'p2')

    expect(t.list(project).map((item) => item.id)).toEqual(['p1'])
    expect(t.active(project)?.id).toBe('p1')
    expect(t.list(agentA).map((item) => item.id)).toEqual(['a1'])
    expect(t.active(agentA)?.id).toBe('a1')
  })

  it('新加的标签自动成为它那个宿主的活动标签', () => {
    const t = table()
    t.add(tab('p1', project))
    t.add(tab('p2', project))
    expect(t.activeTabId(project)).toBe('p2')
  })

  it('关掉活动标签之后落到同宿主相邻的一个，不是跳回第一个', () => {
    const t = table()
    t.add(tab('b1', project))
    t.add(tab('b2', project))
    t.add(tab('b3', project))
    t.setActive(project, 'b2')

    const removed = t.remove(project, 'b2')
    expect(removed?.tab.id).toBe('b2')
    expect(removed?.nextActive?.id).toBe('b3')
    expect(t.activeTabId(project)).toBe('b3')
  })

  it('关掉最后一个 → 活动清空，宿主本身还在表里（下次还能加）', () => {
    const t = table()
    t.add(tab('b1', agentA))
    t.remove(agentA, 'b1')
    expect(t.activeTabId(agentA)).toBeNull()
    expect(t.list(agentA)).toEqual([])
    expect(t.hosts()).toEqual([])
  })

  it('删一个不存在的标签返回 null，不动活动', () => {
    const t = table()
    t.add(tab('b1', project))
    expect(t.remove(project, '没有这个')).toBeNull()
    expect(t.remove(agentA, 'b1')).toBeNull()
    expect(t.activeTabId(project)).toBe('b1')
  })
})
