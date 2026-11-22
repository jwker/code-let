import { describe, expect, it } from 'vitest'
import { builtinTypeDef, type AgentTypeDef } from '@contract/index'
import { browserHostFor } from '../host/renderer/src/shell/browserHost'

/**
 * 右栏浏览器看哪个宿主（ADR-0005）。
 *
 * 左列是产品 agent 时看它自己的预览，其余都是项目级浏览器；项目设置占着左列时
 * 也回到项目级 —— 设置页旁边不该显示某个 agent 的预览。
 */
describe('右栏浏览器宿主', () => {
  const product = builtinTypeDef('product')
  const generic: AgentTypeDef = {
    id: 't-aaaa1111',
    name: '自定义',
    description: '',
    prompt: '',
    color: null,
    builtin: false
  }

  it('产品 agent：看它自己的预览', () => {
    expect(browserHostFor('agent', { id: 'a1' }, product)).toBe('agent:a1')
  })

  it('基础 / 开发 / 自定义 / 未知类型：项目级', () => {
    for (const def of [builtinTypeDef('general'), builtinTypeDef('dev'), generic, null]) {
      expect(browserHostFor('agent', { id: 'a1' }, def)).toBe('project')
    }
  })

  it('没有活动 agent：项目级', () => {
    expect(browserHostFor('agent', null, product)).toBe('project')
  })

  it('左列是项目设置：哪怕产品 agent 还在，也用项目级', () => {
    expect(browserHostFor('settings', { id: 'a1' }, product)).toBe('project')
  })
})
