import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl } from '../host/main/browser'

/**
 * 浏览器地址策略（PLAN.md D43）。
 *
 * 只打开本地页面；允许的协议是 http/https（本地主机）、file、data、javascript、about:blank。
 * 页面内重定向也要过这一关，所以规则必须写在主进程这一处。
 */

describe('浏览器地址校验', () => {
  it('本地主机放行', () => {
    for (const input of [
      'http://localhost:5173/',
      'localhost:5173',
      'http://127.0.0.1:8080/x',
      'https://app.localhost/',
      'http://[::1]:3000/'
    ]) {
      const result = normalizeBrowserUrl(input)
      expect(result.error, input).toBeNull()
      expect(result.url, input).toMatch(/^https?:\/\//)
    }
  })

  it('外部地址被拒绝', () => {
    for (const input of ['https://example.com/', 'http://192.168.1.10/', 'https://a.b.c/']) {
      const result = normalizeBrowserUrl(input)
      expect(result.error, input).toContain('只打开本地页面')
      expect(result.url).toBe('')
    }
  })

  it('允许 file、data、javascript、about:blank', () => {
    expect(normalizeBrowserUrl('file:///Users/demo/index.html').error).toBeNull()
    expect(normalizeBrowserUrl('data:text/html,<h1>hi</h1>').error).toBeNull()
    expect(normalizeBrowserUrl('javascript:void(0)').error).toBeNull()
    expect(normalizeBrowserUrl('about:blank').url).toBe('about:blank')
    expect(normalizeBrowserUrl('').url).toBe('about:blank')
  })

  it('其他协议被拒绝', () => {
    for (const input of ['ftp://localhost/x', 'chrome://settings', 'ws://localhost:9000']) {
      const result = normalizeBrowserUrl(input)
      expect(result.error, input).toBeTruthy()
    }
  })

  it('data 页面有长度上限', () => {
    const huge = `data:text/html,${'x'.repeat(5 * 1024 * 1024)}`
    expect(normalizeBrowserUrl(huge).error).toContain('太大')
  })
})
