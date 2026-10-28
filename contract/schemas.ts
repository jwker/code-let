import { z } from 'zod'

/**
 * IPC 载荷的 zod 校验（PLAN.md 边界 9：按通道类型校验一次而非逐字段）。
 *
 * 只被主进程引用 —— preload 是 sandbox 的，引 zod 会炸。
 */

export const switchProjectSchema = z.object({
  path: z.string().min(1)
})

export const switchConversationSchema = z.object({
  path: z.string().min(1)
})

export const promptSchema = z.object({
  text: z.string().min(1)
})

export type SwitchProjectPayload = z.infer<typeof switchProjectSchema>
export type SwitchConversationPayload = z.infer<typeof switchConversationSchema>
export type PromptPayload = z.infer<typeof promptSchema>
