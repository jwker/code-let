import { describe, expect, it } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import debugConsole from '../ext/debug-console'

/**
 * 调试控制台的采集扩展。
 *
 * 一次请求由四个钩子拼起来：context_with_system 起头，
 * before_provider_request 补 payload，after_provider_response 补状态码，
 * message_end（助手消息）收尾。中间任何一环缺失都不该把记录丢掉。
 */

interface Handler {
  (event: unknown, ctx: unknown): void
}

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler>; emitted: unknown[] } {
  const handlers = new Map<string, Handler>()
  const emitted: unknown[] = []
  const pi = {
    on(event: string, callback: Handler) {
      handlers.set(event, callback)
      return () => {}
    },
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data })
      }
    }
  } as unknown as ExtensionAPI
  return { pi, handlers, emitted }
}

const ctx = {
  sessionManager: {
    getSessionId: () => 'session-1',
    getSessionName: () => '调试会话'
  },
  model: { provider: 'anthropic', id: 'claude-x' }
}

describe('debug-console 内置扩展', () => {
  it('四个钩子拼出一条完整记录', () => {
    const { pi, handlers, emitted } = fakePi()
    debugConsole(pi)

    handlers.get('context_with_system')!(
      { messages: [{ role: 'system', content: 'you are pi' }] },
      ctx
    )
    handlers.get('before_provider_request')!({ payload: { model: 'claude-x' } }, ctx)
    handlers.get('after_provider_response')!(
      { status: 200, headers: { 'content-type': 'application/json', authorization: 'Bearer secret' } },
      ctx
    )
    handlers.get('message_end')!(
      { message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
      ctx
    )

    expect(emitted).toHaveLength(1)
    const payload = (emitted[0] as { channel: string; data: Record<string, unknown> }).data
    expect((emitted[0] as { channel: string }).channel).toBe('debug-console:record')
    expect(payload.sessionId).toBe('session-1')
    expect(payload.sessionName).toBe('调试会话')
    // 标题：自定义名字优先，没有就取首条用户消息
    expect(payload.sessionTitle).toBe('调试会话')
    expect(payload.transcript).toMatchObject({ messages: [{ role: 'system' }] })
    expect(payload.provider).toMatchObject({ model: 'claude-x' })
    expect(payload.response).toMatchObject({ status: 200 })

    // 时间点：请求发出 → 收到响应头 → 消息定稿
    const timing = (payload as { timing: { startedAt: number; headersAt: number; endedAt: number } })
      .timing
    expect(timing.startedAt).toBeGreaterThan(0)
    expect(timing.headersAt).toBeGreaterThanOrEqual(timing.startedAt)
    expect(timing.endedAt).toBeGreaterThanOrEqual(timing.headersAt)

    // 凭据类的响应头不留
    const response = payload.response as { headers: Record<string, string> }
    expect(response.headers.authorization).toBeUndefined()
    expect(response.headers['content-type']).toBe('application/json')
  })

  it('没有自定义名字时，标题取首条用户消息', () => {
    const { pi, handlers, emitted } = fakePi()
    const withoutName = {
      sessionManager: {
        getSessionId: () => 'session-2',
        getSessionName: () => undefined
      },
      model: { provider: 'anthropic', id: 'claude-x' }
    }
    debugConsole(pi)
    handlers.get('context_with_system')!(
      {
        messages: [
          { role: 'system', content: 'you are pi' },
          { role: 'user', content: [{ type: 'text', text: '帮我看看\n这个报错' }] }
        ]
      },
      withoutName
    )
    handlers.get('message_end')!({ message: { role: 'assistant', content: '好' } }, withoutName)
    const payload = (emitted[0] as { data: Record<string, unknown> }).data
    expect(payload.sessionName).toBeNull()
    expect(payload.sessionTitle).toBe('帮我看看 这个报错')
  })

  it('用户消息的 message_end 不收尾', () => {
    const { pi, handlers, emitted } = fakePi()
    debugConsole(pi)

    handlers.get('context_with_system')!({ messages: [] }, ctx)
    handlers.get('message_end')!({ message: { role: 'user', content: '你好' } }, ctx)
    expect(emitted).toHaveLength(0)

    handlers.get('message_end')!({ message: { role: 'assistant', content: '好' } }, ctx)
    expect(emitted).toHaveLength(1)
  })

  it('请求失败时（没有助手消息）下一次请求会先把上一条记下来', () => {
    const { pi, handlers, emitted } = fakePi()
    debugConsole(pi)

    handlers.get('context_with_system')!({ messages: [] }, ctx)
    // provider 报错 —— 没有 message_end
    handlers.get('context_with_system')!({ messages: [] }, ctx)
    expect(emitted).toHaveLength(1)

    handlers.get('message_end')!({ message: { role: 'assistant', content: '好' } }, ctx)
    expect(emitted).toHaveLength(2)
  })
})
