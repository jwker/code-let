import { z } from 'zod'
import { ATTACHMENT_LIMITS } from './index'

/**
 * IPC 载荷的 zod 校验（PLAN.md 边界 9：按通道类型校验一次而非逐字段）。
 *
 * 只被主进程引用 —— preload 是 sandbox 的，引 zod 会炸。
 */

/** 标签 id —— 宿主自己发的，稳定的身份 */
export const projectPathSchema = z.object({
  path: z.string().min(1)
})

/** 删除会话：只传会话文件路径；路径还要在主进程里跟当前会话列表对一遍 */
export const conversationsDeleteSchema = z.object({
  paths: z.array(z.string().min(1)).min(1)
})

/** 改名：名字可以是空串（清掉自定义名）；上限跟侧栏输入框一致 */
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
  limit: z.number().int().min(1).max(200)
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

export const tabIdSchema = z.object({
  tabId: z.string().min(1)
})

export const tabOpenSchema = z.object({
  /** 会话文件路径 */
  path: z.string().min(1),
  /** 会话所在目录 */
  cwd: z.string().min(1)
})

export const tabNewSchema = z.object({
  /** 会话要建在哪个目录 */
  cwd: z.string().min(1)
})

export const promptSchema = z.object({
  tabId: z.string().min(1),
  text: z.string().min(1),
  attachments: z.array(z.string().min(1)).max(ATTACHMENT_LIMITS.maxCount).optional()
})

/** 中止只要一个 tabId —— 没有别的东西可传 */
export const promptAbortSchema = z.object({
  tabId: z.string().min(1)
})

/** 扩展命令参数候选：name 是命令名，prefix 是当前参数前缀 */
export const commandCompleteSchema = z.object({
  tabId: z.string().min(1),
  name: z.string().min(1),
  prefix: z.string()
})

/** 改思考等级：level 的合法性由主进程按当前模型的可用等级校验 */
export const thinkingSelectSchema = z.object({
  tabId: z.string().min(1),
  level: z.string().min(1)
})

export const clipboardWriteSchema = z.object({
  text: z.string()
})

export const modelSelectSchema = z.object({
  tabId: z.string().min(1),
  provider: z.string().min(1),
  id: z.string().min(1),
  persist: z.boolean()
})

export type TabIdPayload = z.infer<typeof tabIdSchema>
export type TabOpenPayload = z.infer<typeof tabOpenSchema>
export type TabNewPayload = z.infer<typeof tabNewSchema>
export type PromptPayload = z.infer<typeof promptSchema>
export type ModelSelectPayload = z.infer<typeof modelSelectSchema>
