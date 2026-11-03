import { describe, expect, it } from 'vitest'
import type { StreamItem } from '@contract/index'
import { navTurnSummary, userTurnsOf } from '../host/renderer/src/conversation/conversationTurns'

/**
 * 对话导航的轮次提取（PLAN.md D36）。
 *
 * 导航只认用户消息；正文里的 `<file>` 附件块不能进入摘要，文件名单独留下。
 */
describe('对话导航的轮次', () => {
  const items: StreamItem[] = [
    { kind: 'message', role: 'user', text: '第一轮' },
    { kind: 'message', role: 'assistant', text: '好' },
    { kind: 'message', role: 'user', text: '看下\n\n<file name="src/a.ts">\nexport const a = 1\n</file>' },
    { kind: 'tool', callId: 'c1', name: 'read', status: 'ok' },
    { kind: 'message', role: 'user', text: '<file name="pic.png"></file>' },
    { kind: 'message', role: 'assistant', text: '收到' }
  ]

  it('只取用户消息，保留它们在完整内容流里的下标', () => {
    expect(userTurnsOf(items)).toEqual([
      { index: 0, text: '第一轮', files: [] },
      { index: 2, text: '看下', files: ['src/a.ts'] },
      { index: 4, text: '', files: ['pic.png'] }
    ])
  })

  it('去重附件名；没有用户消息时为空', () => {
    const duplicate: StreamItem[] = [
      {
        kind: 'message',
        role: 'user',
        text: '<file name="a.ts"></file>\n<file name="a.ts"></file>'
      }
    ]
    expect(userTurnsOf(duplicate)[0].files).toEqual(['a.ts'])
    expect(userTurnsOf([{ kind: 'message', role: 'assistant', text: '只有助手' }])).toEqual([])
  })

  it('卡片摘要标轮次，空消息也能读', () => {
    expect(navTurnSummary({ index: 0, text: '第一轮', files: [] }, 1)).toBe('第 1 轮：第一轮')
    expect(navTurnSummary({ index: 0, text: '', files: ['a.ts'] }, 2)).toBe(
      '第 2 轮：（无文字，含附件）'
    )
    expect(navTurnSummary({ index: 0, text: 'x'.repeat(100), files: [] }, 3)).toHaveLength(
      '第 3 轮：'.length + 80
    )
  })
})
