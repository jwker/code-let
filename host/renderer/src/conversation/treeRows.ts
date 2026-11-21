import type { SessionTree, SessionTreeNode } from '@contract/index'

/**
 * 树弹窗里的「一行一轮」。
 *
 * 契约给的是**条目级**的树（用户消息、助手回复、工具结果各是节点）；
 * 弹窗里一行是一轮：提问是正文，回答压成一行小字。合并规则见
 * `.scratch/conversation-tree/spec.md` 的「合并规则」。
 *
 * 纯函数：不碰 host、不碰 DOM，固定输入固定输出。
 */

/** 回答摘要的长度上限（字） */
export const ANSWER_LIMIT = 20

/** 一行摘要：最多 20 字，超了截断加省略号 */
export function brief(text: string): string {
  const chars = [...text]
  return chars.length > ANSWER_LIMIT ? `${chars.slice(0, ANSWER_LIMIT - 1).join('')}…` : text
}

export interface TreeRow {
  /** 这一行的身份：提问那条用户条目 */
  key: string
  /** 提问（用条目的摘要，单行渲染） */
  text: string
  /** 回答摘要，最多 20 字；还没有回答时是空串 */
  answer: string
  /** 这一行里最后一条条目 —— 「切到这里」把当前叶放在它上面 */
  leafTargetId: string
  /** 提问那条用户条目 —— 「回到这一轮」用它 */
  userId: string
  /** 在活动支线上的第几轮（1 起）；别的支线上没有 */
  turn?: number
  /** ISO 时间串 */
  timestamp: string
  /** 标签（先看提问，再看这一行里其他条目） */
  label?: string
  /** 这一行包含的全部条目 id —— 判断当前叶在不在这里 */
  entryIds: string[]
}

/**
 * 条目树 → 一行一轮。
 *
 * - 每条用户条目开一行；紧接着出现在它子树里的助手条目并进这一行，
 *   回答摘要取**最后一条**助手条目（用户看到的是最终答案）。
 * - 工具结果、支线摘要、压缩、标签条目不单独成行，归到它所在的那一行。
 * - 一个用户条目都没有的子树（比如会话从助手消息开始）不造行 —— 那一轮没有提问，
 *   在「一行一轮」里没有位置。
 */
export function treeToRows(tree: SessionTree): TreeRow[] {
  const rows: TreeRow[] = []

  function visit(node: SessionTreeNode, current: TreeRow | null): void {
    let row = current

    if (node.kind === 'user') {
      row = {
        key: node.id,
        text: node.preview,
        answer: '',
        leafTargetId: node.id,
        userId: node.id,
        timestamp: node.timestamp,
        entryIds: [node.id],
        ...(node.turn ? { turn: node.turn } : {}),
        ...(node.label ? { label: node.label } : {})
      }
      rows.push(row)
    } else if (row) {
      row.entryIds.push(node.id)
      row.leafTargetId = node.id
      if (node.kind === 'assistant') row.answer = brief(node.preview)
      if (!row.label && node.label) row.label = node.label
    }

    for (const child of node.children) visit(child, row)
  }

  for (const root of tree.roots) visit(root, null)
  return rows
}
