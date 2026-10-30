import { describe, expect, it } from 'vitest'
import {
  DELAY_MS,
  MIN_VISIBLE_MS,
  idleIndicator,
  needsTick,
  stepIndicator,
  type IndicatorState
} from '../host/renderer/src/shell/refreshIndicator'

/**
 * 「刷新中」标识的显示时机。
 *
 * 两条规则：刷新开始后等 DELAY_MS 还没结束才显示；一旦显示至少停 MIN_VISIBLE_MS。
 * 目的只有一个 —— 别让 180ms 的刷新在状态栏里闪一下。
 */

/** 从 t=0 开始，按给定时刻序列喂状态 */
function run(samples: Array<{ t: number; busy: boolean }>): IndicatorState {
  let state = idleIndicator
  for (const { t, busy } of samples) state = stepIndicator(state, busy, t)
  return state
}

describe('刷新中标识的时序', () => {
  it('180ms 的刷新完全不显示 —— 这是最常见的情况', () => {
    // t=0 开始刷新，t=180 结束
    const mid = run([
      { t: 0, busy: true },
      { t: 100, busy: true },
      { t: 180, busy: true }
    ])
    expect(mid.visible).toBe(false)

    const end = run([
      { t: 0, busy: true },
      { t: 100, busy: true },
      { t: 180, busy: true },
      { t: 200, busy: false }
    ])
    expect(end.visible).toBe(false)
    expect(end).toEqual(idleIndicator)
  })

  it('超过 200ms 才显示', () => {
    const at199 = run([{ t: 0, busy: true }, { t: 199, busy: true }])
    expect(at199.visible).toBe(false)

    const at200 = run([{ t: 0, busy: true }, { t: 200, busy: true }])
    expect(at200.visible).toBe(true)
  })

  it('★ 显示了就至少停 500ms —— 210ms 的刷新不会只闪 10ms', () => {
    // 刷新 210ms 就结束了，标识在 200ms 出现
    const shown = run([{ t: 0, busy: true }, { t: 200, busy: true }])
    expect(shown.visible).toBe(true)

    // 刷新在 210ms 结束
    const afterEnd = stepIndicator(shown, false, 210)
    expect(afterEnd.visible).toBe(true) // 还没停够，继续显示

    const at400 = stepIndicator(afterEnd, false, 400)
    expect(at400.visible).toBe(true)

    // 显示满 500ms（200ms 出现 → 700ms 才收）
    const at699 = stepIndicator(at400, false, 699)
    expect(at699.visible).toBe(true)

    const at700 = stepIndicator(at699, false, 700)
    expect(at700.visible).toBe(false)
  })

  it('长时间刷新一直显示，结束时立刻收 —— 它早就显示够 500ms 了', () => {
    const long = run([
      { t: 0, busy: true },
      { t: 200, busy: true },
      { t: 1000, busy: true },
      { t: 3000, busy: true }
    ])
    expect(long.visible).toBe(true)

    // 从 200ms 显示到 3000ms，已经 2800ms —— 刷新一结束就该收
    expect(stepIndicator(long, false, 3000).visible).toBe(false)
  })

  it('「最短显示」是从出现算起，不是从结束算起', () => {
    const shown = stepIndicator(stepIndicator(idleIndicator, true, 0), true, 200)
    expect(shown.visible).toBe(true)
    expect(shown.shownSince).toBe(200)

    // 300ms 结束 —— 只显示了 100ms，还得继续
    expect(stepIndicator(shown, false, 300).visible).toBe(true)
    // 700ms = 显示满 500ms
    expect(stepIndicator(shown, false, 699).visible).toBe(true)
    expect(stepIndicator(shown, false, 700).visible).toBe(false)
  })

  it('连着两次刷新，标识不闪', () => {
    // 第一次 180ms（不显示），紧接着第二次 400ms（该显示）
    let state = idleIndicator
    state = stepIndicator(state, true, 0)
    state = stepIndicator(state, false, 180) // 第一次结束，没显示过
    expect(state.visible).toBe(false)

    state = stepIndicator(state, true, 200) // 第二次开始
    state = stepIndicator(state, true, 400) // 等够 200ms
    expect(state.visible).toBe(true)
  })

  it('needsTick：不忙且不显示时不用起定时器', () => {
    expect(needsTick(idleIndicator, false)).toBe(false)
    // 忙但还没到延迟 —— 要 tick 等着
    expect(needsTick({ visible: false, busySince: 0, shownSince: null }, true)).toBe(true)
    // 忙且已经显示 —— 不用再算
    expect(needsTick({ visible: true, busySince: 0, shownSince: 0 }, true)).toBe(false)
    // 不忙但还在显示 —— 要 tick 等着收
    expect(needsTick({ visible: true, busySince: 0, shownSince: 0 }, false)).toBe(true)
  })

  it('常量之间的关系是对的', () => {
    expect(DELAY_MS).toBe(200)
    expect(MIN_VISIBLE_MS).toBe(500)
    expect(MIN_VISIBLE_MS).toBeGreaterThanOrEqual(DELAY_MS)
  })
})
