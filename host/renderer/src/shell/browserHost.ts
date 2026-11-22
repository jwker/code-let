/**
 * 右栏的浏览器看哪个宿主。
 *
 * 规则只有一条（ADR-0005）：左列是带预览能力的 agent 时看它自己的预览，
 * 其余情况都看项目级浏览器。放在一个纯函数里，组件和「agent 动浏览器」的
 * 判定共用同一份，不在两处各写一遍。
 */

import type { AgentTypeDef, ProjectPaneView } from '@contract/index'
import { capabilitiesOf } from '@contract/index'
import { PROJECT_BROWSER, agentBrowserHost, type BrowserHost } from '@contract/browser'

export function browserHostFor(
  pane: ProjectPaneView,
  agent: { id: string } | null,
  agentDef: AgentTypeDef | null
): BrowserHost {
  if (pane !== 'agent' || !agent) return PROJECT_BROWSER
  return capabilitiesOf(agentDef).preview ? agentBrowserHost(agent.id) : PROJECT_BROWSER
}
