import { useRef } from 'react'
import { IconArrowDownToLine, IconArrowUpToLine } from '../shell/icons'

/** 跳转后这段时间内不再响应 —— 连点两下不会又跳回去 */
const LOCK = 400

/**
 * 回到顶部 / 回到底部（方案 A）。
 *
 * 一个钮钉在内容列右下角，位置永远不动，只换方向：停在最新内容上时指向顶部，
 * 其余时候指向底部。「回到底部」用得更多（底部才是最新内容），所以它占默认那一面。
 * 内容不满一屏时整个钮淡出。
 */
export function ScrollJump({
  scrollable,
  atBottom,
  onJump
}: {
  scrollable: boolean
  atBottom: boolean
  onJump: (edge: 'top' | 'bottom') => void
}) {
  const lastJump = useRef(0)
  const toTop = atBottom
  const label = toTop ? '回到顶部' : '回到底部'

  function click(): void {
    const now = Date.now()
    if (now - lastJump.current < LOCK) return
    lastJump.current = now
    onJump(toTop ? 'top' : 'bottom')
  }

  return (
    <button
      type="button"
      onClick={click}
      aria-label={label}
      title={label}
      tabIndex={scrollable ? 0 : -1}
      aria-hidden={!scrollable}
      className={`scroll-jump${scrollable ? ' is-visible' : ''}`}
    >
      {toTop ? <IconArrowUpToLine /> : <IconArrowDownToLine />}
    </button>
  )
}
