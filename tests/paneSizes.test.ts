import { describe, expect, it } from 'vitest'
import {
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
  it('侧栏到自己的上限为止，检视器没有上限', () => {
    expect(sidebarCeiling(300, 1440)).toBe(SIDEBAR_MAX)
    // 1440 - 56 - 264 - 160
    expect(inspectorCeiling(264, 1440)).toBe(960)
    // 窗口再宽，检视器跟着变宽 —— 没有 480 这种死上限
    expect(inspectorCeiling(264, 2560)).toBe(2080)
  })

  it('检视器拖到最大时，主区刚好剩 MAIN_MIN', () => {
    const widest = inspectorCeiling(264, 1440)
    expect(1440 - RAIL_W - 264 - widest).toBe(MAIN_MIN)
  })

  it('窗口不够宽时，上限被主区下限压下来', () => {
    // 1000 - 56 - 264 - 160 = 520
    expect(inspectorCeiling(264, 1000)).toBe(520)
    // 侧栏还够 360：1000 - 56 - 0 - 160 = 784
    expect(sidebarCeiling(0, 1000)).toBe(SIDEBAR_MAX)
  })

  it('窗口再窄也不低于最小宽度 —— 宁可主区没地方，也别让栏消失', () => {
    expect(sidebarCeiling(360, 700)).toBe(SIDEBAR_MIN)
    expect(inspectorCeiling(360, 700)).toBe(INSPECTOR_MIN)
    expect(inspectorCeiling(900, 700)).toBe(INSPECTOR_MIN)
  })

  it('clamp 同时管住上下两头', () => {
    expect(clampSidebar(9999, 0, 900)).toBe(SIDEBAR_MAX)
    expect(clampSidebar(50, 0, 900)).toBe(SIDEBAR_MIN)
    expect(clampInspector(9999, 264, 1440)).toBe(960)
    expect(clampInspector(10, 264, 1440)).toBe(INSPECTOR_MIN)
    // 窄窗口里最大值会被主区下限压下来，clamp 跟着压低
    expect(clampSidebar(9999, 360, 700)).toBe(SIDEBAR_MIN)
    expect(clampInspector(9999, 600, 700)).toBe(INSPECTOR_MIN)
  })

  it('越界值取整，拖拽不会写出小数', () => {
    expect(clampSidebar(280.6, 0, 900)).toBe(281)
    expect(clampInspector(300.4, 264, 1440)).toBe(300)
  })
})
