import { describe, expect, it } from 'vitest'
import {
  checkAnchors,
  formatAnchorBreaks,
  readAnchors,
  type AnchorBreak
} from '../host/main/anchorCheck'

/**
 * 保号校验：从文件里读锚点，和上一轮结束时的记对比。
 *
 * 三种破坏：号消失、号所在的块文字变了、被删掉的号又被写给了新块。
 * 这里都是纯函数 —— 读的是文件内容，不依赖页面有没有刷新成功。
 */

describe('从原型 HTML 里读锚点', () => {
  it('读出块号与每块的文件内文字', () => {
    expect(
      readAnchors('<div data-block="1">顶部导航</div><div data-block="4">专业版  ¥68</div>')
    ).toEqual([
      { block: 1, text: '顶部导航' },
      { block: 4, text: '专业版 ¥68' }
    ])
  })

  it('嵌套的块各自算：外层文字包含内层，跟 innerText 一致', () => {
    expect(
      readAnchors(
        '<section data-block="2"><h1>标题</h1><div data-block="3"><b>卡片</b> 里的字</div></section>'
      )
    ).toEqual([
      { block: 2, text: '标题 卡片 里的字' },
      { block: 3, text: '卡片 里的字' }
    ])
  })

  it('script / style 里的内容不算文字', () => {
    expect(
      readAnchors(
        '<div data-block="1"><style>.a{color:red}</style>正文<script>var x = 1</script></div>'
      )
    ).toEqual([{ block: 1, text: '正文' }])
  })

  it('属性值里的 > 不会把标签截断', () => {
    expect(readAnchors('<div data-note="a>b" data-block="7">内容</div>')).toEqual([
      { block: 7, text: '内容' }
    ])
  })

  it('块号只认正整数；注释里的不算', () => {
    expect(readAnchors('<div data-block="abc">x</div><div data-block="0">y</div>')).toEqual([])
    expect(readAnchors('<!-- <div data-block="9">旧版本</div> --><div data-block="2">新的</div>')).toEqual([
      { block: 2, text: '新的' }
    ])
  })

  it('实体解码与空白折叠', () => {
    expect(readAnchors('<div data-block="1">A &amp; B\n\n  C&nbsp;D</div>')).toEqual([
      { block: 1, text: 'A & B C D' }
    ])
  })
})

describe('保号比对', () => {
  const before = { 1: '顶部导航', 3: '基础版', 4: '专业版' }

  it('没变化：不报警', () => {
    const result = checkAnchors(before, {}, [
      { block: 1, text: '顶部导航' },
      { block: 3, text: '基础版' },
      { block: 4, text: '专业版' }
    ])
    expect(result.breaks).toEqual([])
    expect(result.missing).toEqual({})
  })

  it('号消失：报一条，并记下来', () => {
    const result = checkAnchors(before, {}, [
      { block: 1, text: '顶部导航' },
      { block: 3, text: '基础版' }
    ])
    expect(result.breaks).toEqual([{ kind: 'missing', block: 4, text: '专业版' }])
    expect(result.missing).toEqual({ 4: '专业版' })
  })

  it('号还在但文字变了：报一条，带上前后文字', () => {
    const result = checkAnchors(before, {}, [
      { block: 1, text: '顶部导航' },
      { block: 3, text: '入门版' },
      { block: 4, text: '专业版' }
    ])
    expect(result.breaks).toEqual([
      { kind: 'changed', block: 3, text: '入门版', before: '基础版' }
    ])
    expect(result.missing).toEqual({})
  })

  it('被删掉的号又写给了新块：报复用，记的号清掉', () => {
    const result = checkAnchors(before, { 2: '客户评价' }, [
      { block: 1, text: '顶部导航' },
      { block: 2, text: '页脚' },
      { block: 3, text: '基础版' },
      { block: 4, text: '专业版' }
    ])
    expect(result.breaks).toEqual([{ kind: 'reused', block: 2, text: '页脚' }])
    expect(result.missing).toEqual({})
  })

  it('之前就消失、这一轮还没回来的号：不再报一次', () => {
    const result = checkAnchors({ 1: '顶部导航' }, { 2: '客户评价' }, [{ block: 1, text: '顶部导航' }])
    expect(result.breaks).toEqual([])
    expect(result.missing).toEqual({ 2: '客户评价' })
  })

  it('一轮里三种破坏可以同时出现', () => {
    const result = checkAnchors({ 3: '基础版', 4: '专业版' }, { 2: '客户评价' }, [
      { block: 2, text: '页脚' },
      { block: 3, text: '入门版' }
    ])
    const kinds = result.breaks.map((item: AnchorBreak) => item.kind).sort()
    expect(kinds).toEqual(['changed', 'missing', 'reused'])
  })
})

describe('破坏提示的措辞', () => {
  it('一条破坏一行，带文件名和收尾提醒', () => {
    const text = formatAnchorBreaks(
      [
        { kind: 'missing', block: 4, text: '专业版' },
        { kind: 'changed', block: 3, text: '入门版', before: '基础版' }
      ],
      'preview/pricing.html'
    )
    expect(text).toContain('preview/pricing.html')
    expect(text).toContain('- 号 3 的文字从「基础版」变成了「入门版」')
    expect(text).toContain('- 号 4 不见了（原来那一块写着「专业版」）')
    expect(text).toContain('找不到就明说')
  })

  it('没有破坏就是空串', () => {
    expect(formatAnchorBreaks([], 'preview/pricing.html')).toBe('')
  })
})
