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
 * 「归档」受运行状态限制：正在跑的不许归档（D53）。
 * 删除反过来**允许**在运行时做 —— 它会先 abort 再移文件，用户点之前已经被确认过。
 *
 * 「以此 agent 新建实例」多一个限制：类型定义已经找不到（未知 agent）时置灰 ——
 * 新建出来的会是一条同样挂着未知类型的记录，没有意义。
 */
export function agentMenuState(
  agent: Pick<AgentInfo, 'streaming'> & { typeKnown?: boolean }
): {
  newInstance: MenuItemState
  rename: MenuItemState
  archive: MenuItemState
  remove: MenuItemState
} {
  return {
    newInstance:
      agent.typeKnown === false
        ? { enabled: false, reason: '这个 agent 的类型已经不在了，新建出来也是未知类型' }
        : { enabled: true },
    rename: { enabled: true },
    archive: agent.streaming
      ? { enabled: false, reason: '正在跑，先停下来再归档' }
      : { enabled: true },
    remove: agent.streaming
      ? { enabled: true, reason: '会先中止这一轮，再把会话移到废纸篓' }
      : { enabled: true }
  }
}
