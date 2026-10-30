import type { TabInfo } from '@contract/index'

/**
 * 关标签的判定与流程（纯逻辑，好测）。
 *
 * **正在跑的标签不能直接关** —— 关掉就中止那一轮。
 * 所以点「×」时先问一句，用户确认了才真的关。
 *
 * 组件（TabBar）只管画确认框；关不关、什么时候关，全在这里定。
 */

/** 关标签流程的状态 */
export interface TabCloseState {
  /** 确认框要不要亮着 */
  asking: boolean
  /** 标签已经被关掉了 */
  closed: boolean
}

/** 初始状态：什么都不问，也没关 */
export const idleTabClose: TabCloseState = { asking: false, closed: false }

/** 关标签控制器 */
export interface TabCloseController {
  /** 当前状态（同一个引用，直到状态真的变了） */
  getState(): TabCloseState
  /** 状态变了就通知（React 那边 useSyncExternalStore 用） */
  subscribe(listener: () => void): () => void
  /**
   * 用户点了「×」。
   *
   * 正在跑 → 只把确认框亮出来，不关；
   * 没在跑 → 直接关掉。
   */
  requestClose(): Promise<TabCloseState>
  /** 确认框里的「中止并关闭」 */
  confirm(): Promise<TabCloseState>
  /** 确认框里的「取消」 */
  cancel(): TabCloseState
}

/**
 * 建一个关标签的控制器。
 *
 * `getTab` 每次都拿最新的标签 —— 标签的 streaming 状态会变（那一轮跑完了），
 * 控制器不能把「正在跑」这件事记在创建那一刻。
 */
export function createTabCloseController(options: {
  getTab: () => TabInfo
  closeTab: (tabId: string) => Promise<unknown>
}): TabCloseController {
  const listeners = new Set<() => void>()
  let state: TabCloseState = idleTabClose

  function setState(next: TabCloseState): TabCloseState {
    if (next.asking === state.asking && next.closed === state.closed) return state
    state = next
    for (const listener of listeners) listener()
    return state
  }

  async function doClose(): Promise<TabCloseState> {
    await options.closeTab(options.getTab().id)
    return setState({ asking: false, closed: true })
  }

  return {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async requestClose(): Promise<TabCloseState> {
      if (options.getTab().streaming) return setState({ asking: true, closed: false })
      return doClose()
    },
    async confirm(): Promise<TabCloseState> {
      return doClose()
    },
    cancel(): TabCloseState {
      return setState({ asking: false, closed: false })
    }
  }
}

/** 确认框里的文案 */
export interface TabCloseCopy {
  title: string
  body: string
  confirmText: string
  cancelText: string
}

/**
 * 关掉正在跑的标签时，确认框上写什么。
 *
 * 要说清两件事：会中止这一轮；已经生成的内容还在会话文件里。
 */
export function runningTabCloseCopy(tab: TabInfo): TabCloseCopy {
  return {
    title: '这个对话还在生成',
    body: `「${tab.title}」的 agent 正在跑。关掉标签会中止这一轮 —— 已经生成的内容会留在会话文件里，但这一轮不会跑完。`,
    confirmText: '中止并关闭',
    cancelText: '取消'
  }
}
