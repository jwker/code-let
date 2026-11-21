import { describe, expect, it } from 'vitest'
import {
  clampRightPanelWidth,
  defaultRightPanelWidth,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN
} from '../host/renderer/src/shell/panelWidth'

/**
 * 右栏宽度（票 02）。
 *
 * 三条边界：默认是窗口一半、夹在 380–900、拖出来的值照样夹一次。
 */
describe('右栏宽度', () => {
  it('默认是窗口宽度的一半', () => {
    expect(defaultRightPanelWidth(1440)).toBe(720)
    expect(defaultRightPanelWidth(1600)).toBe(800)
  })

  it('13 寸屏上不超半屏的下限：窗口窄时收到 380', () => {
    expect(defaultRightPanelWidth(700)).toBe(RIGHT_PANEL_MIN)
    expect(defaultRightPanelWidth(600)).toBe(380)
  })

  it('外接大屏上不窄成一条缝：窗口再宽也只到 900', () => {
    expect(defaultRightPanelWidth(2400)).toBe(RIGHT_PANEL_MAX)
    expect(defaultRightPanelWidth(4000)).toBe(900)
  })

  it('拖出来的像素值也夹一次并取整', () => {
    expect(clampRightPanelWidth(500.6)).toBe(501)
    expect(clampRightPanelWidth(100)).toBe(RIGHT_PANEL_MIN)
    expect(clampRightPanelWidth(5000)).toBe(RIGHT_PANEL_MAX)
  })
})
