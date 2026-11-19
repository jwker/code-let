import { resolve } from 'node:path'
import type { AgentType } from '@contract/index'

/**
 * 产品 agent 的系统提示片段：原型写到哪、每一块要带 `data-block`。
 *
 * 只给产品 agent 用（通用 / 开发 agent 返回空数组）—— 这是产品 agent 的产品行为，
 * 不是某个工具的提示，所以不进全局系统提示。
 *
 * 块号的四条规矩（保住已有的号、不重排、不复用、找不到就明说）挂在
 * `browser_blocks` 的工具提示上，这里不重复。
 *
 * 提示只在建 runtime 时注入：设置改了之后，已开着的 agent 要 `/reload`
 * 或新开一个才会用新的目录。
 */
export function prototypePromptFragment(input: {
  type: AgentType
  cwd: string
  /** 项目内的原型目录（相对路径），来自项目设置 */
  prototypeDir: string
}): string[] {
  if (input.type !== 'product') return []
  const dir = resolve(input.cwd, input.prototypeDir)
  return [
    [
      `产品原型放在这个项目的原型目录里：${dir}（项目内相对路径 ${input.prototypeDir}）。`,
      '生成或修改原型时，把 HTML 文件写在这个目录下；',
      '每个可以单独指代的块要加 `data-block` 属性 —— 用户在右侧预览里按这些块号和引用跟你指同一块。'
    ].join('')
  ]
}
