import { describe, expect, it } from 'vitest'
import type { StreamItem } from '@contract/index'
import { applyEvent, entriesToItems } from '@contract/stream'
import {
  isCallFailure,
  summarizeCallFailures
} from '../host/renderer/src/conversation/callErrors'

/**
 * 模型调用失败的分组与「这一轮到底有没有失败」的判定。
 *
 * 失败归属于一次调用，显示在它发生的位置；连续失败合成一条并带次数，
 * 中间夹了成功内容就另起一条。这里只算数据，界面只负责画。
 */

const say = (text: string): StreamItem => ({ kind: 'message', role: 'assistant', text })
const fail = (error: string): StreamItem => ({
  kind: 'message',
  role: 'assistant',
  text: '',
  errorMessage: error
})
const tool = (id: string, status: 'ok' | 'error' | 'running' = 'ok'): StreamItem => ({
  kind: 'tool',
  callId: id,
  name: 'bash',
  status
})
const result = (id: string, text = 'ok'): StreamItem => ({
  kind: 'message',
  role: 'toolResult',
  text,
  callId: id
})

describe('识别调用失败', () => {
  it('带 provider 原始错误的助手消息才算', () => {
    expect(isCallFailure(fail('429'))).toBe(true)
    expect(isCallFailure(say('正常'))).toBe(false)
    expect(isCallFailure(tool('t1'))).toBe(false)
    // 空字符串不算
    expect(isCallFailure({ kind: 'message', role: 'assistant', text: '', errorMessage: '   ' })).toBe(false)
  })
})

describe('连续失败合成一条', () => {
  it('单次失败', () => {
    const summary = summarizeCallFailures([say('先读一下'), fail('timeout'), say('好了')])
    expect(summary.runs).toHaveLength(1)
    expect(summary.runs[0].count).toBe(1)
    expect(summary.runs[0].errors).toEqual(['timeout'])
    expect(summary.count).toBe(1)
    expect(summary.failed).toBe(false)
  })

  it('连续三次合成一条并带次数', () => {
    const summary = summarizeCallFailures([
      say('先读一下'),
      fail('timeout'),
      fail('timeout'),
      fail('429'),
      say('好了')
    ])
    expect(summary.runs).toHaveLength(1)
    expect(summary.runs[0].count).toBe(3)
    expect(summary.runs[0].errors).toEqual(['timeout', '429'])
    expect(summary.count).toBe(3)
    expect(summary.failed).toBe(false)
  })

  it('成功内容隔开之后再失败算新的一条', () => {
    const summary = summarizeCallFailures([
      fail('timeout'),
      say('中间成功了一次'),
      fail('429')
    ])
    expect(summary.runs).toHaveLength(2)
    expect(summary.runs.map((run) => run.count)).toEqual([1, 1])
    expect(summary.runs.map((run) => run.start)).toEqual([0, 2])
  })

  it('工具调用和工具结果也算内容，隔开两次失败', () => {
    const summary = summarizeCallFailures([fail('a'), tool('t1'), result('t1'), fail('b')])
    expect(summary.runs).toHaveLength(2)
  })
})

describe('这一轮有没有救回来', () => {
  it('最后一次调用失败、之后没有任何成功内容 → 轮次失败', () => {
    expect(summarizeCallFailures([fail('timeout')]).failed).toBe(true)
    expect(summarizeCallFailures([say('先读一下'), fail('timeout')]).failed).toBe(true)
    expect(summarizeCallFailures([fail('a'), tool('t1', 'error')]).failed).toBe(true)
  })

  it('失败之后成功了（正文或工具调用）→ 只是调用失败', () => {
    expect(summarizeCallFailures([fail('timeout'), say('给了答案')]).failed).toBe(false)
    expect(summarizeCallFailures([fail('timeout'), tool('t1')]).failed).toBe(false)
  })

  it('没有失败 → 不算轮次失败', () => {
    expect(summarizeCallFailures([say('正常')]).failed).toBe(false)
    expect(summarizeCallFailures([]).failed).toBe(false)
  })

  it('中止优先：有中止标记就不算失败（01 先按已有字段收集事实）', () => {
    const aborted: StreamItem = {
      kind: 'message',
      role: 'assistant',
      text: '',
      errorMessage: 'timeout',
      aborted: true
    }
    const summary = summarizeCallFailures([aborted])
    expect(summary.aborted).toBe(true)
    expect(summary.failed).toBe(false)
  })
})

describe('历史与实时两条来源分组一致', () => {
  const entriesFor = (errorMessage: string) => [
    { type: 'message', message: { role: 'user', content: '问题' } },
    {
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        errorMessage,
        stopReason: 'error'
      }
    },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } }
  ]

  it('会话文件读出来的与实时事件推出来的一致', () => {
    const history = entriesToItems(entriesFor('timeout'))
    const live = [
      {
        type: 'message_start',
        data: { message: { role: 'user', content: [{ type: 'text', text: '问题' }] } }
      },
      { type: 'message_start', data: { message: { role: 'assistant', content: [] } } },
      {
        type: 'message_end',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            errorMessage: 'timeout',
            stopReason: 'error'
          }
        }
      },
      {
        type: 'message_start',
        data: { message: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } }
      },
      // 助手正文靠 delta 长出来（message_start 只是空壳）
      { type: 'message_update', data: { type: 'text_delta', delta: '好了' } }
    ].reduce((items, event) => applyEvent(items, event), [] as StreamItem[])

    expect(summarizeCallFailures(history)).toEqual(summarizeCallFailures(live))
    expect(summarizeCallFailures(history).runs[0].count).toBe(1)
    expect(summarizeCallFailures(history).failed).toBe(false)
  })
})
