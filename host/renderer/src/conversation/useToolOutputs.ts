import { useMemo } from 'react'
import type { StreamItem } from '@contract/index'
import { useStore } from '../store'

/** 没有展开状态时的空对象 —— 稳定引用 */
const EMPTY_EXPANDED: Record<string, boolean> = {}

/**
 * 工具输出的展开状态（R4）。
 *
 * 工具输出往往很长 —— 全铺开会把对话区撑爆，所以默认收起来，点工具行才展开。
 * 工具**正在跑**的时候自动展开（实时输出要看得见），跑完自动收起；
 * 用户点过就听用户的（记在 store 里，两种模式共享）。
 */
export function useToolOutputs(items: StreamItem[], tabId: string | null) {
  // 展开状态按标签存（D4 修订）—— 切标签不该把上一个标签的展开状态带过来
  const expandedTools = useStore((s) => (tabId ? s.expandedTools[tabId] : undefined) ?? EMPTY_EXPANDED)

  /** callId → 输出文本 */
  const outputs = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of items) {
      if (item.kind === 'message' && item.role === 'toolResult' && item.callId) {
        map.set(item.callId, item.text)
      }
    }
    return map
  }, [items])

  /** 这个工具的输出现在展不展开 */
  const isExpanded = (callId: string, running: boolean): boolean => {
    const manual = expandedTools[callId]
    if (manual !== undefined) return manual
    return running
  }

  return { outputs, isExpanded }
}
