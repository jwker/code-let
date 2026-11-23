import type { StreamItem } from '@contract/index'

/**
 * 模型调用失败的分组与「这一轮到底有没有救回来」的判定。
 *
 * 失败归属于一次**模型调用**，不是整轮；界面上它按时间序留在过程块里，
 * 连续的失败合成一条并带次数。这里只算数据，不碰 React。
 */

type MessageItem = Extract<StreamItem, { kind: 'message' }>
export type FailureItem = MessageItem & { errorMessage: string }

/** 这一条是不是一次模型调用失败 —— provider 原始错误非空才算 */
export function isCallFailure(item: StreamItem): item is FailureItem {
  return (
    item.kind === 'message' &&
    typeof item.errorMessage === 'string' &&
    item.errorMessage.trim().length > 0
  )
}

/** 一条连续的失败段 */
export interface FailureRun {
  /** 第一个失败条目在 body 里的下标 */
  start: number
  /** 这一段连续失败的调用次数 */
  count: number
  /** provider 原始错误（同一段里去重、保持出现顺序） */
  errors: string[]
}

export interface CallFailureSummary {
  /** 按时间序的失败段 */
  runs: FailureRun[]
  /** 失败调用总次数（不是段数） */
  count: number
  /** 这一轮最后没救回来 */
  failed: boolean
  /** 用户中止过这一轮 */
  aborted: boolean
}

/** 失败之后出现「成功内容」才算自愈：助手正文或成功的工具调用 */
function isSuccessContent(item: StreamItem): boolean {
  if (item.kind === 'tool') return item.status === 'ok'
  return item.kind === 'message' && item.role === 'assistant' && item.text.trim().length > 0
}

export function summarizeCallFailures(body: readonly StreamItem[]): CallFailureSummary {
  const runs: FailureRun[] = []
  let current: FailureRun | null = null
  let lastFailureIndex = -1
  let aborted = false

  for (let index = 0; index < body.length; index += 1) {
    const item = body[index]
    if (item.kind === 'message' && item.aborted === true) aborted = true

    if (isCallFailure(item)) {
      lastFailureIndex = index
      if (!current) {
        current = { start: index, count: 0, errors: [] }
        runs.push(current)
      }
      current.count += 1
      if (!current.errors.includes(item.errorMessage)) current.errors.push(item.errorMessage)
      continue
    }

    // 中间夹了任何别的内容，下一段失败另起一条
    current = null
  }

  let failed = false
  if (!aborted && lastFailureIndex >= 0) {
    const healed = body
      .slice(lastFailureIndex + 1)
      .some((item) => isSuccessContent(item))
    failed = !healed
  }

  return {
    runs,
    count: runs.reduce((sum, run) => sum + run.count, 0),
    failed,
    aborted
  }
}
