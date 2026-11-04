import { createHash } from 'node:crypto'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * 把每次模型请求前的完整上下文压成一份索引，交给 Codelet 的右侧栏做 diff。
 *
 * 这里只做观察：不返回 messages，不修改请求。索引里带全文是为了主进程能按需提供详情；
 * 主进程持久化时会去掉全文，只留 preview。
 */

interface RawMessage {
  role?: string
  content?: unknown
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  let out = ''
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const item = block as { type?: string; text?: string; name?: string }
    if (item.type === 'text' && typeof item.text === 'string') {
      out += item.text
    } else if (item.type === 'image') {
      out += '[image]'
    } else if (item.type === 'toolCall' && typeof item.name === 'string') {
      out += `[tool: ${item.name}]`
    }
  }
  return out
}

function toolsFingerprint(pi: ExtensionAPI): string | null {
  try {
    const active = new Set(pi.getActiveTools())
    const tools = pi
      .getAllTools()
      .filter((tool) => active.has(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines
      }))
    return hash(JSON.stringify(tools))
  } catch {
    // 不同 Pi 版本的工具 API 可能不同；拿不到就只依赖 systemHash
    return null
  }
}

export default function contextDiffExtension(pi: ExtensionAPI): void {
  pi.on('context_with_system', (event, ctx) => {
    try {
      const messages = (event.messages as RawMessage[]).map((message, index) => {
        const role = typeof message.role === 'string' ? message.role : 'unknown'
        const text = textOf(message.content)
        return {
          key: `${index}:${hash(`${role}\u0000${text}`)}`,
          role,
          text,
          hash: hash(`${role}\u0000${text}`),
          tokens: Math.ceil(text.length / 4) + 1,
          preview: text.replace(/\s+/g, ' ').slice(0, 200)
        }
      })

      pi.events.emit('context-diff:snapshot', {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        sessionName: ctx.sessionManager.getSessionName(),
        capturedAt: Date.now(),
        toolsHash: toolsFingerprint(pi),
        messages
      })
    } catch {
      // 观察型扩展失败不能影响模型请求
    }
  })
}
