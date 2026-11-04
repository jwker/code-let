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
      description: '读取浏览器页面摘要、可见文本和可操作元素引用。',
      parameters: Type.Object({
        tabId: Type.Optional(Type.String({ description: '目标标签；省略时用当前活动标签' }))
      }),
      async execute(_id, params) {
        try {
          return result(await call('snapshot', params.tabId ? { tabId: params.tabId } : {}))
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
