import { useEffect, useRef, useState } from 'react'
import { idleIndicator, needsTick, stepIndicator, type IndicatorState } from './refreshIndicator'

/**
 * 把上面那套规则接成一个 hook。
 *
 * 主进程说 `busy`，这里算出「现在该不该显示」，不忙的时候完全不起定时器。
 * 用 `setInterval(50)` 而不是 `setTimeout`：延迟到点和最短停留到点是两个不同的时刻，
 * 一个固定节拍轮流检查两件事，比分别管两个定时器简单。
 */
export function useIndicator(busy: boolean): boolean {
  const [state, setState] = useState<IndicatorState>(idleIndicator)
  const stateRef = useRef(state)
  stateRef.current = state

  useEffect(() => {
    setState((prev) => stepIndicator(prev, busy, Date.now()))
    if (!needsTick(stateRef.current, busy)) return

    const timer = window.setInterval(() => {
      const next = stepIndicator(stateRef.current, busy, Date.now())
      if (next !== stateRef.current) {
        stateRef.current = next
        setState(next)
      }
      if (!needsTick(next, busy)) window.clearInterval(timer)
    }, 50)

    return () => window.clearInterval(timer)
  }, [busy])

  return state.visible
}
