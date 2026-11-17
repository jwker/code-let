/**
 * 浏览器的「宿主」把标签池分开（PLAN.md D57）。
 *
 * 两种宿主：
 * - `project` —— 窄轨里那个浏览器入口，多标签、地址可输，属于项目；
 * - `agent:<id>` —— 某个 agent 自己的预览，单页、地址只读，属于那个 agent。
 *
 * **分开的理由是安全，不是整洁**：agent 的 `browser_*` 工具只能作用于自己的宿主。
 * 共用一个池的话，agent 点一下就把用户正在看的那一页换掉了 —— 那是越界，不是体验问题。
 *
 * 这个文件不 import electron：标签池的记账逻辑是纯的，可以在 node 里直接测。
 */

import type { BrowserHost } from '@contract/browser'

export type { BrowserHost }
export { PROJECT_BROWSER, agentBrowserHost, isBrowserHost } from '@contract/browser'

/** 池里的一条标签至少要有 id */
export interface PoolTab {
  id: string
}

interface Pool<T> {
  tabs: T[]
  activeTabId: string | null
}

/**
 * 按宿主分开的标签池。
 *
 * 所有方法都要求显式传 host —— 没有「默认宿主」，漏传就是编译错，
 * 而不是悄悄操作了别人的标签。
 */
export class BrowserPools<T extends PoolTab> {
  private readonly pools = new Map<BrowserHost, Pool<T>>()

  private pool(host: BrowserHost): Pool<T> {
    const found = this.pools.get(host)
    if (found) return found
    const created: Pool<T> = { tabs: [], activeTabId: null }
    this.pools.set(host, created)
    return created
  }

  list(host: BrowserHost): T[] {
    return this.pool(host).tabs
  }

  hosts(): BrowserHost[] {
    return [...this.pools.keys()]
  }

  activeTabId(host: BrowserHost): string | null {
    return this.pool(host).activeTabId
  }

  active(host: BrowserHost): T | null {
    const pool = this.pool(host)
    return pool.tabs.find((tab) => tab.id === pool.activeTabId) ?? null
  }

  find(host: BrowserHost, tabId: string): T | null {
    return this.pool(host).tabs.find((tab) => tab.id === tabId) ?? null
  }

  /** 加一条并设为活动 */
  add(host: BrowserHost, tab: T): void {
    const pool = this.pool(host)
    pool.tabs.push(tab)
    pool.activeTabId = tab.id
  }

  /**
   * 拿掉一条。
   *
   * 拿掉的如果是活动那条，活动落到**相邻**的一个（先看后面再看前面）——
   * 跟标签栏的直觉一致：关掉第三个，不该跳回第一个。
   * 池空了就把活动清掉；池本身留着（宿主还在，只是暂时没标签）。
   */
  remove(host: BrowserHost, tabId: string): { tab: T; nextActive: T | null } | null {
    const pool = this.pool(host)
    const index = pool.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return null
    const [tab] = pool.tabs.splice(index, 1)
    if (pool.activeTabId === tabId) {
      const next = pool.tabs[index] ?? pool.tabs[index - 1] ?? null
      pool.activeTabId = next?.id ?? null
      return { tab, nextActive: next }
    }
    return { tab, nextActive: this.active(host) }
  }

  /** 切活动标签；标签不属于这个宿主时返回 false，不跨池操作 */
  setActive(host: BrowserHost, tabId: string): boolean {
    const pool = this.pool(host)
    if (!pool.tabs.some((tab) => tab.id === tabId)) return false
    pool.activeTabId = tabId
    return true
  }

  /** 所有宿主的全部标签 —— 只给「收摊时统一关闭」用 */
  allTabs(): Array<{ host: BrowserHost; tab: T }> {
    return this.hosts().flatMap((host) => this.pool(host).tabs.map((tab) => ({ host, tab })))
  }

  clear(): void {
    this.pools.clear()
  }
}
