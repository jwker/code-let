import type { ReplyStats, StreamItem } from '@contract/index'

/**
 * 一轮对话的元信息（token / 耗时 / 最终答案）。
 *
 * 「一轮」= 一条用户消息之后、下一条用户消息之前的所有助手消息与工具调用。
 * 真实会话里一轮会有几十条助手消息（每次调工具前后各有一段叙述），
 * 所以元信息行按轮聚合，不是每条一条。
 */

type AssistantItem = Extract<StreamItem, { kind: 'message' }> & { role: 'assistant' }

export interface TurnMeta {
  /** 该轮**最终答案**的正文 —— 复制只拿这个，过程叙述不算 */
  answer: string
  /** 整轮聚合后的计量 */
  stats: ReplyStats
}

/**
 * 把一轮里的助手消息聚合成一行元信息。
 *
 * 三个口径：
 * - **答案**取最后一段有正文的助手消息（真实会话里它比过程叙述长一个量级）
 * - **输出 token** 求和（这一轮一共生成了多少）
 * - **缓存命中** 取最后一次请求的值 —— 它是那一次请求重读的上下文量，
 *   逐条相加没有意义（20 条加起来是几十万，那不是一个数）
 * - **耗时** 取整轮墙钟：从第一次请求发出到最后一句话说完，
 *   中间跑工具的时间也算 —— 用户感知的是「我等了多久」
 */
export function summarizeTurn(items: readonly AssistantItem[]): TurnMeta | undefined {
  // 最终答案：最后一段真正有内容的正文
  let answer = ''
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].text.trim().length > 0) {
      answer = items[i].text
      break
    }
  }
  if (!answer) return undefined

  const measured = items.filter((item): item is AssistantItem & { stats: ReplyStats } => item.stats !== undefined)
  if (measured.length === 0) return undefined

  const first = measured[0].stats
  const last = measured[measured.length - 1].stats
  const output = measured.reduce((sum, item) => sum + item.stats.output, 0)

  const stats: ReplyStats = {
    input: last.input,
    output,
    cacheRead: last.cacheRead,
    cacheWrite: last.cacheWrite
  }

  if (first.startedAt !== undefined) stats.startedAt = first.startedAt
  if (first.startedAt !== undefined && last.startedAt !== undefined && last.durationMs !== undefined) {
    stats.durationMs = Math.max(0, last.startedAt + last.durationMs - first.startedAt)
  }

  return { answer, stats }
}
