import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextDiffStore, type RawContextSnapshot } from '../host/main/contextDiff'
import type { StreamItem } from '@contract/index'

const dirs: string[] = []

function store(dir: string | null = null): ContextDiffStore {
  return new ContextDiffStore(dir)
}

function snapshot(
  sessionId: string,
  requestText: string,
  extra: string[] = [],
  sessionFile: string | null = '/tmp/session.jsonl'
): RawContextSnapshot {
  return {
    sessionId,
    sessionFile,
    sessionName: sessionId,
    capturedAt: Date.now(),
    toolsHash: 'tools',
    messages: [
      { key: 's', role: 'system', text: 'system', hash: 'sys', tokens: 2, preview: 'system' },
      { key: 'u1', role: 'user', text: 'first', hash: 'u1', tokens: 2, preview: 'first' },
      ...extra.map((text, index) => ({
        key: `u${index + 2}`,
        role: 'user',
        text,
        hash: text,
        tokens: 2,
        preview: text
      })),
      { key: 'a', role: 'assistant', text: requestText, hash: requestText, tokens: 2, preview: requestText }
    ]
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('上下文快照 diff', () => {
  it('同会话默认对比上一次请求，只把新消息算成新增', () => {
    const s = store()
    s.capture('tab-1', snapshot('s1', 'a1'))
    s.capture('tab-1', snapshot('s1', 'a2', ['second']))

    const view = s.getView('tab-1')
    expect(view?.current.request).toBe(2)
    expect(view?.baseline?.request).toBe(1)
    expect(view?.counts.added).toBe(2) // second + a2
    expect(view?.counts.removed).toBe(1) // a1
    expect(view?.system).toBe('same')
    expect(view?.tokens.after).toBeGreaterThan(view?.tokens.before ?? 0)
  })

  it('跨会话按 hash 分共享/仅基线/仅当前', () => {
    const s = store()
    s.capture('tab-1', snapshot('s1', 'a1', ['only-a']))
    s.capture('tab-2', snapshot('s2', 'b1', []))

    const sessions = s.listSessions()
    expect(sessions).toHaveLength(2)
    const view = s.getView('tab-2', 's1:1')
    expect(view?.counts.shared).toBe(1) // 只有 u1 相同；system 已单独处理
    expect(view?.counts.added).toBe(1)
    expect(view?.counts.removed).toBe(2)
    expect(view?.groups.find((group) => group.kind === 'added')?.label).toBe('仅当前')
    expect(view?.groups.find((group) => group.kind === 'removed')?.label).toBe('仅基线')
  })

  it('缩略图内容可按 key 取全文；持久化后只留 preview', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-context-diff-'))
    dirs.push(dir)
    const first = store(dir)
    first.capture('tab-1', snapshot('s1', 'answer'))

    expect(first.detail('tab-1', 's1:1', 'a')).toEqual({ text: 'answer', truncated: false })
    expect(first.listSessions()[0].last?.id).toBe('s1:1')

    const second = store(dir)
    expect(second.listSessions()).toHaveLength(1)
    expect(second.detail('tab-1', 's1:1', 'a')).toBeNull()
  })

  it('没有请求快照时可以从会话历史重建近似对比', () => {
    const s = store()
    const items: StreamItem[] = [
      { kind: 'message', role: 'user', text: '第一轮' },
      { kind: 'message', role: 'assistant', text: '第一轮回答' },
      { kind: 'message', role: 'user', text: '第二轮' },
      { kind: 'message', role: 'assistant', text: '第二轮回答' }
    ]
    const view = s.approximate('tab-1', 's1', '/tmp/session.jsonl', '测试会话', items)
    expect(view?.approximate).toBe(true)
    expect(view?.baseline).not.toBeNull()
    expect(view?.counts.added).toBeGreaterThan(0)
    expect(view?.groups.find((group) => group.kind === 'added')?.messages[0].preview).toContain('第二轮')
    expect(view?.system).toBe('unknown')
    expect(view?.tools).toBe('unknown')
    expect(s.listSnapshots('tab-1')).toHaveLength(2)
    const selected = s.getView('tab-1', 'approx:s1:1')
    expect(selected?.approximate).toBe(true)
    expect(selected?.baseline?.id).toBe('approx:s1:1')
    expect(selected?.counts.added).toBeGreaterThan(0)
  })

  it('删除会话时清掉对应索引', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-context-diff-'))
    dirs.push(dir)
    const s = store(dir)
    s.capture('tab-1', snapshot('s1', 'answer', [], '/tmp/a.jsonl'))
    s.capture('tab-2', snapshot('s2', 'answer', [], '/tmp/b.jsonl'))
    expect(s.listSessions()).toHaveLength(2)

    s.deleteBySessionPath('/tmp/a.jsonl')
    expect(s.listSessions().map((session) => session.sessionId)).toEqual(['s2'])
  })
})
