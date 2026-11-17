import { describe, expect, it } from 'vitest'
import {
  MAIN_MIN,
  RAIL_W,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampSidebar,
  sidebarCeiling
} from '../host/renderer/src/shell/paneSizes'

/**
 * 栏宽上下限。
 *
 * 检视器退场之后只剩两条：侧栏（可选，⌘B 那种抽屉）和区域 5。
 * 区域 5 的宽度由 `PANE_LAYOUT` 与用户拖动决定，这里只管侧栏不被拖到挤死区域 6。
 */

describe('栏宽上下限', () => {
  it('侧栏到自己的上限为止', () => {
    expect(sidebarCeiling(0, 1440)).toBe(SIDEBAR_MAX)
  })

  it('区域 5 占得越宽，侧栏的上限越低', () => {
    // 1440 - 56 - 600 - 160 = 624 → 仍受 SIDEBAR_MAX 压住
    expect(sidebarCeiling(600, 1440)).toBe(SIDEBAR_MAX)
    // 1000 - 56 - 600 - 160 = 184 → 低于下限，按下限算
    expect(sidebarCeiling(600, 1000)).toBe(SIDEBAR_MIN)
  })

  it('窗口不够宽时，上限被区域 6 的下限压下来', () => {
    // 640 - 56 - 0 - 160 = 424 → 超过 SIDEBAR_MAX，取 SIDEBAR_MAX
    expect(sidebarCeiling(0, 640)).toBe(SIDEBAR_MAX)
    // 400 - 56 - 0 - 160 = 184 → 低于下限
    expect(sidebarCeiling(0, 400)).toBe(SIDEBAR_MIN)
  })

  it('窗口再窄也不低于最小宽度 —— 宁可区域 6 没地方，也别让侧栏消失', () => {
    expect(sidebarCeiling(360, 700)).toBe(SIDEBAR_MIN)
    expect(sidebarCeiling(900, 700)).toBe(SIDEBAR_MIN)
  })

  it('clamp 同时管住上下两头', () => {
    expect(clampSidebar(9999, 0, 900)).toBe(SIDEBAR_MAX)
    expect(clampSidebar(50, 0, 900)).toBe(SIDEBAR_MIN)
    // 窄窗口里最大值会被区域 6 下限压下来，clamp 跟着压低
    expect(clampSidebar(9999, 360, 700)).toBe(SIDEBAR_MIN)
  })

  it('越界值取整，拖拽不会写出小数', () => {
    expect(clampSidebar(280.6, 0, 900)).toBe(281)
  })

  it('常量跟 CSS 对得上 —— 窄轨 56、区域 6 至少留 160', () => {
    expect(RAIL_W).toBe(56)
    expect(MAIN_MIN).toBe(160)
  })
})
