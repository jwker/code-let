import type { BlockCitation, PreviewBlock } from '@contract/index'

/**
 * 临时号的记账与「按最新登记解析」。
 *
 * 临时号（T1、T2…）给的是**没有锚点的块**：别人做的原型、早先的原型。
 * 它只活在本次运行里 —— Codelet 不往用户的项目里写任何文件。
 * 转正的判据是同一个选择器拿到了 `data-block`：页面重建登记之后再解析，
 * 临时号就落成正式块号。
 *
 * 这里只放纯函数，不碰 electron —— 分配和解析都能直接测。
 */

/** 临时号的分配表：选择器 ↔ 临时号，跟着进程活 */
export interface TempAssignment {
  temp: string
  selector: string
}

/**
 * 给一个选择器分配临时号。
 *
 * 同一个选择器复用原来的号（重复点同一块不重号）；新的选择器取当前最大号加一，
 * 中间有空号也不补 —— 号只增不减，免得删掉一块之后别人的号变了。
 */
export function assignTemp(temps: TempAssignment[], selector: string): string {
  const existing = temps.find((item) => item.selector === selector)
  if (existing) return existing.temp
  let max = 0
  for (const item of temps) {
    const number = Number.parseInt(item.temp.replace(/^T/, ''), 10)
    if (Number.isFinite(number) && number > max) max = number
  }
  return `T${max + 1}`
}

/**
 * 临时号对应的正式块 —— 页面重建登记后，同一个选择器拿到了块号就算转正。
 *
 * 没转正（或这个临时号根本不在分配表里）返回 null。
 */
export function promotedBlock(
  temps: TempAssignment[],
  blocks: PreviewBlock[],
  temp: string | null
): PreviewBlock | null {
  if (!temp) return null
  const assignment = temps.find((item) => item.temp === temp)
  if (!assignment) return null
  return blocks.find((block) => block.block !== null && block.selector === assignment.selector) ?? null
}

/**
 * 角标与「滚到那一块」用的键：临时号转正后换成正式块号，其余原样。
 *
 * 输入框里的引用文字不改写；变的只是页面上画哪个号。
 */
export function resolveBlockKey(
  key: string,
  temps: TempAssignment[],
  blocks: PreviewBlock[]
): string {
  const promoted = promotedBlock(temps, blocks, key)
  return promoted?.block != null ? String(promoted.block) : key
}

/**
 * 发送时把引用按最新登记解析一遍。
 *
 * 已经带块号的引用原样返回；临时号转正了的换成块号、锚点和最新的文字摘要。
 * 还没转正就原样留着 —— 载荷里会写明这是临时号、没有锚点。
 */
export function resolveCitation(
  citation: BlockCitation,
  temps: TempAssignment[],
  blocks: PreviewBlock[]
): BlockCitation {
  if (citation.block !== null) return citation
  const assignment = temps.find((item) => item.temp === citation.temp)
  const selector = assignment?.selector ?? citation.selector
  const promoted = blocks.find((block) => block.block !== null && block.selector === selector)
  if (!promoted || promoted.block === null) return citation
  return {
    ...citation,
    block: promoted.block,
    temp: null,
    anchor: promoted.anchor ?? `data-block="${promoted.block}"`,
    text: promoted.text || citation.text
  }
}
