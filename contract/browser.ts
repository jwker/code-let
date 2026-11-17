/**
 * 浏览器的「宿主」键（PLAN.md D57）。
 *
 * 放在 contract 是因为**两边都要构造它**：主进程用它分池，
 * 渲染进程也要用（产品 agent 的区域 6 是 `agent:<id>`，窄轨入口是 `project`）。
 * 各写一份字符串前缀，迟早会对不上。
 */

/** 浏览器的宿主：项目级，或某个 agent 的预览 */
export type BrowserHost = 'project' | `agent:${string}`

export const PROJECT_BROWSER: BrowserHost = 'project'

/** 一个 agent 的浏览器宿主 */
export function agentBrowserHost(agentId: string): BrowserHost {
  return `agent:${agentId}`
}

/** 来自 IPC 的宿主字符串 —— 认不出来的一律不算数，不猜默认值 */
export function isBrowserHost(value: unknown): value is BrowserHost {
  if (value === PROJECT_BROWSER) return true
  if (typeof value !== 'string') return false
  return value.startsWith('agent:') && value.length > 'agent:'.length
}
