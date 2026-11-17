import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * preload 的参数转发是纯桥接，不在 Electron 里很难行为测试；
 * 这里守住最容易漏的一处：prompt 的第四个参数 uploads 必须原样传给 IPC。
 */
describe('preload 桥接', () => {
  it('prompt 转发项目附件与上传附件', () => {
    const source = readFileSync(new URL('../host/preload/index.ts', import.meta.url), 'utf8')
    expect(source).toContain('prompt: (agentId, text, attachments, uploads)')
    expect(source).toContain('{ agentId, text, attachments, uploads }')
  })

  it('浏览器的每条调用都带 host —— 少传参数 TypeScript 不报错，只能靠这条守', () => {
    const source = readFileSync(new URL('../host/preload/index.ts', import.meta.url), 'utf8')
    for (const channel of [
      'browserGet',
      'browserCreate',
      'browserClose',
      'browserActivate',
      'browserNavigate',
      'browserBack',
      'browserForward',
      'browserReload',
      'browserVisible'
    ]) {
      const line = source.split('\n').find((item) => item.includes(`IPC.${channel},`))
      expect(line, `${channel} 没找到`).toBeTruthy()
      expect(line, `${channel} 没带 host`).toContain('host')
    }
  })

  it('会话域的通道用 agents: 前缀，标签域的用 projects:', () => {
    const source = readFileSync(new URL('../contract/index.ts', import.meta.url), 'utf8')
    // 旧名字必须彻底消失 —— 留着两套会让人分不清哪个是对的（PLAN.md D61）
    expect(source).not.toContain("'host:tabs:")
    expect(source).toContain("agentsActivate: 'host:agents:activate'")
    expect(source).toContain("projectsCloseTab: 'host:projects:close-tab'")
  })
})
