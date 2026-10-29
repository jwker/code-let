import { describe, expect, it } from 'vitest'
import type { StreamItem } from '@contract/index'
import { groupBody } from '../host/renderer/src/conversation/groupBody'

/**
 * 内容流切成渲染行。
 *
 * 这个函数存在的唯一理由：真实会话里工具项的顺序是
 *
 *   [工具] [结果] [工具] [结果] …
 *
 * 模型每次只发一个 toolCall，结果紧跟着就来。如果假设「工具一定跟在某段正文
 * 后面」，这些工具会被整条丢掉 —— 摘要说 50 步、展开只看见两行。
 */

const say = (text: string): StreamItem => ({ kind: 'message', role: 'assistant', text })
const tool = (id: string, name = 'bash'): StreamItem => ({ kind: 'tool', callId: id, name, status: 'ok' })
const result = (id: string, text = 'ok'): StreamItem => ({
  kind: 'message',
  role: 'toolResult',
  text,
  callId: id
})

/** 把行还原成它们包含的工具 id —— 用来断言「一个都没丢」 */
function toolIdsOf(rows: ReturnType<typeof groupBody>): string[] {
  return rows.flatMap((row) => (row.kind === 'output' ? [] : row.tools.map((t) => t.callId)))
}

describe('工具项一个都不能丢', () => {
  it('工具和结果交错出现 —— 每个工具都要有自己的行', () => {
    const items: StreamItem[] = []
    for (let i = 0; i < 5; i += 1) {
      items.push(tool(`t${i}`), result(`t${i}`))
    }
    const rows = groupBody(items, new Set(['t0', 't1', 't2', 't3', 't4']))
    expect(toolIdsOf(rows)).toEqual(['t0', 't1', 't2', 't3', 't4'])
  })

  it('没有正文打头的工具串也要画出来', () => {
    const rows = groupBody([tool('t1'), result('t1')], new Set(['t1']))
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('tools')
    expect(toolIdsOf(rows)).toEqual(['t1'])
  })

  it('连续几个工具归成一组（并行调用）', () => {
    const rows = groupBody([say('跑一下'), tool('t1'), tool('t2'), tool('t3')], new Set())
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('message')
    expect(toolIdsOf(rows)).toEqual(['t1', 't2', 't3'])
  })

  it('真实节奏：正文 → 工具 → 结果 → 正文 → 工具 → 结果', () => {
    const items: StreamItem[] = [
      say('我先读一下'),
      tool('t1', 'read'),
      result('t1', '内容'),
      say('再改一下'),
      tool('t2', 'edit'),
      result('t2', 'ok')
    ]
    const rows = groupBody(items, new Set(['t1', 't2']))
    // 工具紧跟在正文后面 → 归到那一行里；关键是两个工具都在
    expect(rows.map((row) => row.kind)).toEqual(['message', 'message'])
    expect(toolIdsOf(rows)).toEqual(['t1', 't2'])
  })
})

describe('工具输出的归属', () => {
  it('有主的输出不单列 —— 它挂在工具行里', () => {
    const rows = groupBody([tool('t1'), result('t1', '很长的输出')], new Set(['t1']))
    expect(rows.some((row) => row.kind === 'output')).toBe(false)
  })

  it('没主的输出单独一行', () => {
    const rows = groupBody([result('orphan', '没有对应工具')], new Set())
    expect(rows).toEqual([{ kind: 'output', text: '没有对应工具' }])
  })
})

describe('正文', () => {
  it('纯正文没有工具时就是一行', () => {
    const rows = groupBody([say('只有正文')], new Set())
    expect(rows).toEqual([{ kind: 'message', item: say('只有正文'), tools: [] }])
  })

  it('空数组没有行', () => {
    expect(groupBody([], new Set())).toEqual([])
  })
})
