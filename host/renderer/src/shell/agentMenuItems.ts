import type { AgentInfo } from '@contract/index'

/**
 * agent 右键菜单里各项的可点状态 —— 纯函数，单独一个文件。
 *
 * 抽出来是为了能在 node 环境里测：组件会 import store（进而 import `window`），
 * 测试里跑不起来。跟 `gitFormat.ts` 是同一个理由。
 */

export interface MenuItemState {
  /** 能不能点 */
  enabled: boolean
  /** 不能点的原因（悬停时给出来，别让人对着灰按钮猜） */
  reason?: string
}

/**
 * 哪些项在什么状态下可点。
 *
 * 只有「归档」受状态限制：正在跑的不许归档（D53）。
 * 删除反过来**允许**在运行时做 —— 它会先 abort 再移文件，用户点之前已经被确认过。
 */
export function agentMenuState(agent: Pick<AgentInfo, 'streaming'>): {
  newInstance: MenuItemState
  rename: MenuItemState
  archive: MenuItemState
  remove: MenuItemState
} {
  return {
    newInstance: { enabled: true },
    rename: { enabled: true },
    archive: agent.streaming
      ? { enabled: false, reason: '正在跑，先停下来再归档' }
      : { enabled: true },
    remove: agent.streaming
      ? { enabled: true, reason: '会先中止这一轮，再把会话移到废纸篓' }
      : { enabled: true }
  }
}
