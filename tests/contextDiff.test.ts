import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextDiffStore, type RawContextSnapshot } from '../host/main/contextDiff'

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
  it('同会话默认对比上一次请求', () => {
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

  it('按轮次取截至该轮的最后两次请求', () => {
    const s = store()
    s.capture('tab-1', snapshot('s1', 'a1'))
    s.capture('tab-1', snapshot('s1', 'a2', ['second']))
    s.capture('tab-1', snapshot('s1', 'a3', ['second', 'third']))

    const first = s.getViewForTurn('tab-1', 1)
    expect(first?.current.request).toBe(1)
    expect(first?.baseline).toBeNull()

    const second = s.getViewForTurn('tab-1', 2)
    expect(second?.current.request).toBe(2)
    expect(second?.baseline?.request).toBe(1)

    const latest = s.getViewForTurn('tab-1', 99)
    expect(latest?.current.request).toBe(3)
    expect(latest?.baseline?.request).toBe(2)
  })

  it('同会话同位置、同角色的内容变化算修改', () => {
    const s = store()
    s.capture('tab-1', snapshot('s1', 'a1'))
    s.capture('tab-1', snapshot('s1', 'a2'))

    const view = s.getView('tab-1')
    expect(view?.counts.added).toBe(0)
    expect(view?.counts.removed).toBe(0)
    expect(view?.counts.modified).toBe(1)
    expect(view?.counts.shared).toBe(1)
    const modified = view?.groups.find((group) => group.kind === 'modified')
    expect(modified?.label).toBe('修改')
    expect(modified?.messages[0].preview).toBe('a2')
    expect(modified?.messages[0].previousKey).toBe('a')
    expect(modified?.messages[0].previousPreview).toBe('a1')
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

  it('重启后从会话文件回源全文', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-context-diff-'))
    dirs.push(dir)
    const sessionFile = join(dir, 'session.jsonl')
    const text = '重启后仍能读到的回答'
    const hash = createHash('sha256').update(`assistant\u0000${text}`).digest('hex').slice(0, 24)
    const raw = snapshot('s1', 'placeholder', [], sessionFile)
    raw.messages[raw.messages.length - 1] = {
      key: 'a',
      role: 'assistant',
      text,
      hash,
      tokens: 2,
      preview: text
    }
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      })}\n`
    )

    store(dir).capture('tab-1', raw)
    const second = store(dir)
    expect(second.detail('tab-1', 's1:1', 'a')).toEqual({ text, truncated: false })
  })

  it('没有会话文件时持久化后只留 preview', () => {
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

  it('压缩摘要单独成组，不混在新增里', () => {
    const s = store()
    s.capture('tab-1', snapshot('s1', 'a1'))
    const current = snapshot('s1', 'a2', ['second'])
    current.messages.push({
      key: 'summary',
      role: 'compactionSummary',
      text: '压缩摘要正文',
      hash: 'summary',
      tokens: 3,
      preview: '压缩摘要正文'
    })
    s.capture('tab-1', current)

    const view = s.getView('tab-1')
    const compacted = view?.groups.find((group) => group.kind === 'compacted')
    expect(compacted?.label).toBe('上下文被压缩')
    expect(compacted?.messages[0].role).toBe('compactionSummary')
    expect(
      view?.groups.find((group) => group.kind === 'added')?.messages.some(
        (message) => message.role === 'compactionSummary'
      )
    ).toBe(false)
    expect(s.detail('tab-1', view!.current.id, 'summary')).toEqual({
      text: '压缩摘要正文',
      truncated: false
    })
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
