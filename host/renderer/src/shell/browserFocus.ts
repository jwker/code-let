import type { BrowserAgentActivity, BrowserEvent } from '@contract/index'
import { isBrowserHost, type BrowserHost } from '@contract/browser'

/**
 * 「agent 动了浏览器」这件事的判定。
 *
 * 主进程每次 agent 调一次浏览器工具，就换一份新的活动记录推过来
 * （`BrowserState.agent`）。所以判据只有一条：**活动记录换了一份新的**。
 *
 * - 换新的 → agent 又动了一下浏览器，调用方把右栏展开并切到浏览器视图；
 * - 还是原来那份 → 只是状态被重复推了一遍，不动；
 * - 没有活动记录 → agent 没在动浏览器（用户自己在面板里点也不算）。
 *
 * 项目级宿主和 agent 宿主都算：产品 agent 写原型时右栏要自己亮起来。
 * 至于「动的是不是左列正在看的那个宿主」，那是调用方按 `browserHostFor`
 * 判的 —— 后台 agent 动浏览器不该抢走用户眼前的面板。
 *
 * 单独拎出来是为了能测：这段逻辑盯的是「对象是不是同一份」，
 * 放在组件里就只能靠点页面来验。
 */
export interface BrowserFocusController {
  /** 收到一次浏览器状态推送；判定是 agent 的新动作就调 onFocus */
  handle(event: BrowserEvent): void
}

export function createBrowserFocusController(onFocus: (host: BrowserHost) => void): BrowserFocusController {
  let lastActivity: BrowserAgentActivity | null = null

  return {
    handle(event: BrowserEvent): void {
      const activity = event.state.agent
      // 没有活动记录 = agent 没在动浏览器
      if (!activity) return
      // 同一份记录被重复推 → 不是新动作
      if (lastActivity === activity) return
      lastActivity = activity
      // 契约里 host 是 string（给 IPC 用）；认不出来的一律不当数
      if (isBrowserHost(event.host)) onFocus(event.host)
    }
  }
}
