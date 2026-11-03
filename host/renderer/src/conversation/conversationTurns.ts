import type { StreamItem } from '@contract/index'

/**
 * 对话导航的一条用户轮次（PLAN.md D36）。
 *
 * 只从内容流里取用户消息；正文里的 `<file>` 附件块不进预览，
 * 附件文件名单独留下给卡片显示。
 */
export interface NavTurn {
  /** 在完整 items 数组里的下标，用来找 DOM 锚点 */
  index: number
  /** 去掉附件块后的用户输入 */
  text: string
  /** 附件文件名；没有附件时为空 */
  files: string[]
}

const FILE_BLOCK = /<file name="([^"]*)">[\s\S]*?<\/file>/g
const FILE_TAG = /<file name="([^"]*)">/g

export function userTurnsOf(items: readonly StreamItem[]): NavTurn[] {
  const turns: NavTurn[] = []
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind !== 'message' || item.role !== 'user') continue

    const files = [...item.text.matchAll(FILE_TAG)].map((match) => match[1]).filter(Boolean)
    const text = item.text
      .replace(FILE_BLOCK, '')
      .replace(/<file name="[^"]*"><\/file>/g, '')
      .trim()

    turns.push({ index, text, files: [...new Set(files)] })
  }
  return turns
}

/** 卡片/无障碍标签里的一句话摘要 */
export function navTurnSummary(turn: NavTurn, ordinal: number): string {
  const body = turn.text || (turn.files.length > 0 ? '（无文字，含附件）' : '（空消息）')
  return `第 ${ordinal} 轮：${body.replace(/\s+/g, ' ').slice(0, 80)}`
}
