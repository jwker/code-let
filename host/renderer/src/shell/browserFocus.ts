import type { BrowserAgentActivity, BrowserState } from '@contract/index'

/**
 * 「agent 动了浏览器」这件事的判定。
 *
 * 主进程每次 agent 调一次浏览器工具，就换一份新的活动记录推过来
 * （`BrowserState.agent`）。所以判据只有一条：**活动记录换了一份新的**。
 *
 * - 换新的 → agent 又动了一下浏览器，调用方把右侧面板切到浏览器视图；
 * - 还是原来那份 → 只是状态被重复推了一遍，不动；
 * - 没有活动记录 → agent 没在动浏览器（用户自己在面板里点也不算）。
 *
 * 单独拎出来是为了能测：这段逻辑盯的是「对象是不是同一份」，
 * 放在组件里就只能靠点页面来验。
 */
export interface BrowserFocusController {
  /** 收到一份新的浏览器状态；判定是 agent 的新动作就调 onFocus */
  handle(state: BrowserState): void
}

export function createBrowserFocusController(onFocus: () => void): BrowserFocusController {
  let lastActivity: BrowserAgentActivity | null = null

  return {
    handle(state: BrowserState): void {
      const activity = state.agent
      // 没有活动记录 = agent 没在动浏览器
      if (!activity) return
      // 同一份记录被重复推 → 不是新动作
      if (lastActivity === activity) return
      lastActivity = activity
      onFocus()
    }
  }
}
