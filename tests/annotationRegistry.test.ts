import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BROWSER_ANNOTATION_CHANNEL } from '@contract/index'
import { previewFileOf, readPreviewBlock } from '../host/main/browser'

/**
 * 块登记的两处纯逻辑：载荷里的「文件」怎么算，页面报上来的块怎么洗。
 *
 * 页面是 agent 写出来的东西，不能当可信输入 —— 块号、选择器、文字都要过一遍。
 */

describe('预览文件路径', () => {
  it('项目内的本地文件写成相对路径 —— 载荷给 agent 看的是这个', () => {
    expect(previewFileOf('file:///work/app/preview/pricing.html', '/work/app')).toBe(
      'preview/pricing.html'
    )
  })

  it('项目外的本地文件保留绝对路径', () => {
    expect(previewFileOf('file:///elsewhere/x.html', '/work/app')).toBe('/elsewhere/x.html')
  })

  it('不知道项目目录时保留绝对路径', () => {
    expect(previewFileOf('file:///work/app/preview/x.html', null)).toBe('/work/app/preview/x.html')
  })

  it('不是本地文件就用 URL 本身', () => {
    expect(previewFileOf('http://localhost:5173/preview/x.html', '/work/app')).toBe(
      'http://localhost:5173/preview/x.html'
    )
  })

  it('空白页没有文件', () => {
    expect(previewFileOf('about:blank', '/work/app')).toBeNull()
    expect(previewFileOf('', '/work/app')).toBeNull()
  })
})

describe('页面报上来的块', () => {
  it('认得出正常的块，锚点原文照抄', () => {
    expect(
      readPreviewBlock({
        block: 4,
        anchor: 'data-block="4"',
        selector: 'div.m-pricing > div.m-card.pro',
        text: ' 专业版\n¥68  '
      })
    ).toEqual({
      block: 4,
      temp: null,
      anchor: 'data-block="4"',
      selector: 'div.m-pricing > div.m-card.pro',
      text: '专业版 ¥68'
    })
  })

  it('块号必须是正整数 —— 字符串和 0 都不算', () => {
    for (const block of ['4', 0, -1, 1.5, null, undefined]) {
      expect(readPreviewBlock({ block, selector: 'div', text: '' })).toBeNull()
    }
  })

  it('没有选择器就没法定位，丢掉', () => {
    expect(readPreviewBlock({ block: 4, selector: '', text: 'x' })).toBeNull()
    expect(readPreviewBlock({ block: 4, text: 'x' })).toBeNull()
  })

  it('不是对象就当没报', () => {
    expect(readPreviewBlock(null)).toBeNull()
    expect(readPreviewBlock('4')).toBeNull()
  })
})

describe('页面 preload 的通道名', () => {
  it('跟 contract 里的常量一致', () => {
    /*
     * 浏览器视图的 preload 故意不 import contract —— 两个 preload 入口共用模块时，
     * 打包器拆出的共享 chunk 会让沙箱 preload 失效。这条断言守着两边不跑偏。
     */
    const source = readFileSync(
      new URL('../host/browserPreload/index.ts', import.meta.url),
      'utf8'
    )
    expect(BROWSER_ANNOTATION_CHANNEL).toBe('host:browser:annotation')
    expect(source).toContain(`'${BROWSER_ANNOTATION_CHANNEL}'`)
  })
})
