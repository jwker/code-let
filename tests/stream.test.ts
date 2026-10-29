import { describe, expect, it } from 'vitest'
import type { StreamItem } from '@contract/index'
import { applyEvent, entriesToItems, trimMessageUpdate } from '@contract/stream'

/**
 * 两条来源必须收敛到同一份内容流（.ai/task.md · R1 R2 R5）：
 *
 *   历史：会话文件里的 entry  → entriesToItems()
 *   实时：Pi 的会话事件        → applyEvent()
 *
 * 这份 fixture 就是那一段对话，两条路各自走一遍，结果必须一模一样。
 */

const USER_TEXT = '把记忆索引改成增量更新'
const ASSISTANT_TEXT = '好的。我先读了现有的索引实现，'
const LAST_TEXT = '改完了'

/** 一条助手回复的用量 —— 两条来源给的是同一份 */
const USAGE = { input: 6214, output: 93, cacheRead: 189, cacheWrite: 0 }
const DURATION_MS = 4044
const TIMESTAMP = 1793269598527

/** 会话文件里的样子 */
const ENTRIES = [
  { type: 'message', message: { role: 'user', content: USER_TEXT } },
  {
    type: 'message',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: ASSISTANT_TEXT },
        { type: 'toolCall', id: 't1', name: 'read' },
        { type: 'toolCall', id: 't2', name: 'bash' }
      ],
      usage: USAGE,
      durationMs: DURATION_MS,
      timestamp: TIMESTAMP
    }
  },
  {
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: 't1',
      isError: false,
      content: [{ type: 'text', text: 'src/memory/index.ts' }]
    }
  },
  {
    type: 'message',
    message: {
      role: 'toolResult',
      toolCallId: 't2',
      isError: false,
      content: [{ type: 'text', text: '42 passed / 42' }]
    }
  },
  { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: LAST_TEXT }] } },
  // 不是消息的条目（用量、模型切换）不该出现在内容流里
  { type: 'model_change', provider: 'anthropic', modelId: 'claude-sonnet' },
  { type: 'usage', kind: 'turn', provider: 'anthropic', model: 'claude-sonnet', usage: { input: 10, output: 20 } }
]

/** 实时事件的样子（message_update 已经是削过载荷的） */
const EVENTS = [
  { type: 'message_start', data: { message: { role: 'user', content: USER_TEXT } } },
  { type: 'message_start', data: { message: { role: 'assistant', content: [] } } },
  {
    type: 'message_update',
    data: { type: 'text_delta', contentIndex: 0, delta: ASSISTANT_TEXT }
  },
  {
    type: 'message_end',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: ASSISTANT_TEXT },
          { type: 'toolCall', id: 't1', name: 'read' },
          { type: 'toolCall', id: 't2', name: 'bash' }
        ],
        usage: USAGE,
        durationMs: DURATION_MS,
        timestamp: TIMESTAMP
      }
    }
  },
  { type: 'tool_execution_start', data: { toolCallId: 't1', toolName: 'read' } },
  { type: 'tool_execution_end', data: { toolCallId: 't1', toolName: 'read', isError: false } },
  { type: 'tool_execution_start', data: { toolCallId: 't2', toolName: 'bash' } },
  { type: 'tool_execution_end', data: { toolCallId: 't2', toolName: 'bash', isError: false } },
  {
    type: 'message_start',
    data: {
      message: {
        role: 'toolResult',
        toolCallId: 't1',
        content: [{ type: 'text', text: 'src/memory/index.ts' }]
      }
    }
  },
  {
    type: 'message_start',
    data: {
      message: {
        role: 'toolResult',
        toolCallId: 't2',
        content: [{ type: 'text', text: '42 passed / 42' }]
      }
    }
  },
  { type: 'message_start', data: { message: { role: 'assistant', content: [] } } },
  { type: 'message_update', data: { type: 'text_delta', contentIndex: 0, delta: LAST_TEXT } },
  {
    type: 'message_end',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: LAST_TEXT }] } }
  }
]

const EXPECTED: StreamItem[] = [
  { kind: 'message', role: 'user', text: USER_TEXT },
  {
    kind: 'message',
    role: 'assistant',
    text: ASSISTANT_TEXT,
    stats: { ...USAGE, startedAt: TIMESTAMP, durationMs: DURATION_MS }
  },
  { kind: 'tool', callId: 't1', name: 'read', status: 'ok' },
  { kind: 'tool', callId: 't2', name: 'bash', status: 'ok' },
  { kind: 'message', role: 'toolResult', text: 'src/memory/index.ts', callId: 't1' },
  { kind: 'message', role: 'toolResult', text: '42 passed / 42', callId: 't2' },
  { kind: 'message', role: 'assistant', text: LAST_TEXT }
]

describe('内容流的两条来源', () => {
  it('历史：会话文件里的 entry 变成内容流', () => {
    expect(entriesToItems(ENTRIES)).toEqual(EXPECTED)
  })

  it('实时：会话事件落成同一份内容流', () => {
    let items: StreamItem[] = []
    for (const event of EVENTS) {
      items = applyEvent(items, event)
    }
    expect(items).toEqual(EXPECTED)
  })

  it('两条路收敛到同一个结果', () => {
    let live: StreamItem[] = []
    for (const event of EVENTS) {
      live = applyEvent(live, event)
    }
    expect(live).toEqual(entriesToItems(ENTRIES))
  })

  it('工具失败要标成 error', () => {
    const items = entriesToItems([
      {
        type: 'message',
        message: {
          role: 'toolResult',
          toolCallId: 't1',
          isError: true,
          content: [{ type: 'text', text: 'boom' }]
        }
      }
    ])
    expect(items).toEqual([{ kind: 'message', role: 'toolResult', text: 'boom', callId: 't1' }])
  })
})

describe('工具行上显示的摘要（R4）', () => {
  it('bash 的命令被摘出来，其他工具不摘', () => {
    const items = entriesToItems([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'npm test' } },
            { type: 'toolCall', id: 'g1', name: 'grep', arguments: { pattern: 'foo' } }
          ]
        }
      }
    ])
    expect(items).toEqual([
      { kind: 'tool', callId: 'b1', name: 'bash', status: 'running', label: 'npm test' },
      { kind: 'tool', callId: 'g1', name: 'grep', status: 'running' }
    ])
  })

  it('实时流里也是同一个来源', () => {
    const items = applyEvent([], {
      type: 'message_end',
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'b1', name: 'bash', arguments: { command: 'npm test' } }]
        }
      }
    })
    expect(items).toEqual([
      { kind: 'tool', callId: 'b1', name: 'bash', status: 'running', label: 'npm test' }
    ])
  })
})

describe('工具跑到一半的输出（R4）', () => {
  /** 助手说要跑一条命令，工具刚开始跑 */
  const BEFORE = [
    { type: 'message_start', data: { message: { role: 'assistant', content: [] } } },
    {
      type: 'message_update',
      data: { type: 'text_delta', contentIndex: 0, delta: '我跑一下' }
    },
    {
      type: 'message_end',
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我跑一下' },
            { type: 'toolCall', id: 'b1', name: 'bash' }
          ]
        }
      }
    },
    { type: 'tool_execution_start', data: { toolCallId: 'b1', toolName: 'bash' } }
  ]

  const update = (text: string) => ({
    type: 'tool_execution_update',
    data: {
      toolCallId: 'b1',
      toolName: 'bash',
      partialResult: { content: [{ type: 'text', text }] }
    }
  })

  const run = (events: readonly { type: string; data: unknown }[]): StreamItem[] => {
    let items: StreamItem[] = []
    for (const event of events) items = applyEvent(items, event)
    return items
  }

  it('中途输出边跑边出现，工具 chip 还是 running', () => {
    const items = run([...BEFORE, update('第一行\n')])
    expect(items).toEqual([
      { kind: 'message', role: 'assistant', text: '我跑一下' },
      { kind: 'tool', callId: 'b1', name: 'bash', status: 'running' },
      { kind: 'message', role: 'toolResult', text: '第一行\n', callId: 'b1' }
    ])
  })

  it('中途输出越跑越长，是同一项在长', () => {
    const items = run([...BEFORE, update('第一行\n'), update('第一行\n第二行\n')])
    const outputs = items.filter((item) => item.kind === 'message' && item.role === 'toolResult')
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toEqual({
      kind: 'message',
      role: 'toolResult',
      text: '第一行\n第二行\n',
      callId: 'b1'
    })
  })

  it('工具跑完的最终输出接在同一项上，不叠成两块', () => {
    const items = run([
      ...BEFORE,
      update('第一行\n'),
      {
        type: 'message_start',
        data: {
          message: {
            role: 'toolResult',
            toolCallId: 'b1',
            content: [{ type: 'text', text: '第一行\n第二行\n' }]
          }
        }
      },
      {
        type: 'message_end',
        data: {
          message: {
            role: 'toolResult',
            toolCallId: 'b1',
            content: [{ type: 'text', text: '第一行\n第二行\n' }]
          }
        }
      },
      { type: 'tool_execution_end', data: { toolCallId: 'b1', toolName: 'bash', isError: false } }
    ])
    expect(items).toEqual([
      { kind: 'message', role: 'assistant', text: '我跑一下' },
      { kind: 'tool', callId: 'b1', name: 'bash', status: 'ok' },
      { kind: 'message', role: 'toolResult', text: '第一行\n第二行\n', callId: 'b1' }
    ])
  })
})

describe('元信息（token 与耗时）', () => {
  it('正文的那条助手消息带着计量', () => {
    const items = entriesToItems([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '改完了' }],
          usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 5 },
          durationMs: 1500,
          timestamp: 1700000000000
        }
      }
    ])
    expect(items).toEqual([
      {
        kind: 'message',
        role: 'assistant',
        text: '改完了',
        stats: {
          input: 100,
          output: 20,
          cacheRead: 300,
          cacheWrite: 5,
          durationMs: 1500,
          startedAt: 1700000000000
        }
      }
    ])
  })

  it('只有工具调用、没有正文的那一轮不留元信息', () => {
    const items = entriesToItems([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'b1', name: 'bash' }],
          usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
          durationMs: 900
        }
      }
    ])
    expect(items).toEqual([{ kind: 'tool', callId: 'b1', name: 'bash', status: 'running' }])
  })

  it('两条来源给的是同一份计量（R3）', () => {
    const usage = { input: 6214, output: 93, cacheRead: 189, cacheWrite: 0 }
    const fromHistory = entriesToItems([
      {
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '好的' }],
          usage,
          durationMs: 4044,
          timestamp: 1793269598527
        }
      }
    ])

    const live = applyEvent(
      [
        {
          kind: 'message',
          role: 'assistant',
          text: '',
          stats: { ...usage, startedAt: 1793269598527 }
        }
      ],
      {
        type: 'message_end',
        data: {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '好的' }],
            usage,
            durationMs: 4044,
            timestamp: 1793269598527
          }
        }
      }
    )
    expect(live).toEqual(fromHistory)
  })
})

describe('削载荷（PLAN.md D5 补充）', () => {
  it('message_update 只留增量，不留整条消息', () => {
    const original = {
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: '一点' }
    }
    const trimmed = trimMessageUpdate(original) as Record<string, unknown>
    expect(trimmed).toEqual({ type: 'text_delta', contentIndex: 0, delta: '一点' })
    expect(JSON.stringify(trimmed).length).toBeLessThan(JSON.stringify(original).length / 100)
  })

  it('别的载荷原样放过', () => {
    const data = { toolCallId: 't1', toolName: 'read' }
    expect(trimMessageUpdate(data)).toBe(data)
  })
})
