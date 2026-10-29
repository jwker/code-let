import { describe, expect, it } from 'vitest'
import { formatDuration, formatTokens } from '../host/renderer/src/conversation/usageFormat'

/**
 * 元信息行上的数字写法。
 *
 * token 走缩写（1.2k），耗时走秒 —— 这两个数每条回复都要看，写法得稳。
 */
describe('元信息行的数字', () => {
  it('token 不到一千就原样写', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(93)).toBe('93')
    expect(formatTokens(999)).toBe('999')
  })

  it('token 过千走 k，过万走 M', () => {
    expect(formatTokens(1214)).toBe('1.2k')
    expect(formatTokens(44096)).toBe('44.1k')
    expect(formatTokens(1_234_567)).toBe('1.2M')
  })

  it('耗时不到一秒写毫秒，过一秒写秒', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(840)).toBe('840ms')
    expect(formatDuration(3400)).toBe('3.4s')
    expect(formatDuration(22_275)).toBe('22.3s')
  })

  it('过一分钟写分秒 —— 一轮真能跑这么久', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(87_500)).toBe('1m28s')
    expect(formatDuration(542_900)).toBe('9m3s')
    expect(formatDuration(3_328_000)).toBe('55m28s')
  })

  it('过一小时写时分', () => {
    expect(formatDuration(3_600_000)).toBe('1h')
    expect(formatDuration(5_430_000)).toBe('1h30m')
  })
})
