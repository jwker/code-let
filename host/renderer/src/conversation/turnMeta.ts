import type { ReplyStats, StreamItem } from '@contract/index'

/**
 * 一轮对话的结构（过程 / 最终答案 / 计量）。
 *
 * 「一轮」= 一条用户消息之后、下一条用户消息之前的所有助手消息与工具调用。
 * 真实会话里一轮有几十条助手消息（每次调工具前后各有一段叙述），
 * 所以过程要能收成一行，答案单独顶格 —— 见 docs/design/turn-emphasis.html。
 */

export interface TurnSummary {
  /** 最终答案的正文 —— 复制只拿这个，过程叙述不算 */
  answer: string
  /** 最终答案在这一轮里的下标 —— 渲染层据此切成「过程 / 答案」 */
  answerIndex: number
  /** 过程里的工具调用次数 */
  toolCalls: number
  /** 过程里有多少段叙述（有正文的助手消息）—— 展开后大概会看到多少块文字 */
  segments: number
  /** 过程耗时：最后一次过程请求说完 − 第一次请求发出 */
  processDurationMs?: number
  /** 整轮聚合的计量（老会话可能没有 usage，那就没有这一项） */
  stats?: ReplyStats
}

/**
 * 把一轮的内容聚合成「过程 + 答案」。
 *
 * 三个口径：
 * - **答案**取最后一段有正文的助手消息（真实会话里它比过程叙述长一个量级）
 * - **输出 token** 求和（这一轮一共生成了多少）
 * - **缓存命中** 取最后一次请求的值 —— 它是那一次请求重读的上下文量，
 *   逐条相加没有意义（20 条加起来是几十万，那不是一个数）
 * - **耗时** 取整轮墙钟：从第一次请求发出到最后一句话说完，
 *   中间跑工具的时间也算 —— 用户感知的是「我等了多久」
 */
export function summarizeTurn(body: readonly StreamItem[]): TurnSummary | undefined {
  // 最终答案：最后一段真正有内容的正文
  let answerIndex = -1
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const item = body[i]
    if (item.kind === 'message' && item.role === 'assistant' && item.text.trim().length > 0) {
      answerIndex = i
      break
    }
  }
  if (answerIndex < 0) return undefined

  const answerItem = body[answerIndex]
  if (answerItem.kind !== 'message') return undefined

  // 过程：答案之前的部分
  let toolCalls = 0
  let segments = 0
  let processStart: number | undefined
  let processEnd: number | undefined
  for (let i = 0; i < answerIndex; i += 1) {
    const item = body[i]
    if (item.kind === 'tool') {
      toolCalls += 1
      continue
    }
    if (item.kind !== 'message' || item.role !== 'assistant') continue
    if (item.text.trim().length > 0) segments += 1
    if (!item.stats) continue
    if (processStart === undefined && item.stats.startedAt !== undefined) {
      processStart = item.stats.startedAt
    }
    if (item.stats.startedAt !== undefined && item.stats.durationMs !== undefined) {
      processEnd = item.stats.startedAt + item.stats.durationMs
    }
  }

  const summary: TurnSummary = {
    answer: answerItem.text,
    answerIndex,
    toolCalls,
    segments
  }

  if (processStart !== undefined && processEnd !== undefined) {
    summary.processDurationMs = Math.max(0, processEnd - processStart)
  }

  // 计量：整轮所有带 stats 的助手消息
  const measured = body.filter(
    (item): item is Extract<StreamItem, { kind: 'message' }> & { stats: ReplyStats } =>
      item.kind === 'message' && item.role === 'assistant' && item.stats !== undefined
  )
  if (measured.length > 0) {
    const first = measured[0].stats
    const last = measured[measured.length - 1].stats
    const stats: ReplyStats = {
      input: last.input,
      output: measured.reduce((sum, item) => sum + item.stats.output, 0),
      cacheRead: last.cacheRead,
      cacheWrite: last.cacheWrite
    }
    if (first.startedAt !== undefined) stats.startedAt = first.startedAt
    if (
      first.startedAt !== undefined &&
      last.startedAt !== undefined &&
      last.durationMs !== undefined
    ) {
      stats.durationMs = Math.max(0, last.startedAt + last.durationMs - first.startedAt)
    }
    summary.stats = stats
  }

  return summary
}
