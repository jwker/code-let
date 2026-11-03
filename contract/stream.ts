/**
 * 内容流的映射 —— 两条来源收敛到同一份 StreamItem（.ai/task.md · R1 R2 R5）。
 *
 *   历史：会话文件里的 entry  → entriesToItems()
 *   实时：Pi 的会话事件        → applyEvent()
 *
 * 两条路必须画出一样的东西，所以两个 mapper 放在同一个模块里，
 * 靠一条 fixture 测试盯着（tests/stream.test.ts）。
 *
 * 本模块是纯函数，**不 import 任何运行时依赖**：Pi 的类型只在主进程那边，
 * 传过来的已经是普通 JSON —— 这里只按结构认字段。
 */

import type { ReplyStats, StreamItem } from './index'

// ---------------------------------------------------------------------------
// 最小结构：只声明用到的字段，不 import Pi
// ---------------------------------------------------------------------------

interface RawBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: unknown
}

interface RawMessage {
  role?: string
  content?: unknown
  toolCallId?: string
  isError?: boolean
  /** 扩展自定义消息的类型（role === 'custom'） */
  customType?: string
  /** 扩展自定义消息要不要显示（role === 'custom'） */
  display?: boolean
  /** token 用量（Pi 的 usage） */
  usage?: RawUsage
  /** 这次回复的耗时（毫秒） */
  durationMs?: number
  /** 请求发出的时刻（Unix 毫秒） */
  timestamp?: number
  /**
   * 这条助手消息是怎么结束的（Pi 的 StopReason）。
   *
   * 只关心 'aborted' —— 用户中途停掉的那一轮，UI 要标出来。
   * 别的值（stop / toolUse / error / length）现在不影响渲染。
   */
  stopReason?: string
}

interface RawUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

interface RawEntry {
  type?: string
  message?: RawMessage
  /** type === 'custom_message' 时的字段 */
  customType?: string
  content?: unknown
  display?: boolean
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 扩展自定义消息的显示名；空值也给一个占位 */
function customTypeOf(value: string | undefined): string {
  return value && value.trim() ? value : 'custom'
}

/** 取消息里的纯文本（content 可能是字符串，也可能是内容块数组） */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content as RawBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** 取助手消息里的文本（跳过 thinking 与 toolCall） */
function assistantText(message: RawMessage): string {
  if (!Array.isArray(message.content)) return ''
  let out = ''
  for (const block of message.content as RawBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * 工具行上显示的摘要 —— 命令类工具给命令本身（`bash` 的 command）。
 * 没有摘要就只显示工具名。
 */
function toolLabel(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' && command ? command : undefined
}

/**
 * 取助手消息的 token 与耗时 —— 两条来源给的是同一份（历史 jsonl 与实时事件）。
 *
 * token 与耗时各管各的：有的模型只报耗时不报 token，
 * 所以 usage 缺失也要留下这一项（不然耗时也跟着丢了）。
 */
function statsOf(message: RawMessage): ReplyStats | undefined {
  const usage = message.usage
  const durationMs = typeof message.durationMs === 'number' ? message.durationMs : undefined
  if (!usage && durationMs === undefined) return undefined
  const result: ReplyStats = {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0
  }
  if (durationMs !== undefined) result.durationMs = durationMs
  if (typeof message.timestamp === 'number') result.startedAt = message.timestamp
  return result
}

/** 造一个工具项（摘要有就带上） */
function toolItem(
  callId: string,
  name: string,
  status: 'running' | 'ok' | 'error',
  args: unknown
): StreamItem {
  const label = toolLabel(args)
  return label
    ? { kind: 'tool', callId, name, status, label }
    : { kind: 'tool', callId, name, status }
}

/** 改一个工具项的状态 */
function setToolStatus(items: StreamItem[], callId: string, status: 'running' | 'ok' | 'error'): StreamItem[] {
  if (!callId) return items
  const index = items.findIndex((item) => item.kind === 'tool' && item.callId === callId)
  if (index < 0) return items
  const tool = items[index]
  if (tool.kind !== 'tool' || tool.status === status) return items
  const next = items.slice()
  next[index] = { ...tool, status }
  return next
}

/** 找某个工具调用对应的输出项（从后往前找） */
function findToolResultIndex(items: readonly StreamItem[], callId: string): number {
  if (!callId) return -1
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind === 'message' && item.role === 'toolResult' && item.callId === callId) return i
  }
  return -1
}

/** 找最后一条助手消息项 */
function findLastAssistantIndex(items: readonly StreamItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item.kind === 'message' && item.role === 'assistant') return i
  }
  return -1
}

/** 取助手消息里嵌着的工具调用 */
function toolCallsOf(message: RawMessage): RawBlock[] {
  if (!Array.isArray(message.content)) return []
  return (message.content as RawBlock[]).filter((block) => block?.type === 'toolCall')
}

/**
 * 工具输出项：建或者就地更新。
 *
 * 工具跑的过程中会先来一段「中途输出」，跑完才来最终输出 —— 两者是**同一项**，
 * 不能叠成两块，否则屏幕上会出现两份输出（R4）。
 */
function upsertToolResult(
  items: StreamItem[],
  callId: string,
  text: string
): StreamItem[] {
  const index = findToolResultIndex(items, callId)
  if (index >= 0) {
    const existing = items[index]
    if (existing.kind !== 'message' || !text || existing.text === text) return items
    const next = items.slice()
    next[index] = { ...existing, text }
    return next
  }
  if (!text) return items
  return [...items, { kind: 'message', role: 'toolResult', text, callId }]
}

// ---------------------------------------------------------------------------
// 历史 → items
// ---------------------------------------------------------------------------

/**
 * 会话文件里的 entry 数组 → 内容流。
 *
 * 助手消息里嵌着工具调用，这里就拆成独立的 tool item —— 晚拆不如早拆，
 * 渲染器不用再为两种形态各写一套。
 */
export function entriesToItems(entries: readonly unknown[]): StreamItem[] {
  const items: StreamItem[] = []
  const toolIndex = new Map<string, number>()

  for (const raw of entries) {
    const entry = raw as RawEntry | null
    if (!entry) continue

    /*
     * 扩展的 custom_message：只有 display 为 true 才画。
     * type === 'custom' 是扩展状态（不参与上下文、没有标准显示），这里跳过 ——
     * 跟 TUI 一样：没注册 entry renderer 就不画。
     */
    if (entry.type === 'custom_message') {
      if (!entry.display) continue
      items.push({
        kind: 'custom',
        customType: customTypeOf(entry.customType),
        text: textOf(entry.content)
      })
      continue
    }

    if (entry.type !== 'message') continue
    const message = entry.message
    if (!message) continue

    if (message.role === 'user') {
      const text = textOf(message.content)
      if (text) items.push({ kind: 'message', role: 'user', text })
      continue
    }

    if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? (message.content as RawBlock[]) : []
      const stats = statsOf(message)
      const aborted = message.stopReason === 'aborted'
      // 一条助手消息可能拆成好几项（正文与工具交替）——
      // 计量挂在它产生的**第一项**正文上（后面由渲染层按轮聚合）
      const start = items.length
      let buffer = ''
      const flush = (): void => {
        if (!buffer) return
        items.push({ kind: 'message', role: 'assistant', text: buffer })
        buffer = ''
      }
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          buffer += block.text
        } else if (block?.type === 'toolCall') {
          // 工具是消息之间的动作，单独成项
          flush()
          const callId = block.id ?? ''
          toolIndex.set(callId, items.length)
          items.push(toolItem(callId, block.name ?? 'tool', 'running', block.arguments))
        }
        // thinking 这一轮不显示
      }
      flush()
      // 这一条消息产生的第一项正文 —— 计量和中止标记挂上去。
      // 挂第一项就行：中止后面不会再有内容，渲染层按轮聚合时从头找得到。
      if (stats || aborted) {
        for (let i = start; i < items.length; i += 1) {
          const item = items[i]
          if (item.kind === 'message' && item.role === 'assistant') {
            items[i] = { ...item, ...(stats ? { stats } : {}), ...(aborted ? { aborted } : {}) }
            break
          }
        }
      }
      continue
    }

    if (message.role === 'toolResult') {
      const callId = message.toolCallId ?? ''
      const index = toolIndex.get(callId)
      if (index !== undefined && items[index].kind === 'tool') {
        const tool = items[index]
        if (tool.kind === 'tool') items[index] = { ...tool, status: message.isError ? 'error' : 'ok' }
      }
      const text = textOf(message.content)
      // 带上 callId —— 跟实时流里的中途输出对上同一项（R4）
      if (text) items.push({ kind: 'message', role: 'toolResult', text, callId })
      continue
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// 载荷整形
// ---------------------------------------------------------------------------

/**
 * 削 `message_update` 的载荷（PLAN.md D5 补充）。
 *
 * 原载荷是 `{ message: 累积到现在的整条消息, assistantMessageEvent }` ——
 * 每来一个 delta 就把整条消息重发一遍：一条 10KB 回复、200 次 delta 就是 2MB IPC，
 * 还会撞上载荷上限被截断，实时流当场断掉（R6）。
 *
 * 只削这一条通道，其余事件原样转发 —— 渲染进程仍按类型分派 Pi 的原始事件。
 */
export function trimMessageUpdate(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data
  const source = data as { assistantMessageEvent?: unknown }
  const event = source.assistantMessageEvent
  if (!event || typeof event !== 'object') return data
  const fields = event as Record<string, unknown>
  const trimmed: Record<string, unknown> = { type: fields.type }
  if (typeof fields.contentIndex === 'number') trimmed.contentIndex = fields.contentIndex
  if (typeof fields.delta === 'string') trimmed.delta = fields.delta
  if (typeof fields.content === 'string') trimmed.content = fields.content
  return trimmed
}

// ---------------------------------------------------------------------------
// IPC 前的会话事件整形
// ---------------------------------------------------------------------------

/** 单条事件里的文本最多留这么多字符；再长就截断，保证事件不会撞 IPC 上限 */
export const MAX_EVENT_TEXT_CHARS = 32_000

function compactContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content
  const blocks: unknown[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as RawBlock).type === 'image') {
      // 图片数据只给模型，内容流不显示；留着会把整条 message_start 撞过 IPC 上限
      continue
    }
    const raw = block as RawBlock | null
    if (raw?.type === 'text' && typeof raw.text === 'string' && raw.text.length > MAX_EVENT_TEXT_CHARS) {
      blocks.push({
        ...raw,
        text: `${raw.text.slice(0, MAX_EVENT_TEXT_CHARS)}\n\n…（内容过长，已截断）`
      })
    } else {
      blocks.push(block)
    }
  }
  return blocks
}

/**
 * 在会话事件进 IPC 前做一次整形。
 *
 * 重点是用户带图片的 `message_start/message_end`：图片 base64 动辄几百 KB，
 * 整条事件被 `capPayload()` 截断后，渲染层连 role/text 都解析不出来 ——
 * 用户消息不显示，后面的助手增量就会落到上一条回答上。
 */
export function compactSessionEvent(event: { type: string; data: unknown }): {
  type: string
  data: unknown
} {
  const data = (event.data ?? {}) as Record<string, unknown>

  if (event.type === 'message_start' || event.type === 'message_end') {
    const message = data.message as RawMessage | undefined
    if (message && Array.isArray(message.content)) {
      return {
        ...event,
        data: { ...data, message: { ...message, content: compactContent(message.content) } }
      }
    }
  }

  if (event.type === 'tool_execution_update') {
    const partial = data.partialResult as { content?: unknown } | undefined
    if (partial && Array.isArray(partial.content)) {
      return {
        ...event,
        data: { ...data, partialResult: { ...partial, content: compactContent(partial.content) } }
      }
    }
  }

  return event
}

// ---------------------------------------------------------------------------
// 实时事件 → items
// ---------------------------------------------------------------------------

/**
 * 把一条 Pi 会话事件落到 items 上。
 *
 * 事件原样透传（D5），只有 `message_update` 在主进程削过载荷：
 * `{ message: 整条累积消息, assistantMessageEvent }` → `{ type, contentIndex, delta }`。
 */
/**
 * 这条事件之后，「这个标签正在跑」是真是假。
 *
 * 单独抽出来（不进 `applyEvent`）是因为它管的是**状态**不是**内容** ——
 * 而且 node 环境下没有 window，测不了 store，只能测纯函数。
 *
 * 三个阶段对应三件事：
 *   - `agent_start`      Pi 开始跑了。**比首 token 早得多** —— 中间那段是
 *                        `await streamFunction(...)`，也就是 TTFT，实测几秒。
 *                        只认助手消息的 message_start 的话，这几秒界面上没有
 *                        任何「在跑」的迹象。
 *   - `message_start`    又一个兜底：某些路径可能不经过 agent_start。
 *   - `agent_settled`    这一轮结束（成功、出错、被中止都会发 —— Pi 在
 *                        `finally` 里调 `_emitAgentSettled()`）。
 */
export function nextStreaming(streaming: boolean, event: { type: string; data: unknown }): boolean {
  if (event.type === 'agent_settled') return false
  if (event.type === 'agent_start') return true
  if (event.type === 'message_start') {
    const role = (event.data as { message?: { role?: string } } | undefined)?.message?.role
    if (role === 'assistant') return true
  }
  return streaming
}

export function applyEvent(items: StreamItem[], event: { type: string; data: unknown }): StreamItem[] {
  const data = (event.data ?? {}) as Record<string, unknown>

  switch (event.type) {
    case 'message_start': {
      const message = data.message as RawMessage | undefined
      if (!message) return items
      const role = message.role
      if (role === 'custom') {
        if (!message.display) return items
        return [
          ...items,
          {
            kind: 'custom',
            customType: customTypeOf(message.customType),
            text: textOf(message.content)
          }
        ]
      }
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return items
      if (role === 'toolResult') {
        // 工具结果：中途输出可能已经建过一项 —— 别叠成两块（R4）
        const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
        return upsertToolResult(items, callId, textOf(message.content))
      }
      // 用户消息在 start 时内容就是全的；助手消息是空壳，靠 delta 一点点长出来
      const text = role === 'assistant' ? '' : textOf(message.content)
      // 助手消息先挂一份空用量 —— 回复结束时再换真的
      const stats = role === 'assistant' ? statsOf(message) : undefined
      return [...items, { kind: 'message', role, text, ...(stats ? { stats } : {}) }]
    }

    case 'message_update': {
      // 削过的载荷：只带增量和它在消息里的位置
      if (data.type !== 'text_delta') return items
      const delta = typeof data.delta === 'string' ? data.delta : ''
      if (!delta) return items
      const last = items[items.length - 1]
      if (last && last.kind === 'message' && last.role === 'assistant') {
        const next = items.slice()
        next[next.length - 1] = { ...last, text: last.text + delta }
        return next
      }
      /*
       * 没有正在流的助手消息项 —— 补一个再追加。
       *
       * 什么时候会这样：**错过了 message_start**。典型是页面刷新之后 ——
       * 内容流重新从磁盘读回来，里面只有已经落盘的消息（用户那条），
       * 而正在生成的那条还没进会话文件，所以读不到。
       *
       * 早先这里是 `return items`（直接丢掉 delta）。后果是刷新后正在流的那一轮
       * 完全卡住：内容一动不动，直到 message_end 才一次性补齐（实测卡了 19 秒）。
       *
       * 补一个空壳是安全的：Pi 一次只流一条助手消息，所以「最后一项不是助手消息」
       * 只可能是缺了开头，不可能是别的消息插进来。
       */
      return [...items, { kind: 'message', role: 'assistant', text: delta }]
    }

    case 'message_end': {
      const message = data.message as RawMessage | undefined
      if (!message) return items
      const role = message.role
      if (role === 'custom') {
        if (!message.display) return items
        const customType = customTypeOf(message.customType)
        const text = textOf(message.content)
        const last = items[items.length - 1]
        // 正常路径：message_start 已经建过这一项，这里只补最终正文
        if (last && last.kind === 'custom' && last.customType === customType) {
          if (last.text === text) return items
          const next = items.slice()
          next[next.length - 1] = { ...last, text }
          return next
        }
        return [...items, { kind: 'custom', customType, text }]
      }
      if (role !== 'user' && role !== 'assistant' && role !== 'toolResult') return items

      if (role === 'toolResult') {
        const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
        return upsertToolResult(items, callId, textOf(message.content))
      }

      if (role === 'assistant') {
        const text = assistantText(message)
        const calls = toolCallsOf(message)
        const stats = statsOf(message)
        // 中止的标记跟计量一样挂在这条消息的正文项上
        const aborted = message.stopReason === 'aborted'
        const marks = { ...(stats ? { stats } : {}), ...(aborted ? { aborted } : {}) }
        // 工具调用在这里落地成独立的 tool 项 —— 跟历史那条路同一个来源（R3）
        const toolItems: StreamItem[] = calls.map((call) =>
          toolItem(call.id ?? '', call.name ?? 'tool', 'running', call.arguments)
        )
        // 这条助手消息的位置：正常就是最后一项（message_start 推的）
        const last = items[items.length - 1]
        const index =
          last && last.kind === 'message' && last.role === 'assistant'
            ? items.length - 1
            : findLastAssistantIndex(items)
        if (index < 0) {
          // 没有对应的助手消息项（没走到 message_start）—— 工具项照建
          const created: StreamItem[] = text ? [{ kind: 'message', role, text, ...marks }] : []
          return [...items, ...created, ...toolItems]
        }
        const current = items[index]
        if (current.kind !== 'message') return items
        const next = items.slice()
        if (text) {
          next[index] = { ...current, text, ...marks }
          next.splice(index + 1, 0, ...toolItems)
        } else {
          // 只有工具调用、没有文本的助手消息不留空气泡
          next.splice(index, 1, ...toolItems)
        }
        return next
      }

      const text = textOf(message.content)
      const last = items[items.length - 1]
      if (!last || last.kind !== 'message' || last.role !== role) {
        return text ? [...items, { kind: 'message', role, text }] : items
      }
      if (last.text === text) return items
      const next = items.slice()
      next[next.length - 1] = { ...last, text }
      return next
    }

    case 'tool_execution_start': {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
      const name = typeof data.toolName === 'string' ? data.toolName : 'tool'
      // 工具项通常在助手消息结束时已经建好了 —— 这里只补漏，别重复建
      const index = items.findIndex((item) => item.kind === 'tool' && item.callId === callId)
      if (index >= 0) {
        const tool = items[index]
        if (tool.kind !== 'tool' || tool.label) return items
        // 摘要这时才拿到（助手消息里没带参数）—— 补上
        const label = toolLabel(data.args)
        if (!label) return items
        const next = items.slice()
        next[index] = { ...tool, label }
        return next
      }
      return [...items, toolItem(callId, name, 'running', data.args)]
    }

    case 'tool_execution_update': {
      // 工具跑到一半吐出来的输出 —— 边跑边显示（R4）
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
      if (!callId) return items
      const partial = data.partialResult as { content?: unknown } | undefined
      return upsertToolResult(items, callId, textOf(partial?.content))
    }

    case 'tool_execution_end': {
      const callId = typeof data.toolCallId === 'string' ? data.toolCallId : ''
      return setToolStatus(items, callId, data.isError ? 'error' : 'ok')
    }

    default:
      return items
  }
}
