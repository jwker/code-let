import type { TreeNavigateResult } from '@contract/index'

/**
 * 切支线前后要拦的那几句话，以及结果的形状。
 *
 * 抽出来是因为 PiRuntime 本身要模型、要凭据，测不动；这两条规则（什么时候不让切、
 * 什么原样传回渲染层）是纯判断，单独测更稳。
 */

/** 判断要用到的会话状态 —— 只声明用到的字段 */
export interface TreeSessionState {
  isStreaming: boolean
  isCompacting: boolean
  /** 当前会话的模型；总结支线要用它 */
  model: unknown | null
}

/**
 * 切支线之前先拦一遍。
 *
 * Pi 自己也会拦，但那两句话是英文的、而且跟别的报错混在一起；
 * 这里拦下来说中文，界面上拿到的就是能直接给用户看的那句话。
 */
export function assertTreeNavigable(
  session: TreeSessionState | null | undefined,
  options?: { summarize?: boolean }
): asserts session is TreeSessionState {
  if (!session) throw new Error('runtime 尚未启动')
  if (session.isStreaming || session.isCompacting) throw new Error('等这一轮结束再切支线')
  if (options?.summarize && !session.model) throw new Error('当前没有模型，无法总结支线')
}

/** Pi 的返回 → 契约的返回：`editorText` 原样带过去（空串也是原文） */
export function toNavigateResult(result: {
  cancelled: boolean
  aborted?: boolean
  editorText?: string
}): TreeNavigateResult {
  return {
    cancelled: result.cancelled,
    ...(result.aborted ? { aborted: true } : {}),
    ...(result.editorText !== undefined ? { editorText: result.editorText } : {})
  }
}
