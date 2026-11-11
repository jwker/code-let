import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type {
  ConsoleFieldResult,
  ConsoleItemSkeleton,
  ConsoleLimits,
  ConsoleListResult,
  ConsolePruneResult,
  ConsoleRecordMeta,
  ConsoleShell,
  ConsoleStats
} from '@contract/console'

/**
 * 调试控制台的存储层。
 *
 * 一次请求落两个文件：
 * - `<id>.idx.json`：索引。纯文本、不压缩，记元数据和每个字段块在容器里的位置。
 * - `<id>.cgz`：内容容器。里面是若干个首尾相接的 gzip 成员，一个成员就是一个字段块。
 *
 * 分成两个文件的原因是：列目录和算占用不能靠解压。索引里还有每个块的骨架，
 * 所以详情页展开一级节点时不用解压就能列出条目，点某一条才去读那一个块。
 *
 * 层级：��级固定为 meta / transcript / provider / response；二级是节点里那个最大的数组
 * 按位置切出来的元素；三级是元素里的数组。切分按位置，不按内容 —— provider 的字段形状
 * 和 Pi 的消息角色怎么变都不会错位。
 */

/** 采集扩展递过来的原始记录 */
export interface ConsoleRecordInput {
  id: string
  sessionId: string
  sessionName: string | null
  /** 列表里显示的会话标题（自定义名字或首条用户消息） */
  sessionTitle?: string | null
  /** 触发这次请求的那条用户消息 */
  prompt?: string | null
  /** 这次请求在哪个目录下跑的 */
  cwd?: string | null
  tabId: string
  model: { provider: string; id: string } | null
  capturedAt: number
  /** 时间点：请求发出、收到响应头、消息定稿 */
  timing?: { startedAt?: number; headersAt?: number | null; endedAt?: number | null }
  /** Pi 侧的 transcript（含系统消息） */
  transcript: unknown
  /** provider 收到的原始 payload */
  provider: unknown
  /** provider 的响应：状态码、响应头、最终那条助手消息 */
  response: unknown
}

interface ChunkEntry {
  path: string
  offset: number
  length: number
  /** 未压缩时的字节数 */
  bytes: number
}

/** 拆好、序列化好的一个块 */
interface PreparedChunk {
  path: string
  json: string
}

/** 准备好的一条记录：还没压缩、还没写盘 */
interface PreparedRecord {
  meta: ConsoleRecordMeta
  chunks: PreparedChunk[]
  blobs: Map<string, Buffer>
  tooBig: boolean
}

interface IndexFile {
  version: 1
  id: string
  meta: ConsoleRecordMeta
  chunks: ChunkEntry[]
  blobs: string[]
}

/** 单个字段块的骨架 */
interface ShellValue {
  fields: Record<string, unknown>
  array: { key: string; count: number; items: ConsoleItemSkeleton[] } | null
  /** 不属于数组、但单独拆出来的条目 */
  items: ConsoleItemSkeleton[]
}

/** 超过这个字节数的块不进界面，只给「导出」 */
const MAX_FIELD_BYTES = 200 * 1024
/** 单条记录超过这个字节数就只留元数据 */
const DEFAULT_MAX_RECORD_BYTES = 32 * 1024 * 1024
/** 队列里最多攒多少条待写记录 */
const MAX_QUEUE = 64

/** 总占用上限的默认值 —— 512MB */
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024
/** 至少保留最近多少条（按时间清理时这几条不动） */
const DEFAULT_KEEP_RECENT = 50
/**
 * 保留时长 —— 超过这个天数的记录会被清掉。
 *
 * 这是**写死的规则，不是设置项**：按「哪个限制先触达就清哪个」的做法，
 * 时长跟占用上限一起构成触发条件，但时长本身不给用户调 ——
 * 要留更久就把占用上限调大。
 */
const RETENTION_DAYS = 7
/** 两次自动清理之间至少隔多久 —— 写一条就扫一遍目录太浪费 */
const PRUNE_INTERVAL_MS = 60_000

const gzipAsync = promisify(gzip)

const NODES = ['meta', 'transcript', 'provider', 'response'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 取一段纯文本，用来当预览 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!isObject(block)) continue
    if (typeof block.text === 'string') out += block.text
    else if (typeof block.name === 'string') out += `[tool: ${block.name}]`
  }
  return out
}

function roleOf(item: unknown): string {
  if (!isObject(item)) return ''
  if (typeof item.role === 'string') return item.role
  if (typeof item.type === 'string') return item.type
  return ''
}

function previewOf(item: unknown, limit = 120): string {
  const text = textOf(isObject(item) ? item.content : undefined) ||
    (isObject(item) && typeof item.text === 'string' ? item.text : '')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

/**
 * 找一个「最像消息列表」的数组。
 *
 * 规则：只看对象顶层的数组，元素得是对象；元素最多的那个就是它。
 * 同数时优先 messages / contents / input 这些常见名字。
 */
function findArrayKey(value: unknown): string | null {
  if (!isObject(value)) return null
  const candidates: Array<{ key: string; count: number }> = []
  for (const [key, item] of Object.entries(value)) {
    if (!Array.isArray(item)) continue
    if (item.length === 0) continue
    if (!item.some((element) => isObject(element))) continue
    candidates.push({ key, count: item.length })
  }
  if (candidates.length === 0) return null
  const preferred = ['messages', 'contents', 'input', 'conversation']
  candidates.sort((a, b) => {
    const pa = preferred.indexOf(a.key)
    const pb = preferred.indexOf(b.key)
    if (pa !== pb && (pa >= 0 || pb >= 0)) return (pa < 0 ? 99 : pa) - (pb < 0 ? 99 : pb)
    return b.count - a.count
  })
  return candidates[0]!.key
}

/**
 * 把图片从消息里摘出来。
 *
 * base64 图片是体积的大头，gzip 压它效果有限。摘出来按内容哈希存进 blobs/，
 * 正文里只留引用 —— 同一个文件重复引用也只存一份。
 */
function extractBlobs(value: unknown, blobs: Map<string, Buffer>): unknown {
  if (Array.isArray(value)) return value.map((item) => extractBlobs(item, blobs))
  if (!isObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (key === 'data' && typeof item === 'string' && item.length > 512 && isObject(value)) {
      const type = typeof value.type === 'string' ? value.type : ''
      if (type === 'image' || typeof value.mimeType === 'string') {
        const buffer = Buffer.from(item, 'base64')
        const hash = createHash('sha1').update(buffer).digest('hex')
        blobs.set(hash, buffer)
        out[key] = { blob: hash, bytes: buffer.length }
        continue
      }
    }
    out[key] = extractBlobs(item, blobs)
  }
  return out
}

/**
 * 拆一个节点：返回骨架和被拆出来的元素。
 *
 * 一级节点（transcript / provider）拆它顶层那个数组；
 * 二级元素（一条消息）拆它里面的数组（比如 content）；
 * 三级以下不再拆，整个值作为一个块。
 *
 * 没有数组的节点（比如 response）另有一条路：把里面的 `message` 单独拆出来 ——
 * 那条助手消息可能很大，跟状态码、响应头挤在一个块里就超限了。
 */
function splitNode(value: unknown, node: string, path: string, depth: number): {
  shell: ShellValue
  elements: Array<{ path: string; value: unknown }>
} {
  const elements: Array<{ path: string; value: unknown }> = []
  if (depth >= 2 || !isObject(value)) {
    return { shell: { fields: {}, array: null, items: [] }, elements }
  }
  const key = findArrayKey(value)
  if (key === null) {
    // 没有数组 —— 看看有没有 message 这种可以单独拆的对象字段
    if (depth === 0 && isObject(value.message)) {
      const messagePath = `${path}.message`
      const inner = splitNode(value.message, node, messagePath, depth + 1)
      const fields: Record<string, unknown> = { ...value }
      delete fields.message
      const item: ConsoleItemSkeleton = {
        index: 0,
        role: roleOf(value.message),
        preview: previewOf(value.message),
        bytes: JSON.stringify(value.message ?? null)?.length ?? 0
      }
      return {
        shell: { fields, array: null, items: [item] },
        elements: [{ path: messagePath, value: inner.shell }, ...inner.elements]
      }
    }
    return { shell: { fields: value, array: null, items: [] }, elements }
  }
  const array = (value as Record<string, unknown>)[key] as unknown[]
  const items: ConsoleItemSkeleton[] = []
  array.forEach((element, index) => {
    const bytes = JSON.stringify(element ?? null)?.length ?? 0
    items.push({ index, role: roleOf(element), preview: previewOf(element), bytes })
    const elementPath = `${path}.${key}[${index}]`
    if (depth === 0) {
      // 一级节点的元素再拆一层：消息里的 content 之类
      const inner = splitNode(element, node, elementPath, depth + 1)
      if (inner.shell.array) {
        elements.push({ path: elementPath, value: inner.shell })
        for (const item of inner.elements) elements.push(item)
        return
      }
    }
    elements.push({ path: elementPath, value: element })
  })
  const fields: Record<string, unknown> = { ...value }
  delete fields[key]
  return {
    shell: { fields, array: { key, count: array.length, items }, items: [] },
    elements
  }
}

export class DebugConsoleStore {
  /** 存储目录；null = 不落盘（测试里不注入目录时） */
  private readonly dir: string | null
  private readonly requestsDir: string
  private readonly blobsDir: string
  private queue: ConsoleRecordInput[] = []
  private writing = false
  private failed = 0
  private maxRecordBytes: number
  private enabled = true
  /** 自动清理：超上限或过期的记录自动删 */
  private autoDelete = true
  /** 总占用上限（字节）。0 = 不限制 */
  private maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES
  /** 至少保留最近多少条（按时间清理时不动这几条） */
  private keepRecent = DEFAULT_KEEP_RECENT
  /** 正在详情里看的那条 —— 清理时跳过它 */
  private protectedId: string | null = null
  /** 上次自动清理是什么时候 */
  private lastPrune: ConsolePruneResult | null = null
  private lastPruneAt = 0
  /** 写完一条就通知一下 —— 界面据此刷新列表 */
  private changeListener: (() => void) | null = null

  constructor(dir: string | null, options?: { maxRecordBytes?: number; enabled?: boolean }) {
    this.dir = dir ? resolve(dir) : null
    this.requestsDir = join(this.dir ?? '', 'requests')
    this.blobsDir = join(this.dir ?? '', 'blobs')
    this.maxRecordBytes = options?.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES
    this.enabled = options?.enabled ?? true
  }

  /** 存储目录 */
  get directory(): string {
    return this.dir ?? ''
  }

  /** 写完一条（或失败）之后回调 —— 界面据此刷新 */
  setChangeListener(listener: (() => void) | null): void {
    this.changeListener = listener
  }

  /** 打开或关闭记录。开关是运行时状态，改了立刻生效 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isEnabled(): boolean {
    return this.enabled
  }

  /** 单条记录的上限（字节）。0 = 不限制 */
  setMaxRecordBytes(bytes: number): void {
    this.maxRecordBytes = bytes
  }

  /** 自动清理开关 */
  setAutoDelete(enabled: boolean): void {
    this.autoDelete = enabled
  }

  /** 总占用上限（字节）。0 = 不限制 */
  setMaxTotalBytes(bytes: number): void {
    this.maxTotalBytes = bytes
  }

  /** 至少保留最近多少条 */
  setKeepRecent(count: number): void {
    this.keepRecent = Math.max(0, Math.floor(count))
  }

  /**
   * 记下正在看的那条 —— 清理时跳过它。
   *
   * 不跳过的话，用户点开一条记录正看着，下一个请求写进来就把它清掉了，
   * 点下一个节点就报错。
   */
  protect(id: string | null): void {
    this.protectedId = id
  }

  /** 正在写盘的条数、失败的条数 —— 界面上显示 */
  status(): { writing: number; failed: number } {
    return { writing: this.queue.length + (this.writing ? 1 : 0), failed: this.failed }
  }

  /**
   * 收下一条记录，排进队列。
   *
   * 队列满了就丢最老的一条 —— 调试记录丢一条没关系，拖住模型请求不行。
   */
  enqueue(record: ConsoleRecordInput): void {
    if (!this.enabled || !this.dir) return
    if (this.queue.length >= MAX_QUEUE) {
      this.queue.shift()
      this.failed += 1
    }
    this.queue.push(record)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      while (this.queue.length > 0) {
        const record = this.queue.shift()!
        try {
          // 拆块和序列化是同步的 —— 在事件到达的同一拍里做完，
          // 免得 Pi 之后改了那些对象。压缩和写盘才是耗时的部分，放到异步里。
          const prepared = this.prepare(record)
          await this.writePrepared(prepared)
        } catch {
          // 写盘失败只计数，绝不能影响模型请求
          this.failed += 1
        }
      }
    } finally {
      this.writing = false
      try {
        this.changeListener?.()
      } catch {
        // 通知失败不影响存储
      }
      // 写完一轮看看要不要清理（内部有节流）
      this.maybePrune()
    }
  }

  /** 拆块、抽 blob、序列化 —— 同步做完 */
  private prepare(record: ConsoleRecordInput): PreparedRecord {
    const blobs = new Map<string, Buffer>()
    const timing = record.timing ?? {}
    const startedAt = timing.startedAt ?? record.capturedAt
    const durationMs =
      typeof timing.endedAt === 'number' ? Math.max(0, timing.endedAt - startedAt) : null
    const firstByteMs =
      typeof timing.headersAt === 'number' ? Math.max(0, timing.headersAt - startedAt) : null
    const payload: Record<string, unknown> = {
      meta: {
        id: record.id,
        sessionId: record.sessionId,
        sessionName: record.sessionName,
        sessionTitle: record.sessionTitle ?? record.sessionName,
        cwd: record.cwd ?? null,
        prompt: record.prompt ?? null,
        tabId: record.tabId,
        model: record.model,
        capturedAt: record.capturedAt,
        providerStatus: statusOf(record.response),
        durationMs,
        firstByteMs
      },
      transcript: extractBlobs(record.transcript, blobs),
      provider: extractBlobs(record.provider, blobs),
      response: extractBlobs(record.response, blobs)
    }

    const sizes = {
      meta: byteLength(payload.meta),
      transcript: byteLength(payload.transcript),
      provider: byteLength(payload.provider),
      response: byteLength(payload.response)
    }
    const total = sizes.meta + sizes.transcript + sizes.provider + sizes.response
    const tooBig = this.maxRecordBytes > 0 && total > this.maxRecordBytes

    const meta: ConsoleRecordMeta = {
      id: record.id,
      sessionId: record.sessionId,
      sessionName: record.sessionName,
      sessionTitle: record.sessionTitle ?? record.sessionName,
      cwd: record.cwd ?? null,
      prompt: record.prompt ?? null,
      tabId: record.tabId,
      model: record.model,
      capturedAt: record.capturedAt,
      sizes,
      providerStatus: statusOf(record.response),
      durationMs,
      firstByteMs,
      truncated: tooBig
    }

    const chunks: PreparedChunk[] = []
    if (!tooBig) {
      for (const node of NODES) {
        const value = payload[node]
        const split = splitNode(value, node, node, 0)
        const shellValue: ShellValue =
          node === 'meta'
            ? { fields: isObject(value) ? value : {}, array: null, items: [] }
            : split.shell
        chunks.push({ path: node, json: JSON.stringify(shellValue) })
        for (const element of split.elements) {
          chunks.push({ path: element.path, json: JSON.stringify(element.value ?? null) })
        }
      }
    }

    return { meta, chunks, blobs, tooBig }
  }

  /** 压缩并落盘 —— 异步，不占事件循环 */
  private async writePrepared(prepared: PreparedRecord): Promise<void> {
    if (!this.dir) return
    mkdirSync(this.blobsDir, { recursive: true })
    for (const [hash, buffer] of prepared.blobs) {
      const path = join(this.blobsDir, `${hash}.bin`)
      if (!existsSync(path)) writeFileSync(path, buffer)
    }

    const chunks: ChunkEntry[] = []
    const parts: Buffer[] = []
    let offset = 0
    for (const chunk of prepared.chunks) {
      const packed = await gzipAsync(Buffer.from(chunk.json, 'utf8'))
      chunks.push({ path: chunk.path, offset, length: packed.length, bytes: chunk.json.length })
      parts.push(packed)
      offset += packed.length
    }

    mkdirSync(this.requestsDir, { recursive: true })
    if (!prepared.tooBig) {
      writeAtomic(join(this.requestsDir, `${prepared.meta.id}.cgz`), Buffer.concat(parts))
    }
    const index: IndexFile = {
      version: 1,
      id: prepared.meta.id,
      meta: prepared.meta,
      chunks,
      blobs: [...prepared.blobs.keys()]
    }
    writeAtomic(
      join(this.requestsDir, `${prepared.meta.id}.idx.json`),
      `${JSON.stringify(index)}\n`,
      'utf8'
    )
  }

  // -------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------

  /** 列出所有记录，按时间倒序 */
  list(): ConsoleListResult {
    if (!this.dir) return { records: [], dir: '' }
    const indexes = this.readIndexes()
    // 先按时间正序数出「这个会话里的第几次请求」，再倒序返回
    const ordered = [...indexes].sort((a, b) => a.meta.capturedAt - b.meta.capturedAt)
    const counters = new Map<string, number>()
    const records: ConsoleRecordMeta[] = ordered.map((index) => {
      const no = (counters.get(index.meta.sessionId) ?? 0) + 1
      counters.set(index.meta.sessionId, no)
      return { ...index.meta, requestNo: no }
    })
    records.sort((a, b) => b.capturedAt - a.capturedAt)
    return { records, dir: this.dir }
  }

  /** 占用统计 */
  stats(): ConsoleStats {
    if (!this.dir) {
      return {
        dir: '',
        count: 0,
        contentBytes: 0,
        indexBytes: 0,
        blobBytes: 0,
        totalBytes: 0,
        writing: 0,
        failed: 0,
        limits: this.limits(),
        lastPrune: this.lastPrune
      }
    }
    let count = 0
    let contentBytes = 0
    let indexBytes = 0
    for (const index of this.readIndexes()) {
      count += 1
      indexBytes += fileSize(join(this.requestsDir, `${index.id}.idx.json`))
      contentBytes += fileSize(join(this.requestsDir, `${index.id}.cgz`))
    }
    let blobBytes = 0
    try {
      for (const name of readdirSync(this.blobsDir)) {
        blobBytes += fileSize(join(this.blobsDir, name))
      }
    } catch {
      // 没有 blobs 目录就是还没有图片
    }
    const status = this.status()
    return {
      dir: this.dir,
      count,
      contentBytes,
      indexBytes,
      blobBytes,
      totalBytes: contentBytes + indexBytes + blobBytes,
      writing: status.writing,
      failed: status.failed,
      limits: this.limits(),
      lastPrune: this.lastPrune
    }
  }

  /** 取一个字段：一级节点、数组元素、或更深的元素 */
  readField(id: string, path: string): ConsoleFieldResult | null {
    const index = this.readIndex(id)
    if (!index) return null
    if (index.meta.truncated) {
      return { path, error: '这条记录只留了元数据，正文没有落盘' }
    }
    const chunk = index.chunks.find((item) => item.path === path)
    if (!chunk) return { path, error: '没有这个字段' }
    if (chunk.bytes > MAX_FIELD_BYTES) {
      return { path, oversize: true, bytes: chunk.bytes }
    }
    const containerPath = join(this.requestsDir, `${id}.cgz`)
    if (!existsSync(containerPath)) return { path, error: '内容文件不见了' }
    let raw: Buffer
    try {
      const fd = readFileSync(containerPath)
      raw = gunzipSync(fd.subarray(chunk.offset, chunk.offset + chunk.length))
    } catch {
      return { path, error: '内容文件读不出来' }
    }
    let value: unknown
    try {
      value = JSON.parse(raw.toString('utf8'))
    } catch {
      return { path, error: '内容解析不了' }
    }
    if (isShell(value)) {
      const shell: ConsoleShell = {
        node: path,
        fields: value.fields,
        array: value.array,
        items: value.items ?? [],
        path,
        bytes: chunk.bytes
      }
      return { path, bytes: chunk.bytes, shell }
    }
    return { path, value, bytes: chunk.bytes }
  }

  /**
   * 给老记录补上会话标题和本次请求的提示。
   *
   * 早期只记了会话的自定义名字（大多数时候是空的），列表里就都是「未命名会话」；
   * 「这次请求是哪句话触发的」也没记。两者都能从 transcript 骨架里反推 ——
   * 骨架里每条消息有角色和预览，首条用户消息是会话标题，末条用户消息是这次的提示。
   * 只读那一小块，不用解压整个容器。
   */
  backfillTitles(): number {
    if (!this.dir) return 0
    let count = 0
    for (const index of this.readIndexes()) {
      const hasTitle = index.meta.sessionTitle !== undefined && index.meta.sessionTitle !== null
      const hasPrompt = index.meta.prompt !== undefined && index.meta.prompt !== null
      // 空串 = 试过了，推不出来（不反复试）
      if (hasTitle && hasPrompt) continue
      const derived = this.deriveTitles(index)
      index.meta.sessionTitle = hasTitle ? index.meta.sessionTitle : derived.title
      index.meta.prompt = hasPrompt ? index.meta.prompt : derived.prompt
      try {
        writeAtomic(
          join(this.requestsDir, `${index.id}.idx.json`),
          `${JSON.stringify(index)}\n`,
          'utf8'
        )
        count += 1
      } catch {
        // 补不上就留着旧值，不影响别的记录
      }
    }
    return count
  }

  /** 从 transcript 骨架里反推会话标题（首条用户消息）和这次的提示（末条用户消息） */
  private deriveTitles(index: IndexFile): { title: string; prompt: string } {
    const chunk = index.chunks.find((item) => item.path === 'transcript')
    if (!chunk) return { title: '', prompt: '' }
    try {
      const container = readFileSync(join(this.requestsDir, `${index.id}.cgz`))
      const raw = gunzipSync(container.subarray(chunk.offset, chunk.offset + chunk.length))
      const shell = JSON.parse(raw.toString('utf8')) as ShellValue
      const users = (shell.array?.items ?? []).filter((item) => item.role === 'user')
      const first = users[0]?.preview?.replace(/\s+/g, ' ').trim() ?? ''
      const last = users[users.length - 1]?.preview?.replace(/\s+/g, ' ').trim() ?? ''
      return {
        title: first ? (first.length > 60 ? `${first.slice(0, 60)}…` : first) : '',
        prompt: last ? (last.length > 120 ? `${last.slice(0, 120)}…` : last) : ''
      }
    } catch {
      return { title: '', prompt: '' }
    }
  }

  /** 读所有索引文件；坏文件跳过 */
  private readIndexes(): IndexFile[] {
    const out: IndexFile[] = []
    let names: string[]
    try {
      names = readdirSync(this.requestsDir)
    } catch {
      return out
    }
    for (const name of names) {
      if (!name.endsWith('.idx.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(join(this.requestsDir, name), 'utf8')) as IndexFile
        if (parsed && typeof parsed.id === 'string' && parsed.meta) out.push(parsed)
      } catch {
        // 索引坏了就跳过，不影响别的记录
      }
    }
    return out
  }

  private readIndex(id: string): IndexFile | null {
    const path = join(this.requestsDir, `${id}.idx.json`)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as IndexFile
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------
  // 删
  // -------------------------------------------------------------------

  /** 删一条记录 */
  deleteRecord(id: string): boolean {
    if (!this.dir) return false
    const index = this.readIndex(id)
    if (!index) return false
    rmSync(join(this.requestsDir, `${id}.idx.json`), { force: true })
    rmSync(join(this.requestsDir, `${id}.cgz`), { force: true })
    this.pruneBlobs()
    return true
  }

  /**
   * 自动清理。
   *
   * 两条规则，哪条先触达就执行哪条：
   * 1. **保留时长** —— 超过 RETENTION_DAYS 天的记录删掉，但最近 keepRecent 条不动。
   * 2. **占用上限** —— 总占用超了 maxTotalBytes，就按最老优先删到降下来为止。
   *    这一条**不受**上一条的保底约束 —— 磁盘不爆比「留着最近 50 条」更要紧。
   *
   * 两种情况都不碰正在看的那条。
   */
  prune(): ConsolePruneResult {
    const empty: ConsolePruneResult = { deleted: 0, freedBytes: 0, at: Date.now() }
    if (!this.dir || !this.autoDelete) return empty

    const indexes = this.readIndexes()
    if (indexes.length === 0) return empty

    // 每条在磁盘上占多少（索引 + 内容容器）
    const sizes = new Map<string, number>()
    let total = 0
    for (const index of indexes) {
      const size =
        fileSize(join(this.requestsDir, `${index.id}.idx.json`)) +
        fileSize(join(this.requestsDir, `${index.id}.cgz`))
      sizes.set(index.id, size)
      total += size
    }

    // 从老到新
    const ordered = [...indexes].sort((a, b) => a.meta.capturedAt - b.meta.capturedAt)
    const doomed = new Set<string>()

    // 规则 1：太老的
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const keepFrom = Math.max(0, ordered.length - this.keepRecent)
    for (let i = 0; i < keepFrom; i += 1) {
      const index = ordered[i]
      if (index.meta.capturedAt < cutoff) doomed.add(index.id)
    }

    // 规则 2：超量的 —— 从最老开始删
    if (this.maxTotalBytes > 0) {
      let freed = 0
      for (const id of doomed) freed += sizes.get(id) ?? 0
      let remaining = total - freed
      for (const index of ordered) {
        if (remaining <= this.maxTotalBytes) break
        if (doomed.has(index.id)) continue
        if (index.id === this.protectedId) continue
        doomed.add(index.id)
        remaining -= sizes.get(index.id) ?? 0
      }
    }

    // 正在看的那条永远不删
    if (this.protectedId) doomed.delete(this.protectedId)
    if (doomed.size === 0) {
      this.lastPruneAt = Date.now()
      return empty
    }

    // 图片 blob 是多个记录共用的 —— 删完记录再清一遍没人引用的
    const blobsBefore = this.blobBytes()
    let freedBytes = 0
    for (const id of doomed) {
      freedBytes += sizes.get(id) ?? 0
      rmSync(join(this.requestsDir, `${id}.idx.json`), { force: true })
      rmSync(join(this.requestsDir, `${id}.cgz`), { force: true })
    }
    this.pruneBlobs()
    const freed = freedBytes + Math.max(0, blobsBefore - this.blobBytes())

    const result: ConsolePruneResult = { deleted: doomed.size, freedBytes: freed, at: Date.now() }
    this.lastPrune = result
    this.lastPruneAt = result.at
    return result
  }

  /** 上次清理的结果 —— 界面上要出声，不能静默删 */
  lastPruneResult(): ConsolePruneResult | null {
    return this.lastPrune
  }

  /** 当前的清理规则 —— 界面上要把上限显示出来 */
  limits(): ConsoleLimits {
    return {
      autoDelete: this.autoDelete,
      maxTotalBytes: this.maxTotalBytes,
      keepRecent: this.keepRecent,
      retentionDays: RETENTION_DAYS
    }
  }

  /** 图片目录占多少 */
  private blobBytes(): number {
    let sum = 0
    try {
      for (const name of readdirSync(this.blobsDir)) sum += fileSize(join(this.blobsDir, name))
    } catch {
      // 没有 blobs 目录就是还没有图片
    }
    return sum
  }

  /**
   * 写完一轮之后看看要不要清 —— 节流，最多每分钟一次。
   *
   * 每写一条就扫一遍目录太浪费：记录一多，目录扫描本身就是负担。
   */
  private maybePrune(): void {
    if (!this.autoDelete) return
    const now = Date.now()
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    this.lastPruneAt = now
    const result = this.prune()
    if (result.deleted > 0) {
      try {
        this.changeListener?.()
      } catch {
        // 通知失败不影响存储
      }
    }
  }

  /** 删一个会话的全部记录，返回删了几条 */
  deleteSession(sessionId: string): number {
    if (!this.dir) return 0
    const indexes = this.readIndexes().filter((index) => index.meta.sessionId === sessionId)
    for (const index of indexes) {
      rmSync(join(this.requestsDir, `${index.id}.idx.json`), { force: true })
      rmSync(join(this.requestsDir, `${index.id}.cgz`), { force: true })
    }
    if (indexes.length > 0) this.pruneBlobs()
    return indexes.length
  }

  /** 删一批记录，返回删了几条 */
  deleteRecords(ids: string[]): number {
    if (!this.dir) return 0
    let deleted = 0
    for (const id of ids) {
      if (this.deleteRecord(id)) deleted += 1
    }
    return deleted
  }

  /** 清空全部记录，返回删了几条 */
  deleteAll(): number {
    if (!this.dir) return 0
    const indexes = this.readIndexes()
    for (const index of indexes) {
      rmSync(join(this.requestsDir, `${index.id}.idx.json`), { force: true })
      rmSync(join(this.requestsDir, `${index.id}.cgz`), { force: true })
    }
    rmSync(this.blobsDir, { recursive: true, force: true })
    return indexes.length
  }

  /** 没有记录引用的图片删掉 */
  private pruneBlobs(): void {
    const used = new Set<string>()
    for (const index of this.readIndexes()) {
      for (const hash of index.blobs) used.add(hash)
    }
    let names: string[]
    try {
      names = readdirSync(this.blobsDir)
    } catch {
      return
    }
    for (const name of names) {
      const hash = name.replace(/\.bin$/, '')
      if (!used.has(hash)) rmSync(join(this.blobsDir, name), { force: true })
    }
  }

  // -------------------------------------------------------------------
  // 导出
  // -------------------------------------------------------------------

  /**
   * 收集导出要打包的文件。
   *
   * 一条记录是两个文件（容器 + 索引），必须成对带上；记录里引用到的图片也一并带上。
   */
  collectExportFiles(
    scope: 'record' | 'records' | 'sessions' | 'all',
    recordId?: string,
    sessionIds?: string[],
    recordIds?: string[]
  ): {
    files: Array<{ name: string; path: string }>
    records: ConsoleRecordMeta[]
  } {
    const all = this.readIndexes()
    let selected = all
    if (scope === 'record') {
      selected = all.filter((index) => index.id === recordId)
    } else if (scope === 'records') {
      const wanted = new Set(recordIds ?? [])
      selected = all.filter((index) => wanted.has(index.id))
    } else if (scope === 'sessions') {
      const wanted = new Set(sessionIds ?? [])
      selected = all.filter((index) => wanted.has(index.meta.sessionId))
    }
    const files: Array<{ name: string; path: string }> = []
    const blobs = new Set<string>()
    for (const index of selected) {
      const container = join(this.requestsDir, `${index.id}.cgz`)
      if (existsSync(container)) files.push({ name: `requests/${index.id}.cgz`, path: container })
      files.push({ name: `requests/${index.id}.idx.json`, path: join(this.requestsDir, `${index.id}.idx.json`) })
      for (const hash of index.blobs) blobs.add(hash)
    }
    for (const hash of blobs) {
      const path = join(this.blobsDir, `${hash}.bin`)
      if (existsSync(path)) files.push({ name: `blobs/${hash}.bin`, path })
    }
    return { files, records: selected.map((index) => index.meta) }
  }
}

function isShell(value: unknown): value is ShellValue {
  return isObject(value) && 'fields' in value && 'array' in value
}

function byteLength(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0
  } catch {
    return 0
  }
}

function statusOf(response: unknown): number | null {
  if (!isObject(response)) return null
  if (typeof response.status === 'number') return response.status
  return null
}

function fileSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** 写临时文件再改名 —— 改名是原子的，崩溃不会留下半截文件 */
function writeAtomic(path: string, data: Buffer | string, encoding?: BufferEncoding): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, data, encoding)
  renameSync(tmp, path)
}
