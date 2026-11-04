import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ContextDiffGroup, StreamItem,
  ContextDiffSession,
  ContextDiffView,
  ContextMessageSummary,
  ContextSnapshotRef
} from '@contract/index'

/**
 * 请求级上下文快照的索引、持久化和 diff。
 *
 * 完整消息只在内存缓存里保留有限时间；落盘的只有索引、preview 和引用。
 * 这样同会话可以看最近变化，跨会话可以比较“上一个会话的最后一次请求”。
 */

export interface RawContextMessage {
  key: string
  role: string
  text: string
  hash: string
  tokens: number
  preview: string
}

export interface RawContextSnapshot {
  sessionId: string
  sessionFile: string | null
  sessionName?: string
  capturedAt: number
  toolsHash: string | null
  messages: RawContextMessage[]
}

interface StoredMessage {
  key: string
  role: string
  hash: string
  tokens: number
  preview: string
}

interface Snapshot {
  id: string
  sessionId: string
  sessionPath: string | null
  sessionName?: string
  turn: number
  request: number
  capturedAt: number
  totalTokens: number
  toolsHash: string | null
  messages: StoredMessage[]
}

const MAX_SNAPSHOTS_PER_SESSION = 21 // 第一次 + 最近 20 次
const MAX_CONTENT_BYTES = 64 * 1024 * 1024

function refOf(snapshot: Snapshot): ContextSnapshotRef {
  return {
    id: snapshot.id,
    sessionId: snapshot.sessionId,
    sessionPath: snapshot.sessionPath,
    ...(snapshot.sessionName ? { sessionName: snapshot.sessionName } : {}),
    turn: snapshot.turn,
    request: snapshot.request,
    capturedAt: snapshot.capturedAt,
    totalTokens: snapshot.totalTokens
  }
}

/** 和 ext/context-diff.ts 的 textOf 保持一致，才能按同一 hash 回源 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const item = block as { type?: string; text?: string; name?: string }
    if (item.type === 'text' && typeof item.text === 'string') out += item.text
    else if (item.type === 'image') out += '[image]'
    else if (item.type === 'toolCall' && typeof item.name === 'string') out += `[tool: ${item.name}]`
  }
  return out
}

/** 最长公共子序列，返回同一消息在 baseline/current 里的下标对 */
function commonMessages(
  baseline: readonly StoredMessage[],
  current: readonly StoredMessage[]
): Array<[number, number]> {
  const n = baseline.length
  const m = current.length
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        baseline[i].hash === current[j].hash
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (baseline[i].hash === current[j].hash) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

function summaryOf(message: StoredMessage): ContextMessageSummary {
  return {
    key: message.key,
    role: message.role,
    hash: message.hash,
    tokens: message.tokens,
    preview: message.preview
  }
}

export class ContextDiffStore {
  private readonly tabs = new Map<string, Snapshot[]>()
  private readonly sessions = new Map<string, Snapshot[]>()
  /** 由会话历史重建的近似快照；只存在于当前进程 */
  private readonly approximateTabs = new Map<string, Snapshot[]>()
  private readonly content = new Map<string, string>()
  /** 会话文件里按 hash 找全文的缓存；详情回源用 */
  private readonly sessionText = new Map<string, Map<string, string>>()
  private contentBytes = 0

  constructor(private readonly dir: string | null) {}

  /** 接收内置扩展发来的请求前快照 */
  capture(tabId: string, raw: RawContextSnapshot): void {
    if (!raw || typeof raw.sessionId !== 'string' || !Array.isArray(raw.messages)) return
    if (raw.sessionId.startsWith('temp-')) return

    const history = this.sessions.get(raw.sessionId) ?? this.loadSession(raw.sessionId) ?? []
    const request = (history.at(-1)?.request ?? 0) + 1
    const turn = raw.messages.filter((message) => message.role === 'user').length
    const messages: StoredMessage[] = raw.messages.map((message) => ({
      key: message.key,
      role: message.role,
      hash: message.hash,
      tokens: message.tokens,
      preview: message.preview
    }))

    for (const message of raw.messages) {
      this.remember(message.hash, message.text)
    }

    const snapshot: Snapshot = {
      id: `${raw.sessionId}:${request}`,
      sessionId: raw.sessionId,
      sessionPath: raw.sessionFile,
      ...(raw.sessionName ? { sessionName: raw.sessionName } : {}),
      turn,
      request,
      capturedAt: raw.capturedAt,
      totalTokens: messages.reduce((sum, message) => sum + message.tokens, 0),
      toolsHash: raw.toolsHash,
      messages
    }

    const nextHistory = trimHistory([...history, snapshot])
    this.sessions.set(raw.sessionId, nextHistory)
    this.tabs.set(tabId, nextHistory)
    this.approximateTabs.delete(tabId)
    this.persist(nextHistory)
  }

  /** 把持久化的会话索引挂到当前标签；已有内存历史时不覆盖 */
  attachTab(tabId: string, sessionId: string): void {
    if (this.tabs.has(tabId)) return
    const history = this.loadSession(sessionId)
    if (history && history.length > 0) {
      this.tabs.set(tabId, history)
      this.approximateTabs.delete(tabId)
    }
  }

  /**
   * 从会话历史重建一个近似对比。
   *
   * 没有请求级快照时（例如对话是在终端里产生的），只能按用户消息切轮，
   * 把每一轮结束时的历史当作伪快照。没有 system/tools，也没有请求级转换，
   * 所以返回的 view.approximate 一定是 true。
   */
  approximate(
    tabId: string,
    sessionId: string,
    sessionPath: string | null,
    sessionName: string | undefined,
    items: readonly StreamItem[]
  ): ContextDiffView | null {
    const turns: Snapshot[] = []
    let current: StoredMessage[] = []
    let turn = 0

    const pushMessage = (role: string, text: string): void => {
      const content = text.trim()
      if (!content) return
      const digest = createHash('sha256').update(`${role}\u0000${content}`).digest('hex').slice(0, 24)
      current.push({
        key: `${current.length}:${digest}`,
        role,
        hash: digest,
        tokens: Math.ceil(content.length / 4) + 1,
        preview: content.replace(/\s+/g, ' ').slice(0, 200)
      })
    }

    const finishTurn = (): void => {
      if (!current.some((message) => message.role === 'user')) return
      turn += 1
      turns.push({
        id: `approx:${sessionId}:${turn}`,
        sessionId,
        sessionPath,
        ...(sessionName ? { sessionName } : {}),
        turn,
        request: turn,
        capturedAt: Date.now(),
        totalTokens: current.reduce((sum, message) => sum + message.tokens, 0),
        toolsHash: null,
        messages: current.slice()
      })
    }

    for (const item of items) {
      if (item.kind === 'message' && item.role === 'user') {
        finishTurn()
        current = []
        pushMessage('user', item.text)
        continue
      }
      if (item.kind === 'message') {
        const extra = item.images?.length ? ' [image]' : ''
        pushMessage(item.role, `${item.text}${extra}`)
        continue
      }
      if (item.kind === 'tool') {
        pushMessage('toolResult', `[tool: ${item.name}]${item.label ? ` ${item.label}` : ''}`)
        continue
      }
      if (item.kind === 'custom') {
        pushMessage('custom', `[${item.customType}] ${item.text}`)
      }
    }
    finishTurn()

    if (turns.length === 0) {
      this.approximateTabs.delete(tabId)
      return null
    }
    this.approximateTabs.set(tabId, turns)
    const view = this.buildView(turns.at(-1)!, turns.length > 1 ? turns[turns.length - 2] : null)
    return { ...view, approximate: true }
  }

  /** 当前请求对比默认上一次请求，或指定的快照 */
  getView(tabId: string, baselineId?: string): ContextDiffView | null {
    const exact = this.tabs.get(tabId)
    if (exact && exact.length > 0) {
      const current = exact.at(-1)!
      let baseline: Snapshot | null = null
      if (baselineId) baseline = this.findSnapshot(baselineId)
      else baseline = exact.length >= 2 ? exact[exact.length - 2] : null
      return this.buildView(current, baseline)
    }

    // 没有请求级快照时，用会话历史重建出来的用户轮次作为临时快照。
    const approximate = this.approximateTabs.get(tabId)
    if (!approximate || approximate.length === 0) return null
    const current = approximate.at(-1)!
    const baseline = baselineId
      ? (approximate.find((snapshot) => snapshot.id === baselineId) ?? null)
      : approximate.length >= 2
        ? approximate[approximate.length - 2]
        : null
    return { ...this.buildView(current, baseline), approximate: true }
  }

  listSnapshots(tabId: string): ContextSnapshotRef[] {
    const exact = this.tabs.get(tabId)
    if (exact && exact.length > 0) return exact.map(refOf)
    return (this.approximateTabs.get(tabId) ?? []).map(refOf)
  }

  listSessions(): ContextDiffSession[] {
    this.loadAll()
    return [...this.sessions.values()]
      .filter((history) => history.length > 0)
      .map((history) => {
        const first = history[0]!
        const last = history.at(-1)!
        return {
          sessionId: first.sessionId,
          ...(first.sessionName ? { sessionName: first.sessionName } : {}),
          sessionPath: first.sessionPath,
          first: refOf(first),
          last: refOf(last)
        }
      })
  }

  /** 会话被删除时清掉其索引；只按已记录的 sessionPath 匹配 */
  deleteBySessionPath(sessionPath: string): void {
    for (const [sessionId, history] of this.sessions) {
      if (!history.some((snapshot) => snapshot.sessionPath === sessionPath)) continue
      this.sessions.delete(sessionId)
      for (const [tabId, tabHistory] of this.tabs) {
        const next = tabHistory.filter((snapshot) => snapshot.sessionId !== sessionId)
        if (next.length > 0) this.tabs.set(tabId, next)
        else this.tabs.delete(tabId)
      }
      if (this.dir) {
        try {
          rmSync(this.fileOf(sessionId), { force: true })
        } catch {
          // 删不掉索引不影响会话删除
        }
      }
    }
  }

  detail(_tabId: string, snapshotId: string, key: string): { text: string; truncated: boolean } | null {
    const snapshot = this.findSnapshot(snapshotId)
    if (!snapshot) return null
    const message = snapshot.messages.find((item) => item.key === key)
    if (!message) return null
    let text = this.content.get(message.hash)
    if (!text) {
      text = this.readFromSession(snapshot.sessionPath, message.hash) ?? undefined
      if (text) this.remember(message.hash, text)
    }
    if (!text) return null
    const limit = 256 * 1024
    return text.length > limit
      ? { text: text.slice(0, limit), truncated: true }
      : { text, truncated: false }
  }

  private buildView(current: Snapshot, baseline: Snapshot | null): ContextDiffView {
    const sameSession = Boolean(baseline && baseline.sessionId === current.sessionId)
    const before = baseline?.totalTokens ?? 0
    const after = current.totalTokens

    const systemOf = (snapshot: Snapshot | null): StoredMessage | null =>
      snapshot?.messages.find((message) => message.role === 'system') ?? null
    const currentSystem = systemOf(current)
    const baselineSystem = systemOf(baseline)
    const system =
      !baseline
        ? 'only-current'
        : !baselineSystem && currentSystem
          ? 'only-current'
          : baselineSystem && !currentSystem
            ? 'only-baseline'
            : currentSystem && baselineSystem && currentSystem.hash === baselineSystem.hash
              ? 'same'
              : currentSystem || baselineSystem
                ? 'changed'
                : 'unknown'

    const tools =
      !baseline || !current.toolsHash || !baseline.toolsHash
        ? 'unknown'
        : current.toolsHash === baseline.toolsHash
          ? 'same'
          : 'changed'

    const normalize = (snapshot: Snapshot | null): StoredMessage[] =>
      (snapshot?.messages ?? []).filter((message) => message.role !== 'system')
    const currentMessages = normalize(current)
    const baselineMessages = normalize(baseline)

    const added: StoredMessage[] = []
    const removed: StoredMessage[] = []
    const modified: Array<{ message: StoredMessage; previous: StoredMessage }> = []
    const shared: StoredMessage[] = []

    const alignable =
      sameSession &&
      !current.id.startsWith('approx:') &&
      !baseline?.id.startsWith('approx:')
    if (alignable) {
      // 同一会话先对齐未变化的消息，剩下的同位置、同角色内容对视为修改。
      const pairs = commonMessages(baselineMessages, currentMessages)
      let baseIndex = 0
      let currentIndex = 0
      for (const [baseMatch, currentMatch] of [...pairs, [baselineMessages.length, currentMessages.length] as [number, number]]) {
        const baseGap = baselineMessages.slice(baseIndex, baseMatch)
        const currentGap = currentMessages.slice(currentIndex, currentMatch)
        if (
          baseGap.length > 0 &&
          baseGap.length === currentGap.length &&
          baseGap.every((message, index) => message.role === currentGap[index].role)
        ) {
          modified.push(
            ...currentGap.map((message, index) => ({ message, previous: baseGap[index] }))
          )
        } else {
          removed.push(...baseGap)
          added.push(...currentGap)
        }
        if (baseMatch < baselineMessages.length) shared.push(currentMessages[currentMatch])
        baseIndex = baseMatch + 1
        currentIndex = currentMatch + 1
      }
    } else {
      // 跨会话没有稳定的消息位置，只按 hash 统计共享、新增和删除。
      const baselineCounts = new Map<string, number>()
      for (const message of baselineMessages) {
        baselineCounts.set(message.hash, (baselineCounts.get(message.hash) ?? 0) + 1)
      }
      for (const message of currentMessages) {
        const left = baselineCounts.get(message.hash) ?? 0
        if (left > 0) {
          baselineCounts.set(message.hash, left - 1)
          shared.push(message)
        } else {
          added.push(message)
        }
      }
      removed.push(
        ...baselineMessages.filter((message) => (baselineCounts.get(message.hash) ?? 0) > 0)
      )
    }

    const groups: ContextDiffGroup[] = []
    if (system === 'changed' || system === 'only-current' || system === 'only-baseline') {
      groups.push({ kind: 'system', label: 'System 与工具', messages: [] })
    }
    if (modified.length > 0) {
      groups.push({
        kind: 'modified',
        label: '修改',
        messages: modified.map(({ message, previous }) => ({
          ...summaryOf(message),
          previousKey: previous.key,
          previousPreview: previous.preview
        })),
        tokens: modified.reduce((sum, item) => sum + item.message.tokens, 0)
      })
    }
    if (added.length > 0) {
      groups.push({
        kind: 'added',
        label: sameSession ? '新增' : '仅当前',
        messages: added.map(summaryOf)
      })
    }
    if (removed.length > 0) {
      groups.push({
        kind: 'removed',
        label: sameSession ? '删除' : '仅基线',
        messages: removed.map(summaryOf),
        tokens: removed.reduce((sum, message) => sum + message.tokens, 0)
      })
    }
    if (baseline && before > after * 1.3 && after < before - 1000) {
      groups.push({
        kind: 'compacted',
        label: `上下文被压缩：${Math.round(before / 1000)}k → ${Math.round(after / 1000)}k tokens`,
        messages: [],
        tokens: after
      })
    }

    return {
      current: refOf(current),
      baseline: baseline ? refOf(baseline) : null,
      approximate: false,
      tokens: { before, after },
      system,
      tools,
      toolsApproximate: true,
      counts: {
        added: added.length,
        removed: removed.length,
        modified: modified.length,
        shared: shared.length
      },
      groups
    }
  }

  /** 重启后缓存没了：从会话文件里按同样的 hash 找一条消息 */
  private readFromSession(sessionPath: string | null, targetHash: string): string | null {
    if (!sessionPath || !existsSync(sessionPath)) return null
    let messages = this.sessionText.get(sessionPath)
    if (!messages || !messages.has(targetHash)) {
      messages = new Map()
      try {
        for (const line of readFileSync(sessionPath, 'utf8').split('\n')) {
          if (!line.trim()) continue
          const entry = JSON.parse(line) as {
            type?: string
            message?: { role?: string; content?: unknown; text?: string }
          }
          if (entry.type !== 'message' || !entry.message) continue
          const role = typeof entry.message.role === 'string' ? entry.message.role : 'unknown'
          const text = contentText(entry.message.content) || entry.message.text || ''
          if (!text) continue
          const digest = createHash('sha256').update(`${role}\u0000${text}`).digest('hex').slice(0, 24)
          messages.set(digest, text)
        }
      } catch {
        return null
      }
      this.sessionText.set(sessionPath, messages)
    }
    return messages.get(targetHash) ?? null
  }

  private findSnapshot(id: string): Snapshot | null {
    for (const history of this.sessions.values()) {
      const found = history.find((snapshot) => snapshot.id === id)
      if (found) return found
    }
    const split = id.lastIndexOf(':')
    if (split < 0) return null
    const sessionId = id.slice(0, split)
    const history = this.loadSession(sessionId)
    return history?.find((snapshot) => snapshot.id === id) ?? null
  }

  private loadSession(sessionId: string): Snapshot[] | null {
    const cached = this.sessions.get(sessionId)
    if (cached) return cached
    if (!this.dir) return null
    const file = this.fileOf(sessionId)
    if (!existsSync(file)) return null
    const history: Snapshot[] = []
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const value = JSON.parse(line) as Snapshot
        if (value?.sessionId === sessionId && Array.isArray(value.messages)) history.push(value)
      }
    } catch {
      return null
    }
    const trimmed = trimHistory(history)
    this.sessions.set(sessionId, trimmed)
    return trimmed
  }

  private loadAll(): void {
    if (!this.dir || !existsSync(this.dir)) return
    try {
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.jsonl')) continue
        const sessionId = decodeURIComponent(name.slice(0, -6))
        this.loadSession(sessionId)
      }
    } catch {
      // 读不了索引不影响主流程
    }
  }

  private persist(history: Snapshot[]): void {
    if (!this.dir || history.length === 0) return
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(
        this.fileOf(history[0].sessionId),
        `${history.map((snapshot) => JSON.stringify(snapshot)).join('\n')}\n`,
        'utf8'
      )
    } catch {
      // 索引写不进去只影响跨会话历史，不阻塞请求
    }
  }

  private fileOf(sessionId: string): string {
    return join(this.dir!, `${encodeURIComponent(sessionId)}.jsonl`)
  }

  private remember(hash: string, text: string): void {
    if (!hash || !text || this.content.has(hash)) return
    const size = text.length * 2
    if (size > MAX_CONTENT_BYTES) return
    while (this.contentBytes + size > MAX_CONTENT_BYTES) {
      const oldest = this.content.keys().next().value as string | undefined
      if (!oldest) break
      const old = this.content.get(oldest) ?? ''
      this.contentBytes -= old.length * 2
      this.content.delete(oldest)
    }
    this.content.set(hash, text)
    this.contentBytes += size
  }
}

function trimHistory(history: Snapshot[]): Snapshot[] {
  if (history.length <= MAX_SNAPSHOTS_PER_SESSION) return history
  return [history[0], ...history.slice(-(MAX_SNAPSHOTS_PER_SESSION - 1))]
}
