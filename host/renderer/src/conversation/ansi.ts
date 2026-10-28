/**
 * ANSI 转义序列的解析（.ai/task.md · R4）。
 *
 * 工具输出里命令吐出来的颜色、粗体，要还原成真的格式 ——
 * 不能拍平成灰白一片，也不能把 `[31m` 这种符号直接摆到屏幕上。
 *
 * 只认「基础格式」：16 色、粗体、弱化、斜体、下划线。
 * 256 色 / 真彩色按最接近的基础色归位（颜色本身仍走设计令牌）。
 * 光标移动、清屏、OSC 序列一律丢掉 —— 那是终端控制，不是内容。
 */

export interface AnsiStyle {
  /** 前景色槽位 0-15 */
  fg?: number
  /** 背景色槽位 0-15 */
  bg?: number
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
}

export interface AnsiSpan {
  text: string
  style: AnsiStyle
}

const ESC = '\x1b'

/** 16 色槽位的名字，跟 tokens.css 里的变量一一对应 */
export const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white'
] as const

/** 16 色的基准 RGB —— 只用来算「最接近哪个槽位」，不直接上屏 */
const BASE_RGB: [number, number, number][] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255]
]

/** xterm 256 色板里的一个颜色 */
function palette(index: number): [number, number, number] {
  if (index < 16) return BASE_RGB[index]
  if (index < 232) {
    const n = index - 16
    const level = (v: number): number => (v === 0 ? 0 : 55 + (v - 1) * 40)
    return [level(Math.floor(n / 36)), level(Math.floor((n % 36) / 6)), level(n % 6)]
  }
  const gray = 8 + (index - 232) * 10
  return [gray, gray, gray]
}

/** 找最接近的基础色槽位 */
function nearestSlot(rgb: [number, number, number]): number {
  let best = 0
  let bestDistance = Infinity
  for (let i = 0; i < BASE_RGB.length; i += 1) {
    const base = BASE_RGB[i]
    const dr = rgb[0] - base[0]
    const dg = rgb[1] - base[1]
    const db = rgb[2] - base[2]
    const distance = dr * dr + dg * dg + db * db
    if (distance < bestDistance) {
      bestDistance = distance
      best = i
    }
  }
  return best
}

/** 应用一段 SGR 参数 */
function applySgr(style: AnsiStyle, body: string): AnsiStyle {
  const raw = body === '' ? '0' : body
  const codes = raw.split(';').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })

  const next: AnsiStyle = { ...style }

  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]
    switch (code) {
      case 0:
        return {}
      case 1:
        next.bold = true
        break
      case 2:
        next.dim = true
        break
      case 3:
        next.italic = true
        break
      case 4:
        next.underline = true
        break
      case 21:
      case 22:
        next.bold = false
        next.dim = false
        break
      case 23:
        next.italic = false
        break
      case 24:
        next.underline = false
        break
      case 39:
        next.fg = undefined
        break
      case 49:
        next.bg = undefined
        break
      case 38:
      case 48: {
        const target = code === 38 ? 'fg' : 'bg'
        if (codes[i + 1] === 5) {
          next[target] = nearestSlot(palette(codes[i + 2] ?? 0))
          i += 2
        } else if (codes[i + 1] === 2) {
          const rgb: [number, number, number] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0]
          next[target] = nearestSlot(rgb)
          i += 4
        }
        break
      }
      default:
        if (code >= 30 && code <= 37) next.fg = code - 30
        else if (code >= 90 && code <= 97) next.fg = code - 90 + 8
        else if (code >= 40 && code <= 47) next.bg = code - 40
        else if (code >= 100 && code <= 107) next.bg = code - 100 + 8
        break
    }
  }

  return next
}

/**
 * 文本 → 带样式的一段段。
 *
 * 没有转义序列的文本原样返回一段（style 为空）。
 */
export function parseAnsi(input: string): AnsiSpan[] {
  const spans: AnsiSpan[] = []
  let style: AnsiStyle = {}
  let buffer = ''
  let index = 0

  const flush = (): void => {
    if (buffer === '') return
    spans.push({ text: buffer, style: { ...style } })
    buffer = ''
  }

  while (index < input.length) {
    const char = input[index]

    if (char !== ESC) {
      buffer += char
      index += 1
      continue
    }

    const next = input[index + 1]

    // CSI：ESC [ 参数 收尾字节
    if (next === '[') {
      let cursor = index + 2
      while (cursor < input.length && !/[\u0040-\u007e]/.test(input[cursor])) cursor += 1
      const body = input.slice(index + 2, cursor)
      const final = input[cursor]
      index = cursor + 1
      // 只有 SGR（m）跟内容有关；光标移动、清屏这类直接丢掉
      if (final === 'm') {
        flush()
        style = applySgr(style, body)
      }
      continue
    }

    // OSC：ESC ] ... BEL（或 ST）
    if (next === ']') {
      let cursor = index + 2
      while (cursor < input.length && input[cursor] !== '\u0007') {
        if (input[cursor] === ESC && input[cursor + 1] === '\\') break
        cursor += 1
      }
      index = input[cursor] === ESC ? cursor + 2 : cursor + 1
      continue
    }

    // 两字节转义（如 ESC ( B）—— 丢掉
    index += 2
  }

  flush()
  return spans
}

/** 文本里有没有 ANSI —— 决定要不要走解析 */
export function hasAnsi(text: string): boolean {
  return text.includes(ESC)
}
