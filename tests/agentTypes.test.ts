import { describe, expect, it } from 'vitest'
import {
  AGENT_COLORS,
  AGENT_TYPE_LIMITS,
  BUILTIN_AGENT_TYPES,
  builtinTypeDef,
  capabilitiesOf,
  defaultAgentName,
  leastUsedColor,
  validateTypeDraft,
  type AgentColorId,
  type AgentTypeDef,
  type AgentTypeDraft
} from '@contract/index'

/**
 * 基础 agent 的契约（ADR-0004）。
 *
 * 这里只测纯函数：能力怎么判、默认名怎么来、一份草稿算不算合法。
 * 落盘和 IPC 在 `tests/agentTypesHost.test.ts`。
 */

function custom(overrides: Partial<AgentTypeDef> = {}): AgentTypeDef {
  return {
    id: 't-0000aaaa',
    name: '写作',
    description: '',
    prompt: '',
    color: 'blue',
    builtin: false,
    ...overrides
  }
}

function draft(overrides: Partial<AgentTypeDraft> = {}): AgentTypeDraft {
  return { name: '写作', description: '', prompt: '', color: 'blue', ...overrides }
}

describe('内置类型', () => {
  it('三条，顺序是 基础 / 开发 / 产品', () => {
    expect(BUILTIN_AGENT_TYPES.map((def) => def.name)).toEqual(['基础', '开发', '产品'])
    expect(BUILTIN_AGENT_TYPES.every((def) => def.builtin)).toBe(true)
    expect(BUILTIN_AGENT_TYPES.every((def) => def.color === null)).toBe(true)
    expect(BUILTIN_AGENT_TYPES.every((def) => def.prompt === '')).toBe(true)
  })

  it('按 id 找得到，找不到就是 null', () => {
    expect(builtinTypeDef('general')?.name).toBe('基础')
    expect(builtinTypeDef('t-0000aaaa')).toBeNull()
  })
})

describe('能力分派', () => {
  it('产品 agent：有预览，不参与自动归档', () => {
    expect(capabilitiesOf(builtinTypeDef('product'))).toEqual({
      preview: true,
      autoArchive: false
    })
  })

  it('基础 agent：只有自动归档', () => {
    expect(capabilitiesOf(builtinTypeDef('general'))).toEqual({
      preview: false,
      autoArchive: true
    })
  })

  it('开发与自定义类型：什么都不带', () => {
    expect(capabilitiesOf(builtinTypeDef('dev'))).toEqual({
      preview: false,
      autoArchive: false
    })
    expect(capabilitiesOf(custom())).toEqual({
      preview: false,
      autoArchive: false
    })
  })

  it('未知类型什么都不能做', () => {
    expect(capabilitiesOf(null)).toEqual({ preview: false, autoArchive: false })
  })

  it('自定义类型即使把 id 写成 product 也拿不到预览 —— 只认内置', () => {
    expect(capabilitiesOf(custom({ id: 'product' })).preview).toBe(false)
  })
})

describe('默认名字', () => {
  it('定义名 + 序号', () => {
    expect(defaultAgentName(builtinTypeDef('general'), 1)).toBe('基础 1')
    expect(defaultAgentName(builtinTypeDef('product'), 3)).toBe('产品 3')
    expect(defaultAgentName(custom(), 2)).toBe('写作 2')
  })

  it('未知类型用「未知」，不会出现 undefined', () => {
    expect(defaultAgentName(null, 4)).toBe('未知 4')
  })
})

describe('草稿校验', () => {
  it('合法草稿去掉名字与说明的首尾空格', () => {
    const result = validateTypeDraft(draft({ name: '  写作  ', description: ' 写点东西 ' }), [])
    expect(result).toEqual({
      ok: true,
      value: { name: '写作', description: '写点东西', prompt: '', color: 'blue' }
    })
  })

  it('提示词原样保留 —— 不 trim', () => {
    const result = validateTypeDraft(draft({ prompt: '  你是写作助手。\n' }), [])
    expect(result.ok && result.value.prompt).toBe('  你是写作助手。\n')
  })

  it('名字不能空', () => {
    expect(validateTypeDraft(draft({ name: '   ' }), [])).toEqual({
      ok: false,
      error: '名字不能为空'
    })
  })

  it('名字按码点算：12 个字可以，13 个不行', () => {
    expect(validateTypeDraft(draft({ name: '看'.repeat(12) }), []).ok).toBe(true)
    expect(validateTypeDraft(draft({ name: '看'.repeat(13) }), [])).toEqual({
      ok: false,
      error: `名字最多 ${AGENT_TYPE_LIMITS.name} 个字`
    })
    // emoji 算一个字
    expect(validateTypeDraft(draft({ name: '😀'.repeat(12) }), []).ok).toBe(true)
  })

  it('重名被拒 —— 包括跟内置三个重名', () => {
    expect(validateTypeDraft(draft({ name: '基础' }), BUILTIN_AGENT_TYPES)).toEqual({
      ok: false,
      error: '已经有同名的 agent'
    })
    expect(validateTypeDraft(draft({ name: '写作' }), [custom()])).toEqual({
      ok: false,
      error: '已经有同名的 agent'
    })
  })

  it('编辑自己时不跟自己比', () => {
    expect(validateTypeDraft(draft({ name: '写作' }), [custom()], 't-0000aaaa').ok).toBe(true)
  })

  it('说明 60 字、提示词 4000 字是上限', () => {
    expect(validateTypeDraft(draft({ description: '说'.repeat(60) }), []).ok).toBe(true)
    expect(validateTypeDraft(draft({ description: '说'.repeat(61) }), [])).toEqual({
      ok: false,
      error: `说明最多 ${AGENT_TYPE_LIMITS.description} 个字`
    })
    expect(validateTypeDraft(draft({ prompt: '写'.repeat(4000) }), []).ok).toBe(true)
    expect(validateTypeDraft(draft({ prompt: '写'.repeat(4001) }), [])).toEqual({
      ok: false,
      error: `提示词最多 ${AGENT_TYPE_LIMITS.prompt} 个字`
    })
  })

  it('颜色必须在色板里', () => {
    const bad = draft({ color: 'chartreuse' as AgentColorId })
    expect(validateTypeDraft(bad, [])).toEqual({ ok: false, error: '颜色不在可选范围里' })
  })
})

describe('默认配色', () => {
  it('空清单给第一组', () => {
    expect(leastUsedColor([])).toBe(AGENT_COLORS[0])
  })

  it('跳过已经用过的', () => {
    const used = [{ color: 'graphite' as AgentColorId }, { color: 'blue' as AgentColorId }]
    expect(leastUsedColor(used.map((item) => custom(item)))).toBe('sky')
  })

  it('全用一遍之后取用得最少的，平手按色板顺序', () => {
    const once = AGENT_COLORS.map((color) => custom({ id: `t-${color}`, color }))
    expect(leastUsedColor(once)).toBe(AGENT_COLORS[0])
    const twiceFirst = [...once, custom({ id: 't-extra', color: 'graphite' })]
    expect(leastUsedColor(twiceFirst)).toBe('blue')
  })
})
