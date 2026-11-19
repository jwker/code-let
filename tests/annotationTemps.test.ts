import { describe, expect, it } from 'vitest'
import type { BlockCitation, PreviewBlock } from '@contract/annotation'
import {
  assignTemp,
  promotedBlock,
  resolveBlockKey,
  resolveCitation
} from '../host/main/annotation'

/**
 * 临时号的两段纯逻辑：分配，以及「按最新登记解析」。
 *
 * 临时号只活在本次运行里 —— Codelet 不往用户的项目里写文件；
 * 转正的判据是**同一个选择器**拿到了 `data-block`。
 */

const quoteSelector = 'div.m-quote'
const temps = [
  { temp: 'T1', selector: quoteSelector },
  { temp: 'T2', selector: 'div.m-filler' }
]
const promotedBlocks: PreviewBlock[] = [
  { block: 7, temp: null, anchor: 'data-block="7"', selector: quoteSelector, text: '客户评价' }
]
const quoteCitation: BlockCitation = {
  file: 'preview/pricing.html',
  block: null,
  temp: 'T1',
  anchor: null,
  selector: quoteSelector,
  text: '客户评价'
}

describe('临时号分配', () => {
  it('第一个是 T1，之后依次加一', () => {
    expect(assignTemp([], quoteSelector)).toBe('T1')
    expect(assignTemp([{ temp: 'T1', selector: quoteSelector }], 'div.m-filler')).toBe('T2')
  })

  it('同一个选择器复用原来的号 —— 重复点不重号', () => {
    expect(assignTemp(temps, quoteSelector)).toBe('T1')
  })

  it('中间有空号也取最大号加一，不补空', () => {
    expect(
      assignTemp(
        [
          { temp: 'T1', selector: 'a' },
          { temp: 'T3', selector: 'b' }
        ],
        'c'
      )
    ).toBe('T4')
  })
})

describe('临时号转正', () => {
  it('同一个选择器拿到正式块号就算转正', () => {
    expect(promotedBlock(temps, promotedBlocks, 'T1')?.block).toBe(7)
    expect(promotedBlock(temps, promotedBlocks, 'T2')).toBeNull()
  })

  it('角标的键在转正后换成正式块号', () => {
    expect(resolveBlockKey('T1', temps, promotedBlocks)).toBe('7')
    expect(resolveBlockKey('T2', temps, promotedBlocks)).toBe('T2')
    expect(resolveBlockKey('4', temps, promotedBlocks)).toBe('4')
  })
})

describe('发送时按最新登记解析引用', () => {
  it('已转正的临时号解析成块号与锚点', () => {
    expect(resolveCitation(quoteCitation, temps, promotedBlocks)).toEqual({
      ...quoteCitation,
      block: 7,
      temp: null,
      anchor: 'data-block="7"'
    })
  })

  it('还没转成就原样保留（仍然是临时号）', () => {
    const filler: BlockCitation = {
      ...quoteCitation,
      temp: 'T2',
      selector: 'div.m-filler',
      text: '占位'
    }
    expect(resolveCitation(filler, temps, promotedBlocks)).toEqual(filler)
  })

  it('已经带块号的引用不受影响', () => {
    const anchored: BlockCitation = {
      ...quoteCitation,
      block: 4,
      temp: null,
      anchor: 'data-block="4"'
    }
    expect(resolveCitation(anchored, temps, promotedBlocks)).toBe(anchored)
  })

  it('临时号不在分配表里时，按引用自己的选择器找', () => {
    const resolved = resolveCitation(
      { ...quoteCitation, temp: 'T9' },
      temps,
      promotedBlocks
    )
    expect(resolved.block).toBe(7)
  })
})
