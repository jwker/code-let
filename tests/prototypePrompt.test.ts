import { describe, expect, it } from 'vitest'
import { prototypePromptFragment } from '../host/main/prototypePrompt'

/**
 * 产品 agent 的系统提示片段（票 04）。
 *
 * 只告诉它「原型写到哪、每块带 data-block」；块号的四条规矩在
 * `browser_blocks` 的工具提示里，这里不重复。
 */

describe('产品 agent 的原型提示', () => {
  it('产品 agent 拿到一条片段：绝对目录、相对路径、data-block', () => {
    const fragment = prototypePromptFragment({
      type: 'product',
      cwd: '/repo/app',
      prototypeDir: 'design/protos'
    })
    expect(fragment).toHaveLength(1)
    expect(fragment[0]).toContain('/repo/app/design/protos')
    expect(fragment[0]).toContain('design/protos')
    expect(fragment[0]).toContain('data-block')
    // 四条保号规矩不在这里重复，它们挂在 browser_blocks 上
    expect(fragment[0]).not.toContain('不重排')
    expect(fragment[0]).not.toContain('不复用')
  })

  it('默认目录也算出绝对路径', () => {
    const fragment = prototypePromptFragment({
      type: 'product',
      cwd: '/repo/app',
      prototypeDir: '.codelet/prototype'
    })
    expect(fragment[0]).toContain('/repo/app/.codelet/prototype')
  })

  it('通用 / 开发 agent 不注入', () => {
    for (const type of ['general', 'dev'] as const) {
      expect(
        prototypePromptFragment({ type, cwd: '/repo/app', prototypeDir: '.codelet/prototype' })
      ).toEqual([])
    }
  })
})
