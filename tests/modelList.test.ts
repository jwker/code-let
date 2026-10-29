import { describe, expect, it } from 'vitest'
import type { ModelOption } from '@contract/index'
import {
  filterModels,
  formatContext,
  formatPrice,
  groupByProvider
} from '../host/renderer/src/shell/modelList'

/**
 * 模型选择器的纯逻辑。
 *
 * 只列已配置凭据的模型（那部分在主进程做，Pi 负责），这里管分组、搜索、显示。
 */

const model = (provider: string, id: string, extra?: Partial<ModelOption>): ModelOption => ({
  provider,
  id,
  name: id,
  contextWindow: 128_000,
  reasoning: true,
  cost: { input: 0.1, output: 0.4 },
  ...extra
})

describe('按 provider 分组', () => {
  it('同 provider 归一组，组按名字排', () => {
    const groups = groupByProvider([
      model('minimax-cn', 'M3'),
      model('deepseek', 'flash'),
      model('minimax-cn', 'M3.1-Flash')
    ])
    expect(groups.map((g) => g.provider)).toEqual(['deepseek', 'minimax-cn'])
    expect(groups[1].models.map((m) => m.id)).toEqual(['M3', 'M3.1-Flash'])
  })

  it('空清单没有组', () => {
    expect(groupByProvider([])).toEqual([])
  })
})

describe('搜索', () => {
  const models = [
    model('minimax-cn', 'MiniMax-M3.1-Flash', { name: 'MiniMax-M3.1-Flash' }),
    model('deepseek', 'deepseek-flash', { name: 'deepseek-flash' }),
    model('deepseek', 'deepseek-v4-pro', { name: 'deepseek-v4-pro' })
  ]

  it('空关键词给全部', () => {
    expect(filterModels(models, '')).toHaveLength(3)
    expect(filterModels(models, '   ')).toHaveLength(3)
  })

  it('按模型名匹配，不分大小写', () => {
    expect(filterModels(models, 'M3.1').map((m) => m.id)).toEqual(['MiniMax-M3.1-Flash'])
    expect(filterModels(models, 'minimax').map((m) => m.id)).toEqual(['MiniMax-M3.1-Flash'])
  })

  it('按 provider 名匹配 —— 输入 provider 应该命中它那一整组', () => {
    expect(filterModels(models, 'deepseek').map((m) => m.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro'
    ])
  })

  it('搜不到就是空', () => {
    expect(filterModels(models, 'gpt-9')).toEqual([])
  })
})

describe('显示格式', () => {
  it('上下文长度走 k / M', () => {
    expect(formatContext(200_000)).toBe('200k')
    expect(formatContext(1_000_000)).toBe('1.0M')
    expect(formatContext(8_192)).toBe('8k')
  })

  it('价格按每百万 token，免费写 free', () => {
    expect(formatPrice(0.1)).toBe('$0.10')
    expect(formatPrice(15)).toBe('$15.00')
    expect(formatPrice(0.0005)).toBe('$0.0005')
    expect(formatPrice(0)).toBe('free')
  })
})
