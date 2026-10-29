import { describe, expect, it } from 'vitest'
import type { StreamItem } from '@contract/index'
import { summarizeTurn } from '../host/renderer/src/conversation/turnMeta'

/**
 * 一轮的结构：过程 / 最终答案 / 计量。
 *
 * 真实会话里一轮有几十条助手消息（每次调工具前后各有一段叙述），
 * 所以必须能认出「哪一段是答案」，并把过程单独统计出来。
 */

function say(
  text: string,
  stats?: { output: number; cacheRead: number; durationMs?: number; startedAt?: number }
): StreamItem {
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

function tool(callId: string): StreamItem {
  return { kind: 'tool', callId, name: 'bash', status: 'ok' }
}

describe('认出最终答案', () => {
  it('复制的是最终答案，不是过程叙述', () => {
    const summary = summarizeTurn([
      say('我先读一下现有实现。', { output: 12, cacheRead: 189 }),
      tool('t1'),
      say('全量重建，我改成增量。', { output: 30, cacheRead: 6402 }),
      say('改完了，测试全绿。', { output: 8, cacheRead: 6764 })
    ])
    expect(summary?.answer).toBe('改完了，测试全绿。')
    // 过程是答案之前的全部内容（含工具项）
    expect(summary?.answerIndex).toBe(3)
  })

  it('最后一段正文为空时退回上一段有内容的', () => {
    const summary = summarizeTurn([say('最终答案', { output: 1, cacheRead: 1 }), say('', { output: 1, cacheRead: 2 })])
    expect(summary?.answer).toBe('最终答案')
    expect(summary?.answerIndex).toBe(0)
  })

  it('一条正文都没有就认不出答案', () => {
    expect(summarizeTurn([say('', { output: 1, cacheRead: 1 }), tool('t1')])).toBeUndefined()
    expect(summarizeTurn([])).toBeUndefined()
  })
})

describe('过程的统计', () => {
  it('工具次数数的是答案之前的工具调用次数', () => {
    const summary = summarizeTurn([
      say('过程一', { output: 1, cacheRead: 1 }),
      tool('t1'),
      say('过程二', { output: 1, cacheRead: 1 }),
      tool('t2'),
      tool('t3'),
      say('最终答案', { output: 1, cacheRead: 1 }),
      tool('t-after')
    ])
    expect(summary?.steps).toBe(3)
  })

  it('过程耗时是最后一次过程请求说完 − 第一次请求发出', () => {
    const summary = summarizeTurn([
      say('过程一', { output: 1, cacheRead: 1, durationMs: 1000, startedAt: 1000 }),
      say('过程二', { output: 1, cacheRead: 1, durationMs: 2000, startedAt: 8000 }),
      say('最终答案', { output: 1, cacheRead: 1, durationMs: 3000, startedAt: 20_000 })
    ])
    // 8000 + 2000 − 1000 = 9000（中间跑工具的 5 秒也算）
    expect(summary?.processDurationMs).toBe(9000)
  })

  it('没有过程时就没有工具次数和过程耗时', () => {
    const summary = summarizeTurn([say('只有答案', { output: 1, cacheRead: 1, durationMs: 900, startedAt: 5000 })])
    expect(summary?.answerIndex).toBe(0)
    expect(summary?.steps).toBe(0)
    
    expect(summary?.processDurationMs).toBeUndefined()
  })
})

describe('整轮的计量', () => {
  it('输出 token 求和 —— 这一轮一共生成了多少', () => {
    const summary = summarizeTurn([
      say('过程一', { output: 12, cacheRead: 189 }),
      say('过程二', { output: 30, cacheRead: 6402 }),
      say('最终答案', { output: 8, cacheRead: 6764 })
    ])
    expect(summary?.stats?.output).toBe(50)
  })

  it('缓存取最后一次请求的值，不相加（相加是几十万，没有意义）', () => {
    const summary = summarizeTurn([
      say('过程一', { output: 1, cacheRead: 189 }),
      say('过程二', { output: 1, cacheRead: 6402 }),
      say('最终答案', { output: 1, cacheRead: 6764 })
    ])
    expect(summary?.stats?.cacheRead).toBe(6764)
  })

  it('耗时是整轮墙钟 —— 从第一次请求到最后一句说完', () => {
    const summary = summarizeTurn([
      say('过程', { output: 1, cacheRead: 1, durationMs: 1000, startedAt: 1000 }),
      say('最终答案', { output: 1, cacheRead: 1, durationMs: 2000, startedAt: 10_000 })
    ])
    expect(summary?.stats?.durationMs).toBe(11_000)
  })

  it('还在生成时没有耗时 —— 渲染层据此显示走动的计时器', () => {
    const summary = summarizeTurn([
      say('过程', { output: 1, cacheRead: 1, durationMs: 1000, startedAt: 1000 }),
      say('写到一半', { output: 1, cacheRead: 1, startedAt: 9000 })
    ])
    expect(summary?.stats?.durationMs).toBeUndefined()
    expect(summary?.stats?.startedAt).toBe(1000)
  })

  it('老会话没有 usage 时仍然认得出答案，只是没有计量', () => {
    const summary = summarizeTurn([say('过程'), say('最终答案')])
    expect(summary?.answer).toBe('最终答案')
    expect(summary?.stats).toBeUndefined()
  })
})
