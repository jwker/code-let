import { z } from 'zod'

/**
 * IPC 载荷的 zod 校验（PLAN.md 边界 9：按通道类型校验一次而非逐字段）。
 *
 * 只被主进程引用 —— preload 是 sandbox 的，引 zod 会炸。
 */

/** 标签 id —— 宿主自己发的，稳定的身份 */
export const projectPathSchema = z.object({
  path: z.string().min(1)
})

/** 列目录：cwd 是项目根，dir 是相对它（或绝对，主进程会校验不越界）的目录 */
export const filesListSchema = z.object({
  cwd: z.string().min(1),
  dir: z.string()
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
  text: z.string().min(1)
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
