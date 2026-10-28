import { useCallback, useEffect, useRef } from 'react'

/**
 * 内容流的自动滚动（R2）。
 *
 * 实时流是往下长的 —— 视图不跟着滚到底，用户发完消息看到的还是老内容，
 * 像是「没反应」。所以新内容来了就滚到底，除非用户自己往上滚过
 * （往上滚 = 他在看旧内容，别硬拽回来）。
 */

/** 离底部这么近以内就算「跟着」 */
const PIN_THRESHOLD = 80

export function useAutoScroll(
  items: readonly unknown[],
  streaming: boolean,
  resetKey: string | null
) {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)

  // 用户往上滚 → 不跟随；滚回底部 → 重新跟随
  const onScroll = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < PIN_THRESHOLD
  }, [])

  // 滚动容器会随模式换掉（普通 / 终端 / HTML）—— 监听得跟着节点走
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current?.removeEventListener('scroll', onScroll)
      nodeRef.current = node
      if (node) node.addEventListener('scroll', onScroll, { passive: true })
    },
    [onScroll]
  )

  // 换会话 → 重新从头跟到底
  useEffect(() => {
    pinnedRef.current = true
    const node = nodeRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [resetKey])

  // 有新内容 → 滚到底
  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    if (!pinnedRef.current) return
    node.scrollTop = node.scrollHeight
  }, [items, streaming])

  /** 用户刚发了话 → 无条件跟到底 */
  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true
    const node = nodeRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  return { setRef, scrollToBottom }
}
