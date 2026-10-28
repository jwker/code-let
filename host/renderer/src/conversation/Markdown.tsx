/**
 * 模型回复的格式渲染（R7）。
 *
 * 内容的格式只有一份 —— 普通模式和终端模式都调它，靠 variant 改排版。
 * 支持：标题、加粗、斜体、行内代码、代码块、列表、表格、引用、分隔线。
 *
 * 不引第三方 markdown 库：要的就是上面这一小撮，够用且没有依赖包袱。
 */

import type { ReactNode } from 'react'

/** 排版变体：聊天的读法 / 终端的读法 */
export type MarkdownVariant = 'normal' | 'terminal'

interface Props {
  text: string
  variant: MarkdownVariant
}

export function Markdown({ text, variant }: Props) {
  return (
    <div className={variant === 'terminal' ? 'md md-terminal' : 'md md-normal'}>
      {renderBlocks(text, variant)}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

const HEADINGS = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6'
} as const

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; lang: string; lines: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'rule' }

/** 把一段 markdown 拆成块 */
function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    // 空行：跳过
    if (!line.trim()) {
      index += 1
      continue
    }

    // 代码块
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1 // 吃掉收尾的 ```
      blocks.push({ kind: 'code', lang: fence[1] ?? '', lines: body })
      continue
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      index += 1
      continue
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] })
      index += 1
      continue
    }

    // 表格：当前行是 | … |，下一行是分隔行
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const head = splitRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]))
        index += 1
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }

    // 列表
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = !bullet
      const items: string[] = []
      while (index < lines.length) {
        const item = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]) : /^\s*[-*+]\s+(.*)$/.exec(lines[index])
        if (!item) break
        items.push(item[1])
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ kind: 'quote', lines: body })
      continue
    }

    // 段落：连续非空行
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim()) {
      const current = lines[index]
      if (/^(#{1,6})\s+/.test(current)) break
      if (/^\s*[-*+]\s+/.test(current) || /^\s*\d+[.)]\s+/.test(current)) break
      if (/^\s*>\s?/.test(current)) break
      if (current.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) break
      paragraph.push(current)
      index += 1
    }
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', lines: paragraph })
  }

  return blocks
}

function isTableDivider(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-')
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

// ---------------------------------------------------------------------------
// 行内格式
// ---------------------------------------------------------------------------

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g

/** 行内：行内代码 / 加粗 / 斜体 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE).filter((part) => part !== '')
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={key} className="md-code">
          {part.slice(1, -1)}
        </code>
      )
    }
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }
    return <span key={key}>{part}</span>
  })
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function renderBlocks(source: string, variant: MarkdownVariant): ReactNode[] {
  const blocks = parse(source)
  return blocks.map((block, index) => {
    const key = `b${index}`
    switch (block.kind) {
      case 'heading': {
        const Tag = HEADINGS[Math.min(block.level, 6) as keyof typeof HEADINGS]
        return (
          <Tag key={key} className={`md-h md-h${block.level}`}>
            {renderInline(block.text, key)}
          </Tag>
        )
      }
      case 'paragraph':
        return (
          <p key={key} className="md-p">
            {block.lines.map((line, lineIndex) => (
              <span key={`${key}-${lineIndex}`}>
                {renderInline(line, `${key}-${lineIndex}`)}
                {lineIndex < block.lines.length - 1 && variant === 'normal' ? <br /> : null}
              </span>
            ))}
          </p>
        )
      case 'list':
        return block.ordered ? (
          <ol key={key} className="md-list">
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
            ))}
          </ol>
        ) : (
          <ul key={key} className="md-list">
            {block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
            ))}
          </ul>
        )
      case 'code':
        return (
          <pre key={key} className="md-pre">
            <code>{block.lines.join('\n')}</code>
          </pre>
        )
      case 'table':
        // 表格外面套一层能横向滚的容器 —— 宽表格自己滚，不把对话区撑宽（R7）
        return (
          <div key={key} className="md-table-wrap">
            <table className="md-table">
              <thead>
                <tr>
                  {block.head.map((cell, cellIndex) => (
                    <th key={`${key}-h${cellIndex}`}>{renderInline(cell, `${key}-h${cellIndex}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={`${key}-r${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td key={`${key}-r${rowIndex}c${cellIndex}`}>
                        {renderInline(cell, `${key}-r${rowIndex}c${cellIndex}`)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'quote':
        return (
          <blockquote key={key} className="md-quote">
            {block.lines.map((line, lineIndex) => (
              <p key={`${key}-${lineIndex}`}>{renderInline(line, `${key}-${lineIndex}`)}</p>
            ))}
          </blockquote>
        )
      case 'rule':
        return <hr key={key} className="md-rule" />
    }
  })
}
