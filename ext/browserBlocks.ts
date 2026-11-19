import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { failure, request, result } from './lib/browserBridge'

/**
 * 把产品 agent 预览页面的块清单交给 agent。
 *
 * 用户说「把 3 和 5 换位置」时，agent 得先知道 3 和 5 是哪两块。
 * 这个工具读的是主进程的块登记 —— 跟渲染层标注用的同一份数据：
 * 块号、选择器、文字摘要、锚点（没有锚点的块显示临时号 T1、T2…）。
 *
 * 四条保号规矩挂在这个工具的定义上（`promptGuidelines`）：只有这个工具
 * 激活时才随系统提示生效，不改全局系统提示，也不改产品 agent 的类型分支。
 */

/** 保号规矩：agent 写原型时怎么对待已经存在的号 */
export const BLOCK_GUIDELINES = [
  '保住已有的号：改原型时，已经有 data-block 的块保留它原来的块号，别换号。',
  '不重排：插入或删除块时不重新编号，块号跟着文件走。',
  '不复用：删掉的块号不能再写给新块 —— 用户那边的对话里，那个号还指着旧块。',
  '找不到就明说：用户说的号在页面里找不到时直接说找不到，不许猜一处改。'
]

export default function browserBlocksExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: 'browser_blocks',
      label: 'Browser blocks',
      description:
        '读取产品 agent 右侧预览页面的块清单：块号、选择器、文字摘要、锚点（没有 data-block 的块给临时号 T1、T2…）。改原型之前先用它确认要改的是哪一块。',
      promptSnippet:
        '读取右侧原型预览的块清单（块号 / 选择器 / 文字摘要 / 是否有 data-block 锚点）',
      promptGuidelines: BLOCK_GUIDELINES,
      parameters: Type.Object({}),
      async execute() {
        try {
          return result(await request(pi, 'blocks'))
        } catch (error) {
          return failure(error)
        }
      }
    })
  )
}
