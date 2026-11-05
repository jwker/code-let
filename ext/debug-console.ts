import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * 调试控制台的采集扩展。
 *
 * 监听四个钩子，把一次模型请求的完整内容收集起来，通过 EventBus 交给主进程落盘：
 * - `context_with_system`：Pi 拼好的 transcript（含系统消息）。
 * - `before_provider_request`：provider 真正收到的原始 payload。
 * - `after_provider_response`：状态码与响应头。
 * - `message_end`：最终那条助手消息。
 *
 * 一次 LLM 调用记一条。agent 循环里每调用一次模型就是一条 —— 所以工具调用密集的
 * 一次输入会产生好几条记录。
 *
 * 这里只做采集和转交：不写文件、不做重活，写盘和配额都在主进程。
 */

/** 一次请求收集到的东西 */
interface PendingRecord {
  id: string
  sessionId: string
  sessionName: string | null
  /** 列表里显示的会话标题 */
  sessionTitle: string
  /** 触发这次请求的那条用户消息 —— 同一会话里的多次请求靠它区分 */
  prompt: string | null
  /** 这次请求在哪个目录下跑的 */
  cwd: string | null
  model: { provider: string; id: string } | null
  capturedAt: number
  /** 时间点：请求发出、收到响应头、消息定稿 */
  timing: { startedAt: number; headersAt: number | null; endedAt: number | null }
  /** Pi 侧的 transcript */
  transcript: unknown
  /** provider 的原始 payload */
  provider: unknown
  /** 响应：状态码、响应头、最终那条助手消息 */
  response: {
    status: number | null
    headers: Record<string, string>
    message: unknown
  }
}

/** 只留诊断需要的响应头 —— 凭据类的字段一律不留 */
const HEADER_WHITELIST = ['content-type', 'content-length', 'request-id', 'x-request-id', 'retry-after']

/** 消息里的纯文本 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const item = block as { type?: string; text?: string }
    if (item.type === 'text' && typeof item.text === 'string') out += item.text
  }
  return out
}

/**
 * transcript 里首条用户消息的文本。
 *
 * 会话的自定义名字大多数时候是空的 —— 那时用首条用户消息当标题，
 * 跟侧栏的对话标题一个口径（见 host/main/pi/runtime.ts 的 pickTitle）。
 */
function firstUserText(messages: unknown): string {
  return userText(messages, 'first')
}

/**
 * transcript 里最后一条用户消息的文本。
 *
 * 那一条正是触发这次请求的消息 —— 同一个会话里的多次请求靠它区分开。
 */
function lastUserText(messages: unknown): string {
  return userText(messages, 'last')
}

function userText(messages: unknown, which: 'first' | 'last'): string {
  if (!Array.isArray(messages)) return ''
  const found: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const item = message as { role?: string; content?: unknown }
    if (item.role !== 'user') continue
    const text = textOf(item.content).trim()
    if (!text) continue
    if (which === 'first') return text
    found.push(text)
  }
  return found.length > 0 ? found[found.length - 1]! : ''
}

/** 自定义名字优先，没有就退回首条用户消息 */
function pickTitle(name: string | undefined, firstMessage: string): string {
  const raw = (name?.trim() ? name : firstMessage).trim()
  if (!raw) return '未命名对话'
  const oneLine = raw.replace(/\s+/g, ' ')
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine
}

/** 压成一行，超长截断 */
function oneLine(text: string, limit: number): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

export default function debugConsole(pi: ExtensionAPI): void {
  let seq = 0
  let pending: PendingRecord | null = null

  const flush = (): void => {
    if (!pending) return
    const record = pending
    pending = null
    // 没走到 message_end 的（报错、中断）—— 到这一刻就是结束
    if (record.timing.endedAt === null) record.timing.endedAt = Date.now()
    try {
      pi.events.emit('debug-console:record', record)
    } catch {
      // 采集失败不能影响模型请求
    }
  }

  pi.on('context_with_system', (event, ctx) => {
    // 上一次没走到 message_end —— 请求报错或者被中断了，先把它记下来
    flush()
    seq += 1
    pending = {
      id: `t${Date.now()}-${seq}`,
      sessionId: ctx.sessionManager.getSessionId(),
      sessionName: ctx.sessionManager.getSessionName() ?? null,
      cwd: ctx.cwd,
      sessionTitle: pickTitle(
        ctx.sessionManager.getSessionName(),
        firstUserText(event.messages)
      ),
      prompt: oneLine(lastUserText(event.messages), 120),
      model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
      capturedAt: Date.now(),
      timing: { startedAt: Date.now(), headersAt: null, endedAt: null },
      transcript: { messages: event.messages },
      provider: null,
      response: { status: null, headers: {}, message: null }
    }
  })

  pi.on('before_provider_request', (event) => {
    if (!pending) return
    pending.provider = event.payload
    // 真正发给 provider 的那一刻 —— 耗时从这儿算
    pending.timing.startedAt = Date.now()
  })

  pi.on('after_provider_response', (event) => {
    if (!pending) return
    const headers: Record<string, string> = {}
    const source = (event.headers ?? {}) as Record<string, unknown>
    for (const key of HEADER_WHITELIST) {
      const value = source[key]
      if (typeof value === 'string') headers[key] = value
    }
    pending.response = { ...pending.response, status: event.status, headers }
    pending.timing.headersAt = Date.now()
  })

  pi.on('message_end', (event) => {
    if (!pending) return
    const message = event.message as { role?: string }
    // 用户消息、工具结果也会走 message_end —— 只认助手消息
    if (message?.role !== 'assistant') return
    pending.response = { ...pending.response, message: event.message }
    pending.timing.endedAt = Date.now()
    flush()
  })

  pi.on('agent_end', () => {
    flush()
  })
}
