import { describe, expect, it } from 'vitest'
import { hasAnsi, parseAnsi } from '../host/renderer/src/conversation/ansi'

/**
 * ANSI 还原（R4）：命令吐出来的颜色、粗体要变回格式，
 * 控制序列本身不能出现在屏幕上。
 */

const ESC = '\u001b'

describe('ANSI 解析', () => {
  it('没有转义序列的文本原样返回', () => {
    expect(parseAnsi('42 passed / 42')).toEqual([{ text: '42 passed / 42', style: {} }])
  })

  it('颜色和粗体分成一段段', () => {
    const spans = parseAnsi(`${ESC}[32m✓${ESC}[0m ok`)
    expect(spans).toEqual([
      { text: '✓', style: { fg: 1 + 1 } },
      { text: ' ok', style: {} }
    ])
  })

  it('亮色是 8-15 号槽位', () => {
    const spans = parseAnsi(`${ESC}[91mboom${ESC}[0m`)
    expect(spans[0].style.fg).toBe(9)
  })

  it('粗体、斜体、下划线都认', () => {
    const spans = parseAnsi(`${ESC}[1;3;4m标题${ESC}[0m`)
    expect(spans[0].style).toEqual({ bold: true, italic: true, underline: true })
  })

  it('重置回到默认', () => {
    const spans = parseAnsi(`${ESC}[31m红${ESC}[0m灰`)
    expect(spans[1].style).toEqual({})
  })

  it('256 色归到最接近的基础色', () => {
    expect(parseAnsi(`${ESC}[38;5;9m红${ESC}[0m`)[0].style.fg).toBe(9)
    // 色板里的纯红（196）离标准红更近
    expect(parseAnsi(`${ESC}[38;5;196m红${ESC}[0m`)[0].style.fg).toBe(1)
  })

  it('光标移动、清屏这类控制序列直接丢掉', () => {
    expect(parseAnsi(`${ESC}[2J${ESC}[1;1Habc`)).toEqual([{ text: 'abc', style: {} }])
  })

  it('OSC 序列丢掉', () => {
    expect(parseAnsi(`${ESC}]0;title${'\u0007'}abc`)).toEqual([{ text: 'abc', style: {} }])
  })

  it('hasAnsi 只认真正的转义序列', () => {
    expect(hasAnsi(`${ESC}[32mx`)).toBe(true)
    expect(hasAnsi('普通文本')).toBe(false)
  })
})
