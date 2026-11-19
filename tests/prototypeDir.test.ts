import { describe, expect, it } from 'vitest'
import { DEFAULT_PROTOTYPE_DIR, normalizePrototypeDir } from '../host/main/projects'

/**
 * 「原型图目录」的校验（票 02）。
 *
 * 只做字符串与路径运算，不碰磁盘：目录不存在是合法的 —— 由 agent 写文件时创建。
 */

describe('原型图目录的校验', () => {
  it('空值按默认值', () => {
    for (const input of ['', '   ', null, undefined]) {
      expect(normalizePrototypeDir('/repo', input)).toEqual({ dir: DEFAULT_PROTOTYPE_DIR })
    }
  })

  it('项目内的相对路径照收，顺带规范化', () => {
    expect(normalizePrototypeDir('/repo', '.codelet/prototype')).toEqual({
      dir: '.codelet/prototype'
    })
    expect(normalizePrototypeDir('/repo', './preview/')).toEqual({ dir: 'preview' })
    expect(normalizePrototypeDir('/repo', 'a//b')).toEqual({ dir: 'a/b' })
    expect(normalizePrototypeDir('/repo', 'a..b')).toEqual({ dir: 'a..b' })
    // 项目根本身也是「项目内」
    expect(normalizePrototypeDir('/repo', '.')).toEqual({ dir: '.' })
  })

  it('绝对路径拒绝', () => {
    expect(normalizePrototypeDir('/repo', '/tmp/elsewhere')).toEqual({
      error: '原型图目录必须是项目内的相对路径'
    })
  })

  it('跑出项目的 .. 拒绝', () => {
    for (const input of ['../outside', 'a/../../x', '..']) {
      expect(normalizePrototypeDir('/repo', input)).toEqual({
        error: '原型图目录必须在这个项目里'
      })
    }
  })

  it('太长拒绝', () => {
    expect(normalizePrototypeDir('/repo', 'a'.repeat(201))).toHaveProperty('error')
  })
})
