import type { StreamItem } from '@contract/index'

/**
 * 把一段内容流切成渲染行（纯函数，好测）。
 *
 * 关键一点：**工具项不一定前面有正文**。真实会话里 item 的顺序常常是
 *
 *   [工具] [结果] [工具] [结果] …
 *
 * 因为模型每次只发一个 toolCall，结果紧接着就来了 —— 那种「工具一定跟在某段
 * 正文后面」的假设会把这类工具整条丢掉，摘要说 50 步、展开只看见两行。
 */

type MessageItem = Extract<StreamItem, { kind: 'message' }>
type ToolItem = Extract<StreamItem, { kind: 'tool' }>

export type BodyRow =
  /** 一段正文，后面跟着紧挨的工具行 */
  | { kind: 'message'; item: MessageItem; tools: ToolItem[] }
  /** 前面没有正文的一串工具 */
  | { kind: 'tools'; tools: ToolItem[] }
  /** 没有主的工具输出 */
  | { kind: 'output'; text: string }

export function groupBody(
  items: readonly StreamItem[],
  ownedToolIds: ReadonlySet<string>
): BodyRow[] {
  const rows: BodyRow[] = []
  let index = 0

  while (index < items.length) {
    const item = items[index]

    // 没有正文打头的工具串 —— 一定要画出来，否则这些步数在界面上不存在
    if (item.kind === 'tool') {
      const tools: ToolItem[] = []
      let look = index
      while (look < items.length && items[look].kind === 'tool') {
        tools.push(items[look] as ToolItem)
        look += 1
      }
      rows.push({ kind: 'tools', tools })
      index = look
      continue
    }

    // 工具输出：归它的工具行，没主的才单列
    if (item.role === 'toolResult') {
      if (!item.callId || !ownedToolIds.has(item.callId)) {
        rows.push({ kind: 'output', text: item.text })
      }
      index += 1
      continue
    }

    const tools: ToolItem[] = []
    let look = index + 1
    while (look < items.length && items[look].kind === 'tool') {
      tools.push(items[look] as ToolItem)
      look += 1
    }
    rows.push({ kind: 'message', item, tools })
    index = look
  }

  return rows
}
