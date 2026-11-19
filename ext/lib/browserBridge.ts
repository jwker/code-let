import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * 扩展 ↔ 宿主的请求通道（EventBus）。
 *
 * 浏览器工具和块清单工具都走这一条：扩展发一个带 id 的请求，运行时转给宿主，
 * 宿主操作完把结果带回 `browser:response`。没有新开 IPC 形状。
 *
 * 放在 `ext/lib/` 而不是 `ext/` 根下：根目录的每个 .js 都会被 Pi 当成一个扩展加载，
 * 这个文件没有默认导出，放根目录会报「扩展格式不对」。
 */

interface Response {
  id?: string
  ok?: boolean
  result?: unknown
  error?: string
}

/** 工具结果里可以带图片；截图就靠这个进模型上下文 */
export interface ImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

/** 向宿主发一次请求；宿主 10 秒不回就算超时 */
export function request(
  pi: ExtensionAPI,
  tool: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `browser-${Date.now()}-${Math.random().toString(36).slice(2)}`
    let done = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe = (): void => {}
    const finish = (): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      unsubscribe()
    }
    timer = setTimeout(() => {
      finish()
      reject(new Error('浏览器工具超时'))
    }, 10_000)
    unsubscribe = pi.events.on('browser:response', (data) => {
      const response = data as Response
      if (response.id !== id) return
      finish()
      if (response.ok) resolve(response.result)
      else reject(new Error(response.error || '浏览器工具执行失败'))
    })
    pi.events.emit('browser:request', { id, tool, args })
  })
}

/** 普通结果：JSON 文本，太长就截断（详情里留完整值） */
export function result(value: unknown): {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
} {
  const text = JSON.stringify(value, null, 2)
  return {
    content: [
      {
        type: 'text',
        text: text.length > 16_000 ? `${text.slice(0, 16_000)}\n…（截断）` : text
      }
    ],
    details: value
  }
}

/** 失败结果：给模型看的是一句人话，详情里留原始错误 */
export function failure(error: unknown): {
  content: Array<{ type: 'text'; text: string }>
  details: unknown
} {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: `浏览器工具失败：${message}` }],
    details: { error: message }
  }
}
