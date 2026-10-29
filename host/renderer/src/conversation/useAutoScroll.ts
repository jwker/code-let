import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 内容流的自动滚动（R2），顺便给出「回到顶部 / 回到底部」要用的两个读数。
 *
 * 实时流是往下长的 —— 视图不跟着滚到底，用户发完消息看到的还是老内容，
 * 像是「没反应」。所以新内容来了就滚到底，除非用户自己往上滚过
 * （往上滚 = 他在看旧内容，别硬拽回来）。
 *
 * 按钮要知道两件事，都在同一个测量里算：还能不能滚（不满一屏就别出按钮）、
 * 现在是不是停在最新内容上（在底部时按钮指向顶部，其余时候指向底部）。
 */

/** 离上下边这么近以内算「到头」；贴底阈值和按钮阈值共用这一个数 */
const EDGE = 80

type Edge = 'top' | 'bottom'

export function useAutoScroll(
  items: readonly unknown[],
  streaming: boolean,
  resetKey: string | null
) {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const pinnedRef = useRef(true)
  /** 到底能不能滚 —— 缝隙不到 EDGE 就不算，不出按钮 */
  const [scrollable, setScrollable] = useState(false)
  /** 是不是停在最新内容上 */
  const [atBottom, setAtBottom] = useState(true)

  /** 量一次：贴底与否 + 还能不能滚 */
  const measure = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    const gap = node.scrollHeight - node.scrollTop - node.clientHeight
    pinnedRef.current = gap < EDGE
    setAtBottom(gap < EDGE)
    setScrollable(node.scrollHeight - node.clientHeight > EDGE)
  }, [])

  // 滚动容器会随模式换掉（普通 / 终端 / HTML）—— 监听得跟着节点走
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current?.removeEventListener('scroll', measure)
      observerRef.current?.disconnect()
      nodeRef.current = node

      if (!node) return
      node.addEventListener('scroll', measure, { passive: true })

      // 内容变长（流式输出、展开工具）、窗口变宽（收起检视器）都不触发 scroll 事件，
      // 靠 ResizeObserver 兜住；容器本身和它的内容各看一个
      const observer = new ResizeObserver(measure)
      observer.observe(node)
      if (node.firstElementChild) observer.observe(node.firstElementChild)
      observerRef.current = observer

      measure()
    },
    [measure]
  )

  // 换会话 → 重新从头跟到底
  useEffect(() => {
    pinnedRef.current = true
    const node = nodeRef.current
    if (node) node.scrollTop = node.scrollHeight
    measure()
  }, [resetKey, measure])

  // 有新内容 → 滚到底
  useEffect(() => {
    const node = nodeRef.current
    if (!node) return
    if (pinnedRef.current) node.scrollTop = node.scrollHeight
    measure()
  }, [items, streaming, measure])

  /** 用户刚发了话 → 无条件贴底（立刻，不等动画） */
  const scrollToBottom = useCallback(() => {
    pinnedRef.current = true
    const node = nodeRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [])

  /** 按钮用：平滑跳到某一头 */
  const jumpTo = useCallback((edge: Edge) => {
    const node = nodeRef.current
    if (!node) return
    // 跳到底 = 恢复跟随；跳到顶 = 后面来新内容也别把人拽回去
    pinnedRef.current = edge === 'bottom'
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    node.scrollTo({
      top: edge === 'bottom' ? node.scrollHeight : 0,
      behavior: calm ? 'auto' : 'smooth'
    })
  }, [])

  return { setRef, scrollToBottom, jumpTo, scrollable, atBottom }
}
