import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DebugConsoleStore, type ConsoleRecordInput } from '../host/main/debugConsole'

/**
 * 调试记录的自动清理。
 *
 * 两条规则，哪条先触达就执行哪条：
 * 1. 保留时长（7 天）—— 但最近 N 条不动
 * 2. 占用上限 —— 不受上一条的保底约束，磁盘不爆更要紧
 *
 * 正在详情里看的那条永远不删。
 */

const DAY = 24 * 60 * 60 * 1000

function makeRecord(id: string, capturedAt: number): ConsoleRecordInput {
  return {
    id,
    sessionId: 'session-a',
    sessionName: '调试会话',
    prompt: `第 ${id} 条`,
    tabId: 'tab-1',
    model: { provider: 'anthropic', id: 'claude-x' },
    capturedAt,
    transcript: { messages: [{ role: 'user', content: [{ type: 'text', text: id }] }] },
    provider: { model: 'claude-x', messages: [{ role: 'user', content: id }] },
    response: { status: 200, headers: {}, message: { role: 'assistant', content: id } }
  }
}

async function settle(store: DebugConsoleStore): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (store.status().writing === 0) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 造一个存储层，关掉写入后的自动清理 —— 由测试自己控制什么时候清 */
function makeStore(dir: string): DebugConsoleStore {
  const store = new DebugConsoleStore(dir)
  store.setAutoDelete(false)
  return store
}

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-prune-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('自动清理', () => {
  it('关掉自动清理时什么都不删', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    store.enqueue(makeRecord('old', now - 30 * DAY))
    await settle(store)

    expect(store.prune().deleted).toBe(0)
    expect(store.list().records).toHaveLength(1)
  })

  it('超过保留时长的记录被删掉', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    store.enqueue(makeRecord('fresh', now - 1 * DAY))
    store.enqueue(makeRecord('stale', now - 30 * DAY))
    await settle(store)
    expect(store.list().records).toHaveLength(2)

    store.setAutoDelete(true)
    store.setKeepRecent(0)
    const result = store.prune()

    expect(result.deleted).toBe(1)
    expect(store.list().records.map((record) => record.id)).toEqual(['fresh'])
  })

  it('最近 N 条即使超期也不动', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    // 三条都超期了，但 keepRecent = 3 → 一条都不删
    store.enqueue(makeRecord('a', now - 30 * DAY))
    store.enqueue(makeRecord('b', now - 20 * DAY))
    store.enqueue(makeRecord('c', now - 10 * DAY))
    await settle(store)

    store.setAutoDelete(true)
    store.setKeepRecent(3)
    expect(store.prune().deleted).toBe(0)
    expect(store.list().records).toHaveLength(3)
  })

  it('占用超上限时按最老的先删', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    for (let i = 0; i < 6; i += 1) {
      store.enqueue(makeRecord(`r${i}`, now - (6 - i) * 60_000))
    }
    await settle(store)
    const before = store.stats()
    expect(before.count).toBe(6)

    // 上限压到「大约一半」—— 应该删掉最老的几条
    store.setAutoDelete(true)
    // keepRecent 设得很小，免得保底挡住「超量」这条规则
    store.setKeepRecent(0)
    store.setMaxTotalBytes(Math.floor(before.totalBytes / 2))
    const result = store.prune()

    expect(result.deleted).toBeGreaterThan(0)
    expect(store.stats().totalBytes).toBeLessThanOrEqual(before.totalBytes / 2)
    // 留下的都是新的 —— 最老的那条一定不在了
    const left = store.list().records.map((record) => record.id)
    expect(left).not.toContain('r0')
    expect(left).toContain('r5')
  })

  it('占用上限不受「至少保留」的约束 —— 磁盘不爆更要紧', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    for (let i = 0; i < 6; i += 1) store.enqueue(makeRecord(`r${i}`, now - (6 - i) * 60_000))
    await settle(store)
    const before = store.stats()

    store.setAutoDelete(true)
    // 保底说「最近 6 条都不动」，但上限说超了 —— 上限赢
    store.setKeepRecent(6)
    store.setMaxTotalBytes(Math.floor(before.totalBytes / 2))
    const result = store.prune()

    expect(result.deleted).toBeGreaterThan(0)
  })

  it('正在看的那条不删', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    store.enqueue(makeRecord('oldest', now - 40 * DAY))
    store.enqueue(makeRecord('newest', now - 1 * DAY))
    await settle(store)

    store.setAutoDelete(true)
    store.setKeepRecent(0)
    store.protect('oldest')

    expect(store.prune().deleted).toBe(0)
    expect(store.list().records).toHaveLength(2)

    // 取消保护之后就该删了
    store.protect(null)
    expect(store.prune().deleted).toBe(1)
    expect(store.list().records.map((record) => record.id)).toEqual(['newest'])
  })

  it('没有可删的时候不报删除', async () => {
    const store = makeStore(tempDir())
    store.enqueue(makeRecord('only', Date.now()))
    await settle(store)

    store.setAutoDelete(true)
    const result = store.prune()
    expect(result.deleted).toBe(0)
    expect(result.freedBytes).toBe(0)
  })

  it('清理会释放占用，统计跟着变小', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    for (let i = 0; i < 4; i += 1) store.enqueue(makeRecord(`r${i}`, now - (4 - i) * DAY))
    await settle(store)
    const before = store.stats().totalBytes

    store.setAutoDelete(true)
    store.setKeepRecent(0)
    store.setMaxTotalBytes(1)
    const result = store.prune()

    expect(result.deleted).toBeGreaterThan(0)
    expect(result.freedBytes).toBeGreaterThan(0)
    expect(store.stats().totalBytes).toBeLessThan(before)
  })

  it('实际删掉的条数与列表对得上', async () => {
    const store = makeStore(tempDir())
    const now = Date.now()
    for (let i = 0; i < 5; i += 1) store.enqueue(makeRecord(`r${i}`, now - (20 - i) * DAY))
    await settle(store)

    store.setAutoDelete(true)
    store.setKeepRecent(0)
    const result = store.prune()

    // 全超期 → 全删
    expect(result.deleted).toBe(5)
    expect(store.list().records).toHaveLength(0)
  })

  it('规则与上次清理结果能从 stats 里读到', async () => {
    const store = makeStore(tempDir())
    store.enqueue(makeRecord('a', Date.now() - 30 * DAY))
    await settle(store)

    store.setAutoDelete(true)
    store.setKeepRecent(0)
    store.setMaxTotalBytes(123)
    const result = store.prune()

    const stats = store.stats()
    expect(stats.limits).toEqual({
      autoDelete: true,
      maxTotalBytes: 123,
      keepRecent: 0,
      retentionDays: 7
    })
    expect(stats.lastPrune?.deleted).toBe(result.deleted)
    expect(store.lastPruneResult()?.at).toBe(result.at)
  })
})
