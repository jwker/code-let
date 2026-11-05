import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DebugConsoleStore, type ConsoleRecordInput } from '../host/main/debugConsole'

/**
 * 调试控制台的存储层。
 *
 * 关注三件事：写进去能按字段原样读回来；超限的记录降级成只留元数据；
 * 删除和统计对得上。
 */

function makeRecord(overrides?: Partial<ConsoleRecordInput>): ConsoleRecordInput {
  return {
    id: 't1-1',
    sessionId: 'session-a',
    sessionName: '调试会话',
    sessionTitle: '调试会话',
    prompt: '看看这个报错',
    tabId: 'tab-1',
    model: { provider: 'anthropic', id: 'claude-x' },
    capturedAt: 1_700_000_000_000,
    transcript: {
      messages: [
        { role: 'system', content: [{ type: 'text', text: '你是一个编码助手' }] },
        { role: 'user', content: [{ type: 'text', text: '看看这个报错' }] }
      ]
    },
    provider: {
      model: 'claude-x',
      messages: [{ role: 'user', content: '看看这个报错' }],
      tools: [{ name: 'read', description: '读文件' }]
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      message: { role: 'assistant', content: [{ type: 'text', text: '这是报错' }] }
    },
    ...overrides
  }
}

async function settle(store: DebugConsoleStore): Promise<void> {
  // 写入是异步的 —— 等它把队列排空
  for (let i = 0; i < 50; i += 1) {
    if (store.status().writing === 0) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('调试控制台存储层', () => {
  it('写进去的记录能按字段原样读回来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(makeRecord())
    await settle(store)

    const list = store.list()
    expect(list.records).toHaveLength(1)
    expect(list.records[0]!.sessionName).toBe('调试会话')
    expect(list.records[0]!.sessionTitle).toBe('调试会话')
    expect(list.records[0]!.providerStatus).toBe(200)

    // 一级节点：骨架里有数组的条目清单
    const shell = store.readField('t1-1', 'transcript')
    expect(shell?.shell?.array?.key).toBe('messages')
    expect(shell?.shell?.array?.count).toBe(2)
    expect(shell?.shell?.array?.items[0]!.role).toBe('system')
    expect(shell?.shell?.array?.items[1]!.preview).toContain('看看这个报错')

    // 二级：单条消息 —— 它的正文块再拆一层
    const item = store.readField('t1-1', 'transcript.messages[1]')
    expect(item?.shell?.fields.role).toBe('user')
    expect(item?.shell?.array?.key).toBe('content')
    expect(item?.shell?.array?.count).toBe(1)

    // 三级：消息里的一个内容块
    const block = store.readField('t1-1', 'transcript.messages[1].content[0]')
    expect(block?.value).toMatchObject({ type: 'text', text: '看看这个报错' })

    // provider 那一块的字段
    const provider = store.readField('t1-1', 'provider')
    expect(provider?.shell?.fields.model).toBe('claude-x')
    expect(provider?.shell?.array?.key).toBe('messages')
  })

  it('响应里的助手消息单独拆出来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(makeRecord())
    await settle(store)

    const shell = store.readField('t1-1', 'response')
    expect(shell?.shell?.fields.status).toBe(200)
    expect(shell?.shell?.items).toHaveLength(1)

    const message = store.readField('t1-1', 'response.message')
    expect(message?.shell?.fields.role).toBe('assistant')
  })

  it('耗时从时间点算出来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(
      makeRecord({
        timing: { startedAt: 1_000, headersAt: 1_400, endedAt: 2_800 }
      })
    )
    await settle(store)

    const meta = store.list().records[0]!
    expect(meta.durationMs).toBe(1_800)
    expect(meta.firstByteMs).toBe(400)
  })

  it('没有时间点的记录耗时是空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(makeRecord())
    await settle(store)

    const meta = store.list().records[0]!
    expect(meta.durationMs).toBeNull()
    expect(meta.firstByteMs).toBeNull()
  })

  it('超过单条上限的记录只留元数据', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir, { maxRecordBytes: 100 })
    store.enqueue(makeRecord())
    await settle(store)

    const list = store.list()
    expect(list.records[0]!.truncated).toBe(true)
    const field = store.readField('t1-1', 'transcript')
    expect(field?.error).toContain('只留了元数据')
  })

  it('统计、删除都跟磁盘对得上', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(makeRecord({ id: 't1-1', sessionId: 'session-a' }))
    store.enqueue(makeRecord({ id: 't2-1', sessionId: 'session-b' }))
    await settle(store)

    const stats = store.stats()
    expect(stats.count).toBe(2)
    expect(stats.contentBytes).toBeGreaterThan(0)
    expect(stats.indexBytes).toBeGreaterThan(0)
    expect(stats.totalBytes).toBe(stats.contentBytes + stats.indexBytes + stats.blobBytes)

    expect(store.deleteSession('session-a')).toBe(1)
    expect(store.list().records).toHaveLength(1)
    expect(store.deleteRecord('t2-1')).toBe(true)
    expect(store.list().records).toHaveLength(0)

    // 容器和索引都清掉了
    const requests = readdirSync(join(dir, 'requests'))
    expect(requests.filter((name) => name.endsWith('.cgz'))).toHaveLength(0)
    expect(requests.filter((name) => name.endsWith('.idx.json'))).toHaveLength(0)
  })

  it('老记录没有标题时，能从 transcript 骨架反推一个', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    // 老记录：只有 sessionName，没有 sessionTitle
    store.enqueue(makeRecord({ sessionName: null, sessionTitle: null }))
    await settle(store)
    // 手动把索引里的标题去掉，模拟老格式
    const indexPath = join(dir, 'requests', 't1-1.idx.json')
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { meta: { sessionTitle: string | null } }
    index.meta.sessionTitle = null
    writeFileSync(indexPath, JSON.stringify(index), 'utf8')

    expect(store.list().records[0]!.sessionTitle).toBeNull()
    expect(store.backfillTitles()).toBe(1)
    // 首条用户消息是「看看这个报错」
    expect(store.list().records[0]!.sessionTitle).toBe('看看这个报错')
    // 补过之后不再重复补
    expect(store.backfillTitles()).toBe(0)
    expect(store.list().records[0]!.sessionTitle).toBe('看看这个报错')
  })

  it('列表里给同一会话的请求编号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    const base = 1_700_000_000_000
    store.enqueue(makeRecord({ id: 'a1', sessionId: 's1', capturedAt: base }))
    store.enqueue(makeRecord({ id: 'a2', sessionId: 's1', capturedAt: base + 1000 }))
    store.enqueue(makeRecord({ id: 'b1', sessionId: 's2', capturedAt: base + 2000 }))
    await settle(store)

    const records = store.list().records
    // 列表按时间倒序，编号按时间正序数出来
    expect(records.map((record) => [record.id, record.requestNo])).toEqual([
      ['b1', 1],
      ['a2', 2],
      ['a1', 1]
    ])
  })

  it('删一批勾选了的记录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(makeRecord({ id: 't1-1' }))
    store.enqueue(makeRecord({ id: 't2-1' }))
    store.enqueue(makeRecord({ id: 't3-1' }))
    await settle(store)

    expect(store.deleteRecords(['t1-1', 't3-1'])).toBe(2)
    expect(store.list().records.map((record) => record.id)).toEqual(['t2-1'])
    expect(store.deleteRecords(['不存在的'])).toBe(0)
  })

  it('导出的文件成套：容器、索引、manifest 都在', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(makeRecord())
    await settle(store)

    const collected = store.collectExportFiles('all')
    expect(collected.records).toHaveLength(1)
    const names = collected.files.map((file) => file.name)
    expect(names).toContain('requests/t1-1.cgz')
    expect(names).toContain('requests/t1-1.idx.json')
    for (const file of collected.files) {
      expect(existsSync(file.path)).toBe(true)
    }
  })

  it('按勾选的记录导出，只带那些', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    store.enqueue(makeRecord({ id: 't1-1' }))
    store.enqueue(makeRecord({ id: 't2-1' }))
    await settle(store)

    const collected = store.collectExportFiles('records', undefined, undefined, ['t2-1'])
    expect(collected.records.map((record) => record.id)).toEqual(['t2-1'])
    const names = collected.files.map((file) => file.name)
    expect(names).toContain('requests/t2-1.cgz')
    expect(names).not.toContain('requests/t1-1.cgz')
  })

  it('图片抽成 blob，正文里只留引用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-console-'))
    const store = new DebugConsoleStore(dir)
    const base64 = Buffer.from('假图片数据'.repeat(200)).toString('base64')
    store.enqueue(
      makeRecord({
        transcript: {
          messages: [{ role: 'user', content: [{ type: 'image', data: base64, mimeType: 'image/png' }] }]
        }
      })
    )
    await settle(store)

    const blobs = readdirSync(join(dir, 'blobs'))
    expect(blobs).toHaveLength(1)
    const body = readFileSync(join(dir, 'blobs', blobs[0]!), 'utf8')
    expect(body).toContain('假图片数据')

    // 正文里不再有 base64
    const raw = readFileSync(join(dir, 'requests', 't1-1.cgz'))
    expect(raw.includes(Buffer.from(base64.slice(0, 64)))).toBe(false)
  })
})
