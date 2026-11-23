import { describe, expect, it } from 'vitest'
import type { StreamItem } from '@contract/index'
import { applyEvent, entriesToItems } from '@contract/stream'
import {
  callFailureTurns,
  errorTitle,
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
const fail = (error: string, stopReason?: string): StreamItem => ({
  kind: 'message',
  role: 'assistant',
  text: '',
  errorMessage: error,
  ...(stopReason ? { stopReason } : {})
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

  it('中止优先：有中止标记就不算失败', () => {
    const aborted: StreamItem = {
      kind: 'message',
      role: 'assistant',
      text: '',
      errorMessage: 'timeout',
      stopReason: 'error',
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


describe('按 stopReason 判定，而不是猜', () => {
  const stopped = (text: string, stopReason: string): StreamItem => ({
    kind: 'message',
    role: 'assistant',
    text,
    stopReason
  })

  it('最后一条助手消息 stopReason=error → 轮次失败', () => {
    expect(summarizeCallFailures([say('先读一下'), fail('401', 'error')]).failed).toBe(true)
  })

  it('最后一条助手消息 stopReason=stop → 前面失败过也算自愈', () => {
    const recovered = stopped('最终答案', 'stop')
    expect(summarizeCallFailures([fail('timeout', 'error'), recovered]).failed).toBe(false)
  })

  it('stopReason=error 但之后还有成功的工具调用 → 自愈', () => {
    expect(
      summarizeCallFailures([fail('timeout', 'error'), tool('t1', 'ok')]).failed
    ).toBe(false)
  })

  it('error 结束但没有 errorMessage 也算轮次失败（红框有兜底文案）', () => {
    const bareError: StreamItem = {
      kind: 'message',
      role: 'assistant',
      text: '',
      stopReason: 'error'
    }
    const summary = summarizeCallFailures([bareError])
    expect(summary.failed).toBe(true)
    expect(summary.runs).toEqual([])
  })

  it('stopReason=toolUse / length 不算失败', () => {
    const toolUse = stopped('', 'toolUse')
    const length = stopped('说到一半', 'length')
    expect(summarizeCallFailures([toolUse]).failed).toBe(false)
    expect(summarizeCallFailures([fail('timeout'), length]).failed).toBe(false)
  })
})


describe('按轮切分给终端排版用', () => {
  it('两轮：中途失败后成功 vs 只有失败', () => {
    const items: StreamItem[] = [
      { kind: 'message', role: 'user', text: '第一问' },
      fail('timeout', 'error'),
      { kind: 'message', role: 'assistant', text: '好了', stopReason: 'stop' },
      { kind: 'message', role: 'user', text: '第二问' },
      fail('401', 'error')
    ]
    const turns = callFailureTurns(items)
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ start: 0, end: 3, failed: false, aborted: false })
    expect(turns[0].runs.map((run) => run.count)).toEqual([1])
    expect(turns[1]).toMatchObject({ start: 3, end: 5, failed: true })
    // 失败段的下标是全局的，终端按它决定在哪一行画
    expect(turns[1].runs[0].start).toBe(4)
  })

  it('中止的轮次在终端也不出灰字、不出红字', () => {
    const items: StreamItem[] = [
      { kind: 'message', role: 'user', text: '问' },
      { kind: 'message', role: 'assistant', text: '', errorMessage: 'x', aborted: true }
    ]
    expect(callFailureTurns(items)[0]).toMatchObject({ failed: false, aborted: true })
  })

  it('开头没有用户消息的错误也会归到一轮里', () => {
    const items = [fail('timeout', 'error')]
    const turns = callFailureTurns(items)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ start: 0, end: 1, failed: true })
  })
})

describe('失败类型标题', () => {
  it('鉴权 / 连接 / 额度 / 其它', () => {
    expect(errorTitle('401 Unauthorized')).toBe('模型鉴权失败')
    expect(errorTitle('ECONNRESET')).toBe('模型连接失败')
    expect(errorTitle('402 insufficient quota')).toBe('模型额度不足')
    expect(errorTitle('something went wrong')).toBe('模型请求失败')
  })
})
