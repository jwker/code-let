import { describe, expect, it } from 'vitest'
import {
  INSPECTOR_MAX,
  INSPECTOR_MIN,
  MAIN_MIN,
  RAIL_W,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  clampInspector,
  clampSidebar,
  inspectorCeiling,
  sidebarCeiling
} from '../host/renderer/src/shell/paneSizes'

describe('栏宽上下限', () => {
  it('窗口够宽时，各自到自己的上限为止', () => {
    expect(sidebarCeiling(300, 1440)).toBe(SIDEBAR_MAX)
    expect(inspectorCeiling(264, 1440)).toBe(INSPECTOR_MAX)
  })

  it('窗口不够宽时，先保证主区还剩 MAIN_MIN', () => {
    // 1000 - 56 - 260 - 420 = 264
    expect(sidebarCeiling(260, 1000)).toBe(264)
    // 1000 - 56 - 200 - 420 = 324，没到 480 的上限
    expect(inspectorCeiling(200, 1000)).toBe(324)
    expect(1000 - RAIL_W - 264 - 260).toBeGreaterThanOrEqual(MAIN_MIN)
  })

  it('窗口再窄也不低于最小宽度 —— 宁可主区挤，也别让栏消失', () => {
    expect(sidebarCeiling(480, 700)).toBe(SIDEBAR_MIN)
    expect(inspectorCeiling(360, 700)).toBe(INSPECTOR_MIN)
  })

  it('clamp 同时管住上下两头', () => {
    expect(clampSidebar(9999, 0, 900)).toBe(SIDEBAR_MAX)
    expect(clampSidebar(50, 0, 900)).toBe(SIDEBAR_MIN)
    expect(clampInspector(9999, 264, 1440)).toBe(INSPECTOR_MAX)
    expect(clampInspector(10, 264, 1440)).toBe(INSPECTOR_MIN)
    // 窄窗口里最大值会被主区下限压下来，clamp 跟着压低
    expect(clampSidebar(9999, 0, 700)).toBe(224)
  })

  it('越界值取整，拖拽不会写出小数', () => {
    expect(clampSidebar(280.6, 0, 900)).toBe(281)
    expect(clampInspector(300.4, 264, 1440)).toBe(300)
  })
})
