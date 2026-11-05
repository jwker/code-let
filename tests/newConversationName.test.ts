import { describe, expect, it } from 'vitest'
import { randomConversationName } from '../host/renderer/src/shell/NewConversationDialog'

/**
 * 新建对话的默认名字。
 *
 * 「会话」加三位随机数 —— 要求是正好三位，个位数也要补零，
 * 不然「会话7」和「会话007」看着像两种格式。
 */
describe('新建对话的默认名字', () => {
  it('总是「会话」加三位数字', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(randomConversationName()).toMatch(/^会话\d{3}$/)
    }
  })

  it('数字不会重复得离谱', () => {
    const names = new Set<string>()
    for (let i = 0; i < 200; i += 1) names.add(randomConversationName())
    // 1000 个可能值里抽 200 次，撞一些是正常的；全撞同一个才是坏了
    expect(names.size).toBeGreaterThan(50)
  })
})
