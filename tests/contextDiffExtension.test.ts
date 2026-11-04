import { describe, expect, it } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import contextDiffExtension from '../ext/context-diff'

describe('context-diff 内置扩展', () => {
  it('把 context_with_system 压成带 preview 的快照，不携带图片 base64', () => {
    const emitted: Array<{ channel: string; data: unknown }> = []
    let handler: ((event: unknown, ctx: unknown) => void) | null = null
    const pi = {
      on(event: string, callback: (event: unknown, ctx: unknown) => void) {
        if (event === 'context_with_system') handler = callback
        return () => {}
      },
      events: {
        emit(channel: string, data: unknown) {
          emitted.push({ channel, data })
        }
      },
      getActiveTools: () => ['read'],
      getAllTools: () => [
        { name: 'read', description: 'read a file', parameters: { type: 'object' }, promptGuidelines: [] }
      ]
    } as unknown as ExtensionAPI

    contextDiffExtension(pi)
    expect(handler).not.toBeNull()

    handler!(
      {
        messages: [
          { role: 'system', content: 'you are pi' },
          { role: 'user', content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image', data: 'large-base64', mimeType: 'image/png' }
          ] },
          { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }] }
        ]
      },
      {
        sessionManager: {
          getSessionId: () => 'session-1',
          getSessionFile: () => '/tmp/session.jsonl',
          getSessionName: () => '测试会话'
        }
      }
    )

    expect(emitted).toHaveLength(1)
    expect(emitted[0].channel).toBe('context-diff:snapshot')
    const data = emitted[0].data as {
      sessionId: string
      sessionName: string
      toolsHash: string | null
      messages: Array<{ role: string; text: string; preview: string; tokens: number }>
    }
    expect(data.sessionId).toBe('session-1')
    expect(data.sessionName).toBe('测试会话')
    expect(data.toolsHash).toBeTruthy()
    expect(data.messages[1].text).toContain('[image]')
    expect(data.messages[1].text).not.toContain('large-base64')
    expect(data.messages[1].preview).toContain('看看这张图')
    expect(data.messages[2].text).toBe('[tool: read]')
  })
})
