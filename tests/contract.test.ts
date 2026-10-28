import { describe, expect, it } from 'vitest'
import { IPC, IPC_EVENTS, MAX_PAYLOAD_BYTES } from '@contract/index'
import { promptSchema, switchConversationSchema, switchProjectSchema } from '@contract/schemas'

describe('IPC 规格', () => {
  it('通道名互不重复', () => {
    const channels = [...Object.values(IPC), ...Object.values(IPC_EVENTS)]
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('载荷 schema 拒绝空路径', () => {
    expect(switchProjectSchema.safeParse({ path: '' }).success).toBe(false)
    expect(switchConversationSchema.safeParse({ path: '' }).success).toBe(false)
    expect(switchProjectSchema.safeParse({ path: '/tmp' }).success).toBe(true)
  })

  it('载荷 schema 拒绝空消息', () => {
    expect(promptSchema.safeParse({ text: '' }).success).toBe(false)
    expect(promptSchema.safeParse({ text: 'hi' }).success).toBe(true)
  })

  it('载荷上限是有限值', () => {
    expect(MAX_PAYLOAD_BYTES).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_PAYLOAD_BYTES)).toBe(true)
  })
})
