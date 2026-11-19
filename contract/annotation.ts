/**
 * 原型标注：块、引用、展开载荷（GLOSSARY.md 里的那套词）。
 *
 * 这里只放**纯类型与纯函数** —— 主进程、preload、渲染层都从这儿取。
 * 不 import 任何运行时依赖：preload 是 sandbox 的，带进来一个 npm 包就会炸。
 */

/**
 * 页面里的一块 —— 块登记的一项。
 *
 * 块号来自元素上的 `data-block`（锚点），没锚点的块给临时号。
 * 这一版只登记有锚点的块，所以 `temp` 正常是 null；字段留着，
 * 引用载荷的格式（`临时号 T1（无锚点…）`）已经定了，扩展时不用改协议。
 */
export interface PreviewBlock {
  /** 块号；无锚点的块为 null */
  block: number | null
  /** 临时号，例如 `T1`；有锚点的块为 null */
  temp: string | null
  /** 锚点原文，例如 `data-block="4"`；无锚点时为 null */
  anchor: string | null
  /** 在页面里定位这一块的选择器 */
  selector: string
  /** 单行文字摘要 */
  text: string
}

/** 输入框里的一个引用：一块 + 它所在的文件 */
export interface BlockCitation extends PreviewBlock {
  /** 原型文件（相对项目根）；页面不是本地文件时就是 URL */
  file: string
}

/** 某个宿主当前页面的标注状态 —— 工具栏、角标、chip 都看它 */
export interface AnnotationState {
  /** 这份状态属于哪个宿主：`project` 或 `agent:<id>` */
  host: string
  /** 标注模式开着吗 */
  enabled: boolean
  /** 当前页面对应的原型文件；还没打开页面时为 null */
  file: string | null
  /** 当前页面的块登记（只含有锚点的块，按文档顺序） */
  blocks: PreviewBlock[]
}

/** 主进程推给渲染进程的标注事件 */
export interface AnnotationEvent {
  host: string
  state: AnnotationState
  /** 这一下点击选中的块；不是点选引起的推送（开关、页面加载）为 null */
  picked: PreviewBlock | null
}

/** 块的键：块号或临时号，用在角标同步和去重上 */
export function blockKey(block: { block: number | null; temp: string | null }): string {
  return block.block !== null ? String(block.block) : (block.temp ?? '')
}

/** 引用 chip 上写什么：`#4` 或 `#T1` */
export function blockLabel(block: { block: number | null; temp: string | null }): string {
  return `#${blockKey(block)}`
}

/** 文字摘要压成一行 —— 载荷里「文字」那一行不能带换行 */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 载荷的标题行 */
const PAYLOAD_TITLE = '[引用] 原型块'
/** 字段名这一列要多宽（按显示宽度算，一个汉字算两列） */
const LABEL_WIDTH = 8

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += (char.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1
  }
  return width
}

/** 一行字段：`文件    preview/pricing.html` */
function field(label: string, value: string): string {
  return `${label}${' '.repeat(Math.max(1, LABEL_WIDTH - displayWidth(label)))}${value}`
}

function blockFields(citation: BlockCitation): string {
  const lines = [PAYLOAD_TITLE]
  lines.push(field('文件', citation.file))
  if (citation.block !== null) {
    lines.push(field('块号', String(citation.block)))
    lines.push(field('锚点', citation.anchor ?? `data-block="${citation.block}"`))
  } else {
    // 无锚点：块号那一行换成临时号和「怎么找」
    lines.push(field('临时号', `${citation.temp}（无锚点，凭文字和选择器找）`))
  }
  lines.push(field('选择器', citation.selector))
  lines.push(field('文字', oneLine(citation.text)))
  return lines.join('\n')
}

/**
 * 一组引用展开成附在用户消息末尾的载荷。
 *
 * 字段与顺序按 `.scratch/prototype-annotation/spec.md` 的「引用载荷的格式」，
 * 不带源码片段 —— agent 按锚点自己去文件里定位。多块之间空一行。
 */
export function blockCitationPayload(citations: BlockCitation[]): string {
  return citations.map(blockFields).join('\n\n')
}

/**
 * 发送时把引用展开到正文末尾：正文、空行、一条分隔线、载荷。
 *
 * 没有引用时原样返回正文，不加任何尾巴。
 */
export function composeMessageWithCitations(text: string, citations: BlockCitation[]): string {
  if (citations.length === 0) return text
  return `${text}\n\n---\n${blockCitationPayload(citations)}`
}
