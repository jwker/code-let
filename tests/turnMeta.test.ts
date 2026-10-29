import { describe, expect, it } from 'vitest'
import type { StreamItem } from '@contract/index'
import { summarizeTurn } from '../host/renderer/src/conversation/turnMeta'

/**
 * 一轮的元信息（token / 耗时 / 最终答案）。
 *
 * 真实会话里一轮会有几十条助手消息（每次调工具前后各有一段叙述），
 * 所以必须按轮聚合 —— 一条一个的话，一次提问会画出几十个复制按钮。
 */

type AssistantItem = Extract<StreamItem, { kind: 'message' }> & { role: 'assistant' }

function say(
  text: string,
  stats?: { output: number; cacheRead: number; durationMs?: number; startedAt?: number }
): AssistantItem {
  return {
    kind: 'message',
    role: 'assistant',
    text,
    ...(stats
      ? {
          stats: {
            input: 100,
            output: stats.output,
            cacheRead: stats.cacheRead,
            cacheWrite: 0,
            ...(stats.durationMs !== undefined ? { durationMs: stats.durationMs } : {}),
            ...(stats.startedAt !== undefined ? { startedAt: stats.startedAt } : {})
          }
        }
      : {})
  }
}

describe('按轮聚合', () => {
  it('复制的是最终答案，不是过程叙述', () => {
    const meta = summarizeTurn([
      say('我先读一下现有实现。', { output: 12, cacheRead: 189, durationMs: 1200, startedAt: 0 }),
      say('全量重建，我改成增量。', { output: 30, cacheRead: 6402, durationMs: 2100, startedAt: 5000 }),
      say('改完了，测试全绿。', { output: 8, cacheRead: 6764, durationMs: 900, startedAt: 9000 })
    ])
    expect(meta?.answer).toBe('改完了，测试全绿。')
  })

  it('输出 token 求和 —— 这一轮一共生成了多少', () => {
    const meta = summarizeTurn([
      say('过程一', { output: 12, cacheRead: 189 }),
      say('过程二', { output: 30, cacheRead: 6402 }),
      say('最终答案', { output: 8, cacheRead: 6764 })
    ])
    expect(meta?.stats.output).toBe(50)
  })

  it('缓存取最后一次请求的值，不相加（相加是几十万，没有意义）', () => {
    const meta = summarizeTurn([
      say('过程一', { output: 1, cacheRead: 189 }),
      say('过程二', { output: 1, cacheRead: 6402 }),
      say('最终答案', { output: 1, cacheRead: 6764 })
    ])
    expect(meta?.stats.cacheRead).toBe(6764)
  })

  it('耗时是整轮墙钟 —— 从第一次请求到最后一句说完', () => {
    const meta = summarizeTurn([
      say('过程', { output: 1, cacheRead: 1, durationMs: 1000, startedAt: 1000 }),
      say('最终答案', { output: 1, cacheRead: 1, durationMs: 2000, startedAt: 10_000 })
    ])
    // 10_000 + 2000 - 1000 = 11_000（中间跑工具的 7 秒也算）
    expect(meta?.stats.durationMs).toBe(11_000)
  })

  it('还在生成时没有耗时 —— 渲染层据此显示走动的计时器', () => {
    const meta = summarizeTurn([
      say('过程', { output: 1, cacheRead: 1, durationMs: 1000, startedAt: 1000 }),
      say('写到一半', { output: 1, cacheRead: 1, startedAt: 9000 })
    ])
    expect(meta?.stats.durationMs).toBeUndefined()
    expect(meta?.stats.startedAt).toBe(1000)
  })

  it('最后一段正文为空时退回上一段有内容的', () => {
    const meta = summarizeTurn([
      say('最终答案', { output: 1, cacheRead: 1 }),
      say('', { output: 1, cacheRead: 2 })
    ])
    expect(meta?.answer).toBe('最终答案')
  })

  it('一条正文都没有就不出元信息行', () => {
    expect(summarizeTurn([say('', { output: 1, cacheRead: 1 })])).toBeUndefined()
    expect(summarizeTurn([])).toBeUndefined()
  })

  it('没有计量数据时不出元信息行（历史老会话可能没有 usage）', () => {
    expect(summarizeTurn([say('有正文但没数')])).toBeUndefined()
  })
})
