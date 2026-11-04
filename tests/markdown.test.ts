import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../host/renderer/src/conversation/Markdown'

function render(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text, variant: 'normal' }))
}

describe('Markdown 列表', () => {
  it('有序列表项之间有空行时仍是一个列表，不会各自从 1 开始', () => {
    const html = render('1. 第一项\n\n2. 第二项')
    expect((html.match(/<ol/g) ?? []).length).toBe(1)
    expect(html).toContain('第一项</span>')
    expect(html).toContain('第二项</span>')
  })

  it('有序列表后面接普通段落时仍然结束列表', () => {
    const html = render('1. 第一项\n\n2. 第二项\n\n这里是段落')
    expect((html.match(/<ol/g) ?? []).length).toBe(1)
    expect(html).toContain('这里是段落</span>')
  })
})
