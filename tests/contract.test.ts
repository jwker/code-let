import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS, IPC, IPC_EVENTS, MAX_PAYLOAD_BYTES } from '@contract/index'
import { promptSchema, tabIdSchema, tabNewSchema, tabOpenSchema, conversationRenameSchema } from '@contract/schemas'

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

  it('prompt 允许附件路径数组，但数量不能超过上限', () => {
    expect(promptSchema.safeParse({ tabId: 't', text: 'hi', attachments: ['src/a.ts'] }).success).toBe(true)
    expect(promptSchema.safeParse({ tabId: 't', text: 'hi', attachments: [''] }).success).toBe(false)
    expect(
      promptSchema.safeParse({
        tabId: 't',
        text: 'hi',
        attachments: Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, (_, index) => `f${index}.ts`)
      }).success
    ).toBe(false)
  })

  it('载荷上限是有限值', () => {
    expect(MAX_PAYLOAD_BYTES).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_PAYLOAD_BYTES)).toBe(true)
  })

  it('改名允许空名字（清掉自定义名），拒绝空路径和过长名字', () => {
    expect(conversationRenameSchema.safeParse({ path: '/a.jsonl', name: '' }).success).toBe(true)
    expect(conversationRenameSchema.safeParse({ path: '', name: 'x' }).success).toBe(false)
    expect(conversationRenameSchema.safeParse({ path: '/a.jsonl', name: 'x'.repeat(80) }).success).toBe(true)
    expect(conversationRenameSchema.safeParse({ path: '/a.jsonl', name: 'x'.repeat(81) }).success).toBe(false)
  })
})
