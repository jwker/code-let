import { describe, expect, it } from 'vitest'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import browserBlocksExtension, { BLOCK_GUIDELINES } from '../ext/browserBlocks'

/**
 * `browser_blocks` 扩展的形状。
 *
 * 不跑 Pi：拿一个假的 ExtensionAPI 接住 `registerTool` 的定义，看它
 * 注册了什么工具、带没带四条保号规矩、请求走的是不是既有的事件通道。
 */

interface RegisteredTool {
  name: string
  description: string
  promptSnippet?: string
  promptGuidelines?: string[]
  execute: (id: string, params: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text?: string }>
    details: unknown
  }>
}

function fakePi(): {
  pi: ExtensionAPI
  tools: RegisteredTool[]
  requests: Array<{ id: string; tool: string; args: Record<string, unknown> }>
  respond: (payload: { id?: string; ok?: boolean; result?: unknown; error?: string }) => void
} {
  const tools: RegisteredTool[] = []
  const requests: Array<{ id: string; tool: string; args: Record<string, unknown> }> = []
  const listeners = new Set<(payload: unknown) => void>()
  const pi = {
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool)
    },
    events: {
      on: (channel: string, listener: (payload: unknown) => void) => {
        if (channel !== 'browser:response') return () => {}
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      emit: (channel: string, payload: unknown) => {
        if (channel !== 'browser:request') return
        requests.push(payload as (typeof requests)[number])
      }
    }
  } as unknown as ExtensionAPI
  return {
    pi,
    tools,
    requests,
    respond: (payload) => {
      for (const listener of listeners) listener(payload)
    }
  }
}

describe('browser_blocks 扩展', () => {
  it('注册一个工具，名字与参数都对', () => {
    const { pi, tools } = fakePi()
    browserBlocksExtension(pi)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('browser_blocks')
    expect(tools[0].description).toContain('块清单')
    expect(tools[0].promptSnippet).toContain('块清单')
  })

  it('四条保号规矩挂在工具上，不是全局提示', () => {
    const { pi, tools } = fakePi()
    browserBlocksExtension(pi)
    const guidelines = tools[0].promptGuidelines ?? []
    expect(guidelines).toHaveLength(4)
    expect(guidelines).toEqual(BLOCK_GUIDELINES)
    expect(guidelines.join('\n')).toContain('保住已有的号')
    expect(guidelines.join('\n')).toContain('不重排')
    expect(guidelines.join('\n')).toContain('不复用')
    expect(guidelines.join('\n')).toContain('明说')
  })

  it('走既有的请求通道，拿回宿主给的块清单', async () => {
    const { pi, tools, requests, respond } = fakePi()
    browserBlocksExtension(pi)
    const pending = tools[0].execute('call-1', {})
    expect(requests).toHaveLength(1)
    expect(requests[0].tool).toBe('blocks')
    respond({
      id: requests[0].id,
      ok: true,
      result: { file: 'preview/pricing.html', blocks: [{ block: 4 }] }
    })
    const response = await pending
    expect(response.content[0].text).toContain('preview/pricing.html')
    expect(response.details).toEqual({ file: 'preview/pricing.html', blocks: [{ block: 4 }] })
  })

  it('宿主报错时给模型一句人话', async () => {
    const { pi, tools, requests, respond } = fakePi()
    browserBlocksExtension(pi)
    const pending = tools[0].execute('call-2', {})
    respond({ id: requests[0].id, ok: false, error: '没有打开的浏览器标签' })
    const response = await pending
    expect(response.content[0].text).toContain('没有打开的浏览器标签')
  })
})
