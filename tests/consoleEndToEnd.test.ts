import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import debugConsoleExtension from '../ext/debug-console'
import { DebugConsoleStore } from '../host/main/debugConsole'

/** 端到端：扩展采到的东西，存进去能原样读回来 */
describe('控制台端到端', () => {
  it('扩展 → 存储 → 按字段读回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-e2e-'))
    const store = new DebugConsoleStore(dir)
    let record: unknown = null
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
    const pi = {
      on(event: string, callback: (event: unknown, ctx: unknown) => void) {
        handlers.set(event, callback)
        return () => {}
      },
      events: {
        emit(_channel: string, data: unknown) {
          record = data
        }
      }
    } as unknown as Parameters<typeof debugConsoleExtension>[0]

    debugConsoleExtension(pi)
    const ctx = {
      sessionManager: { getSessionId: () => 's1', getSessionName: () => '会话' },
      model: { provider: 'anthropic', id: 'claude-x' }
    }
    handlers.get('context_with_system')!({ messages: [{ role: 'user', content: '你好' }] }, ctx)
    handlers.get('before_provider_request')!({ payload: { model: 'claude-x', messages: [] } }, ctx)
    handlers.get('after_provider_response')!({ status: 200, headers: {} }, ctx)
    handlers.get('message_end')!({ message: { role: 'assistant', content: '在' } }, ctx)

    store.enqueue(record as never)
    for (let i = 0; i < 50; i += 1) {
      if (store.status().writing === 0) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const list = store.list()
    expect(list.records).toHaveLength(1)
    expect(list.records[0]!.sessionName).toBe('会话')
    const shell = store.readField(list.records[0]!.id, 'transcript')
    expect(shell?.shell?.array?.items[0]!.role).toBe('user')
    expect(store.readField(list.records[0]!.id, 'provider')?.shell?.fields.model).toBe('claude-x')
  })
})
