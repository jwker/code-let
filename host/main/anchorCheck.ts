/**
 * 保号校验：每轮结束时读原型文件里的锚点，和上一轮比。
 *
 * 三种破坏：
 * - 号消失了（上一轮还在，这一轮文件里没有这个号了）；
 * - 同一个号所在的块文字变了；
 * - 一个被删掉的号又被写给了新块（只有跨轮才知道「被删掉」这件事，所以记着
 *   消失过的号；它再出现就报复用）。
 *
 * 全部读文件、不依赖页面有没有刷新成功 —— 页面可能是坏的、可能还没重载，
 * 但文件里的号是事实。这里只有纯函数，不碰磁盘。
 */

/** 从文件里读到的一个锚点 */
export interface FileAnchor {
  block: number
  text: string
}

/** 一次保号校验发现的破坏 */
export interface AnchorBreak {
  kind: 'missing' | 'changed' | 'reused'
  block: number
  /** 现在（或消失前）那一段的文字 */
  text: string
  /** 只有 changed 有：改之前的文字 */
  before?: string
}

export interface AnchorCheck {
  /** 这一轮发现的破坏；空数组 = 号没动过 */
  breaks: AnchorBreak[]
  /** 下一次比对要记着的「已经消失、等着看有没有被复用」的号 */
  missing: Record<number, string>
}

/** 文字摘要最长留多少 —— 跟页面里的块摘要同一个量级 */
const MAX_TEXT = 200

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/** 这两个标签里的内容不是文本，跳过 */
const RAW_TEXT_TAGS = new Set(['script', 'style'])

interface OpenEntry {
  tag: string
  /** 这一层有没有锚点；没有也压栈，但文字不往里收 */
  block: number | null
  text: string
  /** 开始标签在文件里的位置 —— 输出按文档顺序排 */
  at: number
}

/**
 * 从原型 HTML 里读出锚点和每一块的文件内文字。
 *
 * 不做完整 HTML 解析：只需要「哪一段文字落在哪个 data-block 里」。
 * 嵌套时外层也收内层的文字，跟页面里的 innerText 一致。
 */
export function readAnchors(html: string): FileAnchor[] {
  const found: Array<FileAnchor & { at: number }> = []
  const open: OpenEntry[] = []
  let index = 0

  const appendText = (raw: string): void => {
    if (!raw) return
    const text = normalizeText(raw)
    if (!text) return
    for (const entry of open) {
      if (entry.block === null) continue
      entry.text = entry.text ? `${entry.text} ${text}` : text
    }
  }

  const close = (tag: string): void => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].tag !== tag) continue
      // 从最内层收起来；同名标签之外的都算它自己没写闭合
      while (open.length > i) {
        const entry = open.pop()
        if (entry && entry.block !== null) {
          found.push({ block: entry.block, text: entry.text.slice(0, MAX_TEXT), at: entry.at })
        }
      }
      return
    }
    // 原型里偶尔漏写开标签：当成闭合最内层，别把后面的文字挂错地方
    const entry = open.pop()
    if (entry && entry.block !== null) {
      found.push({ block: entry.block, text: entry.text.slice(0, MAX_TEXT), at: entry.at })
    }
  }

  while (index < html.length) {
    const lt = html.indexOf('<', index)
    if (lt < 0) {
      appendText(html.slice(index))
      break
    }
    appendText(html.slice(index, lt))

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      index = end < 0 ? html.length : end + 3
      continue
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt)
      index = end < 0 ? html.length : end + 1
      continue
    }

    const end = tagEnd(html, lt)
    if (end < 0) break
    const raw = html.slice(lt + 1, end).trim()
    index = end + 1

    if (raw.startsWith('/')) {
      const tag = raw.slice(1).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
      if (tag) close(tag)
      continue
    }

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const name = /^[a-zA-Z][^\s/>]*/.exec(body)?.[0].toLowerCase()
    if (!name) continue
    if (RAW_TEXT_TAGS.has(name)) {
      // 整段跳过（标签里的内容不是给人看的文字）
      const closeAt = html.toLowerCase().indexOf(`</${name}`, index)
      if (closeAt < 0) {
        index = html.length
        break
      }
      const closeEnd = tagEnd(html, closeAt)
      index = closeEnd < 0 ? html.length : closeEnd + 1
      continue
    }
    if (VOID_TAGS.has(name) || selfClosing) continue
    open.push({ tag: name, block: readBlockAttribute(body), text: '', at: lt })
  }

  while (open.length > 0) {
    const entry = open.pop()
    if (entry && entry.block !== null) {
      found.push({ block: entry.block, text: entry.text.slice(0, MAX_TEXT), at: entry.at })
    }
  }

  return found.sort((a, b) => a.at - b.at).map(({ block, text }) => ({ block, text }))
}

/**
 * 比对这一轮前后的锚点。
 *
 * `before` 是这一轮开始时文件里的块号 → 文字；`missing` 是之前已经消失、
 * 还没回来的号。返回的 `missing` 要存起来给下一轮用。
 */
export function checkAnchors(
  before: Record<number, string>,
  missing: Record<number, string>,
  current: FileAnchor[]
): AnchorCheck {
  const now = new Map<number, string>()
  for (const anchor of current) now.set(anchor.block, anchor.text)

  const breaks: AnchorBreak[] = []
  const next: Record<number, string> = { ...missing }

  for (const [key, text] of Object.entries(before)) {
    const block = Number(key)
    const after = now.get(block)
    if (after === undefined) {
      breaks.push({ kind: 'missing', block, text })
      if (next[block] === undefined) next[block] = text
    } else if (after !== text) {
      breaks.push({ kind: 'changed', block, text: after, before: text })
    }
  }

  // 之前消失过的号又出现了 —— 被写给了新块
  for (const anchor of current) {
    if (missing[anchor.block] === undefined) continue
    breaks.push({ kind: 'reused', block: anchor.block, text: anchor.text })
    delete next[anchor.block]
  }

  return { breaks, missing: next }
}

/**
 * 把破坏写成一条给用户和 agent 看的提示（Markdown）。
 *
 * 没有破坏时返回空串 —— 调用方据此决定发不发。
 */
export function formatAnchorBreaks(breaks: AnchorBreak[], file: string | null): string {
  if (breaks.length === 0) return ''
  const lines = [...breaks]
    .sort((a, b) => a.block - b.block || a.kind.localeCompare(b.kind))
    .map((item) => {
      if (item.kind === 'missing') {
        return `- 号 ${item.block} 不见了（原来那一块写着「${item.text}」）`
      }
      if (item.kind === 'reused') {
        return `- 号 ${item.block} 被重新写给了另一个块（现在写着「${item.text}」）`
      }
      return `- 号 ${item.block} 的文字从「${item.before ?? ''}」变成了「${item.text}」`
    })
  return [
    `原型块号可能已经和页面上的块对不上了${file ? `（${file}）` : ''}：`,
    '',
    ...lines,
    '',
    '用户上一轮说的号可能已经指错块了。改之前先核对；找不到就明说，不要猜一处改。'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function tagEnd(html: string, from: number): number {
  let quote = ''
  for (let i = from + 1; i < html.length; i += 1) {
    const char = html[i]
    if (quote) {
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '>') return i
  }
  return -1
}

function readBlockAttribute(tagBody: string): number | null {
  const match = /\bdata-block\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tagBody)
  if (!match) return null
  const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim()
  const number = Number(raw)
  return Number.isInteger(number) && number > 0 ? number : null
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // 放最后：&amp;lt; 应该变成 &lt; 而不是 <
    .replace(/&amp;/g, '&')
}

function normalizeText(raw: string): string {
  return decodeEntities(raw).replace(/\s+/g, ' ').trim()
}
