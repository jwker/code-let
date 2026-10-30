import { describe, expect, it } from 'vitest'
import { IPC, IPC_EVENTS, MAX_PAYLOAD_BYTES } from '@contract/index'
import { promptSchema, tabIdSchema, tabNewSchema, tabOpenSchema } from '@contract/schemas'

describe('IPC 规格', () => {
  it('通道名互不重复', () => {
    const channels = [...Object.values(IPC), ...Object.values(IPC_EVENTS)]
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('载荷 schema 拒绝空路径', () => {
    expect(tabOpenSchema.safeParse({ path: '', cwd: '/tmp' }).success).toBe(false)
    expect(tabOpenSchema.safeParse({ path: '/a.jsonl', cwd: '' }).success).toBe(false)
    expect(tabOpenSchema.safeParse({ path: '/a.jsonl', cwd: '/tmp' }).success).toBe(true)
    expect(tabNewSchema.safeParse({ cwd: '/tmp' }).success).toBe(true)
  })

  it('载荷 schema 拒绝空标签 id', () => {
    expect(tabIdSchema.safeParse({ tabId: '' }).success).toBe(false)
    expect(tabIdSchema.safeParse({ tabId: 'tab-1' }).success).toBe(true)
  })

  it('载荷 schema 拒绝空消息', () => {
    expect(promptSchema.safeParse({ tabId: 'tab-1', text: '' }).success).toBe(false)
    expect(promptSchema.safeParse({ tabId: '', text: 'hi' }).success).toBe(false)
    expect(promptSchema.safeParse({ tabId: 'tab-1', text: 'hi' }).success).toBe(true)
  })

  it('载荷上限是有限值', () => {
    expect(MAX_PAYLOAD_BYTES).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_PAYLOAD_BYTES)).toBe(true)
  })
})
