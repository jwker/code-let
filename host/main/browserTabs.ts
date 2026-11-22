/**
 * 浏览器的标签表（ADR-0005）。
 *
 * 项目级浏览器和每个 agent 的预览共用**一份**标签表，每条标签记着自己属于哪个宿主。
 * 同一时刻仍然只有一个宿主的标签可见，每个宿主各记一条「上次活动」——
 * 切宿主时换成那个宿主上次活动的标签，别的宿主的标签原地保留。
 *
 * 隔离从「物理上分成几个池」变成「查标签必须带宿主」：`find` / `list` / `setActive`
 * 都按宿主过滤，agent 的工具入口拿不到别人的标签。真正的兜底在工具入口 ——
 * 显式传了别的宿主的标签 id 时必须失败，不能退回自己的活动标签。
 *
 * 这个文件不 import electron：标签表的记账逻辑是纯的，可以在 node 里直接测。
 */

import type { BrowserHost } from '@contract/browser'

export type { BrowserHost }
export { PROJECT_BROWSER, agentBrowserHost, isAgentBrowserHost, isBrowserHost } from '@contract/browser'

/** 表里的一条标签至少要有 id 和宿主 */
export interface TabRecord {
  id: string
  host: BrowserHost
}

/**
 * 一张按宿主分组的标签表。
 *
 * 所有方法都要求显式传 host —— 没有「默认宿主」，漏传就是编译错，
 * 而不是悄悄操作了别人的标签。
 */
export class BrowserTabs<T extends TabRecord> {
  private readonly tabs: T[] = []
  /** 每个宿主上次活动的标签；切宿主再切回来就靠它 */
  private readonly activeByHost = new Map<BrowserHost, string | null>()

  list(host: BrowserHost): T[] {
    return this.tabs.filter((tab) => tab.host === host)
  }

  hosts(): BrowserHost[] {
    return [...new Set(this.tabs.map((tab) => tab.host))]
  }

  activeTabId(host: BrowserHost): string | null {
    return this.activeByHost.get(host) ?? null
  }

  active(host: BrowserHost): T | null {
    const id = this.activeTabId(host)
    return this.tabs.find((tab) => tab.host === host && tab.id === id) ?? null
  }

  find(host: BrowserHost, tabId: string): T | null {
    return this.tabs.find((tab) => tab.host === host && tab.id === tabId) ?? null
  }

  /** 加一条并设为它那个宿主的活动标签 */
  add(tab: T): void {
    this.tabs.push(tab)
    this.activeByHost.set(tab.host, tab.id)
  }

  /**
   * 拿掉一条。
   *
   * 拿掉的如果是活动那条，活动落到**同一个宿主里相邻**的一个（先看后面再看前面）——
   * 跟标签栏的直觉一致：关掉第三个，不该跳回第一个。
   */
  remove(host: BrowserHost, tabId: string): { tab: T; nextActive: T | null } | null {
    const own = this.list(host)
    const index = own.findIndex((tab) => tab.id === tabId)
    if (index < 0) return null
    const [tab] = own.splice(index, 1)
    const at = this.tabs.findIndex((item) => item.host === host && item.id === tabId)
    if (at >= 0) this.tabs.splice(at, 1)
    if (this.activeTabId(host) === tabId) {
      const next = own[index] ?? own[index - 1] ?? null
      this.activeByHost.set(host, next?.id ?? null)
      return { tab, nextActive: next }
    }
    return { tab, nextActive: this.active(host) }
  }

  /** 切活动标签；标签不属于这个宿主时返回 false，不跨宿主操作 */
  setActive(host: BrowserHost, tabId: string): boolean {
    if (!this.find(host, tabId)) return false
    this.activeByHost.set(host, tabId)
    return true
  }

  /** 全部标签 —— 收摊时统一关闭、窗口变化时统一改 bounds 用 */
  allTabs(): T[] {
    return this.tabs
  }

  clear(): void {
    this.tabs.length = 0
    this.activeByHost.clear()
  }
}
