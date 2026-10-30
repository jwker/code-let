import { useEffect, useRef, useState } from 'react'
import { isPreview } from '../host'
import { useStore } from '../store'
import { idleIndicator, needsTick, stepIndicator, type IndicatorState } from './refreshIndicator'

const MODE_LABEL = { normal: '普通', terminal: '终端', html: 'HTML' } as const

/**
 * 底部状态栏 —— 多段并存，左边身份，右边状态。
 *
 * **在画布上，不属于任何一张卡片**：铺满整宽、没有背景色，
 * 跟标题栏上下对称。以前它是主区卡内部的页脚，那会儿有白底。
 *
 * 模型不在这一行 —— 它只在输入框那一行显示与切换（见 ConversationArea 的模型胶囊）。
 * 同一件事不在两处说，也不给两个都能点的入口。
 */
export function StatusBar() {
  const snapshot = useStore((s) => s.snapshot)
  const mode = useStore((s) => s.mode)
  const eventCount = useStore((s) => s.eventCount)

  const fallback = snapshot.session.modelFallback
  const spinning = useRefreshIndicator(snapshot.refreshing)

  return (
    <footer className="shell-bar flex items-center gap-4 px-4 text-[10.5px] text-fg-3">
      <span className="truncate">Codelet</span>
      <span className="truncate font-mono">
        {snapshot.session.sessionId ? `session ${snapshot.session.sessionId.slice(0, 8)}` : 'no session'}
      </span>

      <span className="ml-auto flex min-w-0 items-center gap-4">
        {/*
          「刷新中」—— 只在真的慢了才出现（延迟 200ms），出现后至少停 500ms。
          没有这两个门槛的话，180ms 的刷新会让它闪一下，反而更烦。
        */}
        {spinning && (
          <span className="flex flex-none items-center gap-1.5 text-fg-2" title="正在重读数据">
            <span className="refresh-ring" aria-hidden="true" />
            刷新中
          </span>
        )}
        {/*
          模型不在这里显示 —— 唯一的位置是输入框那一行（换模型是「准备发消息」
          时做的决定）。这一条只是恢复失败的告警，不是第二个模型入口。
        */}
        {fallback && (
          <span className="truncate text-warn" title={fallback}>
            ▲ 未能恢复原模型
          </span>
        )}
        <span>{MODE_LABEL[mode]}</span>
        <span className="font-mono">events {eventCount}</span>
        <span>
          {isPreview ? '浏览器预览 · 假数据' : snapshot.session.ready ? 'Pi 就绪' : 'Pi 未就绪'}
        </span>
      </span>
    </footer>
  )
}

/**
 * 「刷新中」的显示时机。
 *
 * 主进程说 `busy`（在读盘），这里按「延迟 200ms 出现、最短 500ms 停留」算出该不该显示。
 * 不忙的时候完全不起定时器。
 */
function useRefreshIndicator(busy: boolean): boolean {
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
