import { describe, expect, it } from 'vitest'
import { builtinTypeDef, type AgentTypeDef } from '@contract/index'
import { prototypePromptFragment } from '../host/main/prototypePrompt'

/**
 * 产品 agent 的程序片段（ADR-0004）。
 *
 * 只告诉它「原型写到哪、每块带 data-block」；块号的四条规矩在
 * `browser_blocks` 的工具提示里，这里不重复。
 *
 * 「给不给」问的是类型的能力，不是类型名 —— 所以自定义 agent 即使名字叫
 * 「产品」也拿不到，而内置产品 agent 永远拿得到。
 */

function custom(overrides: Partial<AgentTypeDef> = {}): AgentTypeDef {
  return {
    id: 't-0000aaaa',
    name: '产品',
    description: '',
    prompt: '',
    color: 'purple',
    builtin: false,
    ...overrides
  }
}

describe('产品 agent 的原型提示', () => {
  it('产品 agent 拿到一条片段：绝对目录、相对路径、data-block', () => {
    const fragment = prototypePromptFragment({
      type: builtinTypeDef('product'),
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
      type: builtinTypeDef('product'),
      cwd: '/repo/app',
      prototypeDir: '.codelet/prototype'
    })
    expect(fragment[0]).toContain('/repo/app/.codelet/prototype')
  })

  it('基础 / 开发 / 自定义 / 未知类型都不注入', () => {
    const cases: Array<AgentTypeDef | null> = [
      builtinTypeDef('general'),
      builtinTypeDef('dev'),
      custom(),
      null
    ]
    for (const type of cases) {
      expect(
        prototypePromptFragment({ type, cwd: '/repo/app', prototypeDir: '.codelet/prototype' })
      ).toEqual([])
    }
  })
})
