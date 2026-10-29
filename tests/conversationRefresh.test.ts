import { describe, expect, it, vi } from 'vitest'
import { affectsConversationList, DebouncedRefresh } from '../host/main/conversationRefresh'

/**
 * 对话列表是从磁盘上的会话文件重读的（Pi 的会话文件是权威）。
 *
 * 新会话的 .jsonl 要等**第一条用户消息**落盘才出现 ——
 * SDK 的 _hasConversation() 规定：没说过话的会话不建文件。
 * 所以刷新时机必须挂在「用户消息写盘」那一刻，
 * 挂错了就出现这个 bug：新会话聊完了也不在列表里，
 * 切到别的会话（那里无条件刷新一次）才冒出来。
 */
describe('对话列表的刷新时机', () => {
  it('用户消息结束要刷新 —— 新会话这时候才第一次落盘', () => {
    expect(affectsConversationList({ type: 'message_end', data: { message: { role: 'user' } } })).toBe(true)
  })

  it('助手消息和工具结果不单独触发 —— 跟在用户消息同一个文件里', () => {
    expect(affectsConversationList({ type: 'message_end', data: { message: { role: 'assistant' } } })).toBe(false)
    expect(affectsConversationList({ type: 'message_end', data: { message: { role: 'toolResult' } } })).toBe(false)
  })

  it('一轮结束要刷新 —— 最后一条消息的时间才定下来（列表按它排序）', () => {
    expect(affectsConversationList({ type: 'agent_settled', data: { aborted: false } })).toBe(true)
  })

  it('改名和追加条目要刷新', () => {
    expect(affectsConversationList({ type: 'session_info_changed', data: { name: '新名字' } })).toBe(true)
    expect(affectsConversationList({ type: 'entry_appended', data: { entry: {} } })).toBe(true)
  })

  it('流式增量不算 —— 每来一个 token 都扫一遍盘太贵', () => {
    expect(affectsConversationList({ type: 'message_update', data: { type: 'text_delta', delta: 'x' } })).toBe(false)
    expect(affectsConversationList({ type: 'message_start', data: { message: { role: 'assistant' } } })).toBe(false)
    expect(affectsConversationList({ type: 'tool_execution_start', data: {} })).toBe(false)
  })

  it('载荷不认识时按不刷新处理 —— 宁可漏一次，也不要每个事件都扫盘', () => {
    expect(affectsConversationList({ type: 'message_end', data: null })).toBe(false)
    expect(affectsConversationList({ type: 'message_end', data: {} })).toBe(false)
    expect(affectsConversationList({ type: 'message_end', data: 'not-an-object' })).toBe(false)
  })
})

describe('去抖刷新', () => {
  it('窗口内的重复请求合并成一次', async () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const refresh = new DebouncedRefresh(run)

    refresh.schedule()
    refresh.schedule()
    refresh.schedule()
    expect(run).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(1)

    // 跑完之后还能再排下一次
    refresh.schedule()
    await vi.advanceTimersByTimeAsync(100)
    expect(run).toHaveBeenCalledTimes(2)

    refresh.dispose()
    vi.useRealTimers()
  })

  it('延后执行 —— Pi 是先发事件、后写盘的，立刻读会读到旧列表', async () => {
    vi.useFakeTimers()
    const order: string[] = []
    const refresh = new DebouncedRefresh(() => {
      order.push('refresh')
    })

    refresh.schedule()
    order.push('event')
    expect(order).toEqual(['event'])

    await vi.advanceTimersByTimeAsync(100)
    expect(order).toEqual(['event', 'refresh'])

    vi.useRealTimers()
  })

  it('dispose 之后不再执行', async () => {
    vi.useFakeTimers()
    const run = vi.fn()
    const refresh = new DebouncedRefresh(run)

    refresh.schedule()
    expect(refresh.pending).toBe(true)
    refresh.dispose()
    expect(refresh.pending).toBe(false)

    await vi.advanceTimersByTimeAsync(200)
    expect(run).not.toHaveBeenCalled()

    vi.useRealTimers()
  })
})
