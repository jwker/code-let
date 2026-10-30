/**
 * 状态栏「刷新中」标识的显示时机 —— 纯逻辑，好测。
 *
 * 为什么要有这套规则：一次会话列表刷新约 180ms，如果每次都让它出现再消失，
 * 人眼看到的是「抖了一下」，比不显示还烦。所以：
 *
 *   - **延迟出现**：刷新开始后等 DELAY_MS 还没结束才显示。180ms 的刷新根本走不到显示。
 *   - **最短停留**：一旦显示了，至少待 MIN_VISIBLE_MS。否则 210ms 的刷新会显示 10ms，照样闪。
 */

/** 刷新开始后等这么久还没结束，才显示标识 */
export const DELAY_MS = 200

/** 一旦显示，至少停留这么久 */
export const MIN_VISIBLE_MS = 500

export interface IndicatorState {
  /** 现在该不该显示 */
  visible: boolean
  /** 已经在「刷新中」多久了（ms）—— 从 busy 变 true 那一刻算起 */
  busySince: number | null
  /** 已经显示多久了（ms）—— 从 visible 变 true 那一刻算起 */
  shownSince: number | null
}

export const idleIndicator: IndicatorState = { visible: false, busySince: null, shownSince: null }

/**
 * 按当前时刻算下一帧的状态。
 *
 * 调用方拿 `busy`（主进程说的「我正在读盘」）和时钟，每帧调一次；
 * 返回值变了就重渲染。
 *
 * @param prev  上一帧的状态
 * @param busy  主进程此刻是不是在刷新
 * @param now   当前时刻（ms）
 */
export function stepIndicator(prev: IndicatorState, busy: boolean, now: number): IndicatorState {
  // 1) 刷新开始了 —— 记下开始时刻，但先不显示
  if (busy && prev.busySince === null) {
    return { visible: false, busySince: now, shownSince: null }
  }

  // 2) 还在刷新
  if (busy && prev.busySince !== null) {
    // 已经显示着 —— 什么都不用变
    if (prev.visible) return prev
    // 还没显示 —— 看等够没有
    return now - prev.busySince >= DELAY_MS ? { visible: true, busySince: prev.busySince, shownSince: now } : prev
  }

  // 3) 刷新结束了
  if (!busy) {
    // 本来就没在刷 —— 什么都不用变
    if (prev.busySince === null) return prev

    // 显示过 —— 要停够 MIN_VISIBLE_MS 才收
    if (prev.visible) {
      const shownFor = prev.shownSince === null ? 0 : now - prev.shownSince
      return shownFor >= MIN_VISIBLE_MS ? idleIndicator : prev
    }

    // 没来得及显示就结束了 —— 直接回到空闲（这就是「快的刷新不显示」）
    return idleIndicator
  }

  return prev
}

/**
 * 下一帧要不要再算一次。
 *
 * 渲染进程用它决定要不要起一个定时器 —— 不忙的时候完全不用轮询。
 */
export function needsTick(state: IndicatorState, busy: boolean): boolean {
  if (busy) {
    // 忙：等着延迟到点（还没显示）或者什么都不用做（已经显示）
    return !state.visible
  }
  // 不忙但还在显示：等着最短停留到点
  return state.visible
}
