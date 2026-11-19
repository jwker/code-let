import { describe, expect, it } from 'vitest'
import type { BlockCitation } from '@contract/annotation'
import {
  blockCitationPayload,
  blockKey,
  blockLabel,
  composeMessageWithCitations,
  oneLine
} from '@contract/annotation'

/**
 * 引用载荷的构造（spec「引用载荷的格式」）。
 *
 * 只测纯函数：字段、顺序、对齐、换行处理和多块拼接。
 * 页面里的悬停与点选归端到端用例 —— 那要真浏览器。
 */

function citation(over: Partial<BlockCitation> = {}): BlockCitation {
  return {
    file: 'preview/pricing.html',
    block: 4,
    temp: null,
    anchor: 'data-block="4"',
    selector: 'div.m-pricing > div.m-card.pro',
    text: '专业版 ¥68 / 月 无限项目 并行 agent 优先支持 升级',
    ...over
  }
}

describe('引用载荷', () => {
  it('单块：字段与顺序按 spec，标签列对齐', () => {
    expect(blockCitationPayload([citation()])).toBe(
      [
        '[引用] 原型块',
        '文件    preview/pricing.html',
        '块号    4',
        '锚点    data-block="4"',
        '选择器  div.m-pricing > div.m-card.pro',
        '文字    专业版 ¥68 / 月 无限项目 并行 agent 优先支持 升级'
      ].join('\n')
    )
  })

  it('多块：按选择顺序排列，块之间空一行', () => {
    const payload = blockCitationPayload([
      citation({ block: 3, anchor: 'data-block="3"', selector: 'div.m-card', text: '基础版' }),
      citation()
    ])
    const blocks = payload.split('\n\n')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('块号    3')
    expect(blocks[0]).toContain('文字    基础版')
    expect(blocks[1]).toContain('块号    4')
  })

  it('文字里的换行压成一行', () => {
    const payload = blockCitationPayload([citation({ text: '专业版\n¥68  / 月\n\n升级' })])
    expect(payload).toContain('文字    专业版 ¥68 / 月 升级')
    expect(payload.split('文字')[1]).not.toContain('\n')
  })

  it('没有锚点时块号那一行换成临时号和怎么找', () => {
    const payload = blockCitationPayload([
      citation({
        block: null,
        temp: 'T1',
        anchor: null,
        selector: 'div.m-quote',
        text: '客户评价'
      })
    ])
    expect(payload).toBe(
      [
        '[引用] 原型块',
        '文件    preview/pricing.html',
        '临时号  T1（无锚点，凭文字和选择器找）',
        '选择器  div.m-quote',
        '文字    客户评价'
      ].join('\n')
    )
    // 无锚点就没有「锚点」那一行，也不该编一个块号出来
    expect(payload).not.toContain('锚点    ')
    expect(payload).not.toContain('块号    ')
  })

  it('载荷里不带源码片段 —— 只有摘要，没有 HTML', () => {
    const payload = blockCitationPayload([citation()])
    expect(payload).not.toContain('<div')
    expect(payload).not.toContain('</')
  })

  it('空列表给出空串', () => {
    expect(blockCitationPayload([])).toBe('')
  })
})

describe('发送时把引用附在消息末尾', () => {
  it('没有引用时原样返回正文', () => {
    expect(composeMessageWithCitations('改成两栏', [])).toBe('改成两栏')
  })

  it('有引用时是正文、空行、分隔线、载荷', () => {
    const message = composeMessageWithCitations('把 #4 的按钮换成实心', [citation()])
    expect(message.startsWith('把 #4 的按钮换成实心\n\n---\n[引用] 原型块\n')).toBe(true)
    expect(message).toContain('文件    preview/pricing.html')
  })
})

describe('引用的名字', () => {
  it('有锚点写 #块号，无锚点写 #临时号', () => {
    expect(blockLabel({ block: 4, temp: null })).toBe('#4')
    expect(blockLabel({ block: null, temp: 'T1' })).toBe('#T1')
    expect(blockKey({ block: 4, temp: null })).toBe('4')
    expect(blockKey({ block: null, temp: 'T1' })).toBe('T1')
  })

  it('文字摘要压掉多余空白', () => {
    expect(oneLine('  a\n\nb\tc  ')).toBe('a b c')
  })
})
