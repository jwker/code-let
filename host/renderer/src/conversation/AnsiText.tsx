import type { CSSProperties, ReactNode } from 'react'
import { useMemo } from 'react'
import { ANSI_SLOTS, hasAnsi, parseAnsi, type AnsiStyle } from './ansi'

/**
 * 工具输出里的 ANSI 格式还原（R4）。
 *
 * 命令吐出来的颜色、粗体要真的显示出来 —— 终端模式尤其如此：
 * 一片灰白的输出根本没法读。
 *
 * 颜色本身走设计令牌（tokens.css 里的 --ansi-*），组件不自带色值。
 */

function styleOf(style: AnsiStyle): CSSProperties | undefined {
  const out: CSSProperties = {}
  let has = false

  if (style.fg !== undefined) {
    out.color = `var(--ansi-${ANSI_SLOTS[style.fg]})`
    has = true
  }
  if (style.bg !== undefined) {
    out.backgroundColor = `color-mix(in srgb, var(--ansi-${ANSI_SLOTS[style.bg]}) 22%, transparent)`
    has = true
  }
  if (style.bold) {
    out.fontWeight = 700
    has = true
  }
  if (style.dim) {
    out.opacity = 0.6
    has = true
  }
  if (style.italic) {
    out.fontStyle = 'italic'
    has = true
  }
  if (style.underline) {
    out.textDecoration = 'underline'
    has = true
  }

  return has ? out : undefined
}

export function AnsiText({ text }: { text: string }) {
  const spans = useMemo(() => (hasAnsi(text) ? parseAnsi(text) : null), [text])

  // 没有转义序列就走纯文本，别为普通输出多绕一圈
  if (!spans) return <>{text}</>

  const nodes: ReactNode[] = spans.map((span, index) => (
    <span key={index} style={styleOf(span.style)}>
      {span.text}
    </span>
  ))

  return <>{nodes}</>
}
