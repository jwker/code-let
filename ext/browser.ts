import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * 把右侧浏览器暴露成 agent 工具。
 *
 * 工具不改文件，只通过 EventBus 请求宿主操作现有的 WebContentsView；
 * 浏览器地址的本地页面限制仍由主进程校验，agent 不能绕过去。
 */

interface Response {
  id?: string
  ok?: boolean
  result?: unknown
  error?: string
}

/** 工具结果里可以带图片；截图就靠这个进模型上下文 */
interface ImageBlock {
  type: 'image'
  data: string
  mimeType: string
}

function request(pi: ExtensionAPI, tool: string, args: Record<string, unknown>): Promise<unknown> {
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

function result(value: unknown): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
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

/** 截图结果：文字说明 + 图片本身 */
function screenshotResult(value: {
  ok?: boolean
  error?: string
  mimeType?: string
  data?: string
  width?: number
  height?: number
}): {
  content: Array<{ type: 'text'; text: string } | ImageBlock>
  details: unknown
} {
  if (!value.ok || !value.data || !value.mimeType) {
    return {
      content: [{ type: 'text', text: `截图失败：${value.error ?? '未知原因'}` }],
      details: value
    }
  }
  return {
    content: [
      { type: 'text', text: `已截取页面（${value.width}×${value.height}）` },
      { type: 'image', data: value.data, mimeType: value.mimeType }
    ],
    details: { width: value.width, height: value.height }
  }
}

function failure(error: unknown): { content: Array<{ type: 'text'; text: string }>; details: unknown } {
  const message = error instanceof Error ? error.message : String(error)
  return {
    content: [{ type: 'text', text: `浏览器工具失败：${message}` }],
    details: { error: message }
  }
}

export default function browserExtension(pi: ExtensionAPI): void {
  const call = (tool: string, args: Record<string, unknown> = {}) => request(pi, tool, args)

  pi.registerTool(
    defineTool({
      name: 'browser_tabs',
      label: 'Browser tabs',
      description: '列出 Codelet 右侧浏览器当前打开的标签和 URL。',
      parameters: Type.Object({}),
      async execute() {
        try {
          return result(await call('tabs'))
        } catch (error) {
          return failure(error)
        }
      }
    })
  )

  pi.registerTool(
    defineTool({
      name: 'browser_open',
      label: 'Open browser tab',
      description: '在 Codelet 右侧浏览器打开一个新的本地页面标签。',
      parameters: Type.Object({
        url: Type.String({ description: '本地页面地址，例如 http://localhost:5173/' })
      }),
      async execute(_id, params) {
        try {
          return result(await call('open', { url: params.url }))
        } catch (error) {
          return failure(error)
        }
      }
    })
  )

  pi.registerTool(
    defineTool({
      name: 'browser_navigate',
      label: 'Navigate browser',
      description: '让浏览器标签导航到本地页面。',
      parameters: Type.Object({
        url: Type.String({ description: '要打开的本地页面地址' }),
        tabId: Type.Optional(Type.String({ description: '目标标签；省略时用当前活动标签' }))
      }),
      async execute(_id, params) {
        try {
          return result(await call('navigate', { url: params.url, ...(params.tabId ? { tabId: params.tabId } : {}) }))
        } catch (error) {
          return failure(error)
        }
      }
    })
  )

  pi.registerTool(
    defineTool({
      name: 'browser_snapshot',
      label: 'Browser snapshot',
      description:
        '读取浏览器页面摘要、可见文本和可操作元素引用。元素很多时用 offset/limit 分页取。',
      parameters: Type.Object({
        tabId: Type.Optional(Type.String({ description: '目标标签；省略时用当前活动标签' })),
        offset: Type.Optional(Type.Number({ description: '从第几个元素开始；默认 0' })),
        limit: Type.Optional(Type.Number({ description: '本页最多取多少个元素；默认 80，最多 200' }))
      }),
      async execute(_id, params) {
        try {
          return result(
            await call('snapshot', {
              ...(params.tabId ? { tabId: params.tabId } : {}),
              ...(params.offset !== undefined ? { offset: params.offset } : {}),
              ...(params.limit !== undefined ? { limit: params.limit } : {})
            })
          )
        } catch (error) {
          return failure(error)
        }
      }
    })
  )

  pi.registerTool(
    defineTool({
      name: 'browser_click',
      label: 'Browser click',
      description: '点击浏览器快照里的元素引用。',
      parameters: Type.Object({
        ref: Type.String({ description: 'browser_snapshot 返回的 ref，例如 e3' }),
        tabId: Type.Optional(Type.String({ description: '目标标签；省略时用当前活动标签' }))
      }),
      async execute(_id, params) {
        try {
          return result(await call('click', { ref: params.ref, ...(params.tabId ? { tabId: params.tabId } : {}) }))
        } catch (error) {
          return failure(error)
        }
      }
    })
  )

  pi.registerTool(
    defineTool({
      name: 'browser_screenshot',
      label: 'Browser screenshot',
      description: '截取浏览器当前页面的图片，用来确认页面视觉布局。',
      parameters: Type.Object({
        tabId: Type.Optional(Type.String({ description: '目标标签；省略时用当前活动标签' }))
      }),
      async execute(_id, params) {
        try {
          const value = await call('screenshot', params.tabId ? { tabId: params.tabId } : {})
          return screenshotResult(value as Parameters<typeof screenshotResult>[0])
        } catch (error) {
          return failure(error)
        }
      }
    })
  )

  pi.registerTool(
    defineTool({
      name: 'browser_wait',
      label: 'Browser wait',
      description: '等待页面条件成立：给了 selector 就等它出现，否则等页面加载完成。',
      parameters: Type.Object({
        selector: Type.Optional(Type.String({ description: '要等待出现的 CSS 选择器' })),
        timeoutMs: Type.Optional(Type.Number({ description: '最多等多少毫秒；默认 10000，最多 30000' })),
        tabId: Type.Optional(Type.String({ description: '目标标签；省略时用当前活动标签' }))
      }),
      async execute(_id, params) {
        try {
          return result(
            await call('wait', {
              ...(params.selector ? { selector: params.selector } : {}),
              ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
              ...(params.tabId ? { tabId: params.tabId } : {})
            })
          )
        } catch (error) {
          return failure(error)
        }
      }
    })
  )

  pi.registerTool(
    defineTool({
      name: 'browser_type',
      label: 'Browser type',
      description: '向浏览器快照里的输入元素写入文字并触发 input/change。',
      parameters: Type.Object({
        ref: Type.String({ description: 'browser_snapshot 返回的 ref，例如 e2' }),
        text: Type.String({ description: '要写入的文字' }),
        tabId: Type.Optional(Type.String({ description: '目标标签；省略时用当前活动标签' }))
      }),
      async execute(_id, params) {
        try {
          return result(
            await call('type', {
              ref: params.ref,
              text: params.text,
              ...(params.tabId ? { tabId: params.tabId } : {})
            })
          )
        } catch (error) {
          return failure(error)
        }
      }
    })
  )
}
