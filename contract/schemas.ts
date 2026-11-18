import { z } from 'zod'
import { ATTACHMENT_LIMITS } from './index'
import type { BrowserHost } from './browser'

/**
 * IPC 载荷的 zod 校验（PLAN.md 边界 9：按通道类型校验一次而非逐字段）。
 *
 * 只被主进程引用 —— preload 是 sandbox 的，引 zod 会炸。
 */

/** 项目目录 */
export const projectPathSchema = z.object({
  path: z.string().min(1)
})

/** 删除会话：只传会话文件路径；路径还要在主进程里跟当前会话列表对一遍 */
export const conversationsDeleteSchema = z.object({
  paths: z.array(z.string().min(1)).min(1)
})

/** 改名：名字可以是空串（清掉自定义名）；上限跟改名输入框一致 */
export const conversationRenameSchema = z.object({
  path: z.string().min(1),
  name: z.string().max(80)
})

/** 列目录：cwd 是项目根，dir 是相对它（或绝对，主进程会校验不越界）的目录 */
export const filesListSchema = z.object({
  cwd: z.string().min(1),
  dir: z.string()
})

/** 搜索文件：query 可以为空（列出根目录） */
export const filesSearchSchema = z.object({
  cwd: z.string().min(1),
  query: z.string(),
  limit: z.number().int().min(1).max(200),
  requestId: z.string().min(1).optional()
})

export const filesSearchCancelSchema = z.object({
  requestId: z.string().min(1)
})

export const fileReadSchema = z.object({
  cwd: z.string().min(1),
  path: z.string().min(1)
})

export const fileOpenSchema = z.object({
  cwd: z.string().min(1),
  path: z.string().min(1)
})

export const fileIdSchema = z.object({
  fileId: z.string().min(1)
})

/** agent id —— 宿主自己发的，稳定的身份（runtime 以它为键） */
export const agentIdSchema = z.object({
  agentId: z.string().min(1)
})

/** 项目标签 id —— 项目标签是页面，不是运行时 */
export const projectTabIdSchema = z.object({
  tabId: z.string().min(1)
})

/** 打开一条已有会话 */
export const agentOpenSchema = z.object({
  /** 会话文件路径 */
  path: z.string().min(1),
  /** 会话所在目录 */
  cwd: z.string().min(1)
})

/** 新建一个 agent（= 一条会话） */
export const agentCreateSchema = z.object({
  /** 会话要建在哪个目录 */
  cwd: z.string().min(1),
  /** 新建时定的名字；不给就用默认名 */
  name: z.string().optional(),
  /**
   * 基础 agent 的类型（D62）。不给就是通用 —— 老调用方（比如测试）不用改。
   * **创建后不可改**：它决定区域 5/6 的布局，也决定实例编号。
   */
  type: z.enum(['general', 'dev', 'product']).optional()
})

/** 导入会话：只要会话文件路径，cwd 从会话清单里查 */
export const agentImportSchema = z.object({
  path: z.string().min(1)
})

/** 给 agent 改名：上限跟新建时一致 */
export const agentRenameSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().max(80)
})

/** 切项目标签的入口 */
export const projectPaneSchema = z.object({
  tabId: z.string().min(1),
  pane: z.enum(['code', 'docs', 'browser', 'settings', 'agent'])
})

export const promptSchema = z.object({
  agentId: z.string().min(1),
  text: z.string().min(1),
  attachments: z.array(z.string().min(1)).max(ATTACHMENT_LIMITS.maxCount).optional(),
  uploads: z.array(z.string().min(1)).max(ATTACHMENT_LIMITS.maxCount).optional()
})

/** 中止只要一个 agentId —— 没有别的东西可传 */
export const promptAbortSchema = z.object({
  agentId: z.string().min(1)
})

/** 扩展命令参数候选：name 是命令名，prefix 是当前参数前缀 */
export const commandCompleteSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  prefix: z.string()
})

/** 改思考等级：level 的合法性由主进程按当前模型的可用等级校验 */
export const thinkingSelectSchema = z.object({
  agentId: z.string().min(1),
  level: z.string().min(1)
})

/** 临时对话的内部 id */
export const temporaryIdSchema = z.object({
  id: z.string().min(1)
})

export const temporaryPromptSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  uploads: z.array(z.string().min(1)).max(ATTACHMENT_LIMITS.maxCount).optional()
})

export const temporaryModelSelectSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  modelId: z.string().min(1)
})

/** 浏览器的宿主：`project` 或 `agent:<id>`。认不出来的直接拒，不猜默认值 */
export const browserHostSchema: z.ZodType<BrowserHost> = z.union([
  z.literal('project'),
  z.string().regex(/^agent:.+$/) as unknown as z.ZodType<`agent:${string}`>
])

export const browserUrlSchema = z.object({
  host: browserHostSchema,
  url: z.string().max(4_200_000)
})

export const browserTabSchema = z.object({
  host: browserHostSchema,
  tabId: z.string().min(1)
})

export const browserNavigateSchema = z.object({
  host: browserHostSchema,
  tabId: z.string().min(1),
  url: z.string().max(4_200_000)
})

export const browserStateSchema = z.object({
  host: browserHostSchema
})

export const browserBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

export const browserVisibleSchema = z.object({
  host: browserHostSchema,
  visible: z.boolean()
})

/** Git 是项目级的东西 —— 按目录取，不按 agent */
export const gitCwdSchema = z.object({
  cwd: z.string().min(1)
})

export const gitDiffSchema = z.object({
  cwd: z.string().min(1),
  path: z.string().min(1).max(4096),
  scope: z.enum(['staged', 'unstaged', 'untracked', 'conflicts'])
})

export const clipboardWriteSchema = z.object({
  text: z.string()
})

export const modelSelectSchema = z.object({
  agentId: z.string().min(1),
  provider: z.string().min(1),
  id: z.string().min(1),
  persist: z.boolean()
})

export type AgentIdPayload = z.infer<typeof agentIdSchema>
export type AgentOpenPayload = z.infer<typeof agentOpenSchema>
export type AgentCreatePayload = z.infer<typeof agentCreateSchema>
export type PromptPayload = z.infer<typeof promptSchema>
export type ModelSelectPayload = z.infer<typeof modelSelectSchema>
