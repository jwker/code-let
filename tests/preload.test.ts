import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * preload 的参数转发是纯桥接，不在 Electron 里很难行为测试；
 * 这里守住最容易漏的一处：prompt 的第四个参数 uploads 必须原样传给 IPC。
 */
describe('preload 桥接', () => {
  it('prompt 转发项目附件与上传附件', () => {
    const source = readFileSync(new URL('../host/preload/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('prompt: (tabId, text, attachments, uploads)')
    expect(source).toContain('{ tabId, text, attachments, uploads }')
  })
})
