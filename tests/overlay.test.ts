import { describe, expect, it } from 'vitest'
import { clampOverlayBox, coversBrowser } from '../host/renderer/src/shell/overlay'

/**
 * 窄轨上的气泡 / 菜单要不要收起右边的原生浏览器视图。
 *
 * 判据是横向重叠：浏览器占满右列整个高度，纵向一定重叠；横向不沾边就不该收，
 * 收了会让右边的页面无端闪一下（用户看到的是「鼠标扫过头像，页面没了」）。
 */
describe('coversBrowser', () => {
  const browser = { left: 436, width: 800 }

  it('气泡整个落在左列里：不收', () => {
    // 窄轨右边 64px 起，最宽 260px，到 324 —— 离浏览器还有 112px
    expect(coversBrowser({ left: 64, width: 260 }, browser)).toBe(false)
  })

  it('左列很窄，气泡压到浏览器上：收', () => {
    expect(coversBrowser({ left: 64, width: 260 }, { left: 276, width: 900 })).toBe(true)
  })

  it('气泡右边缘正好贴到浏览器左边缘：不收（没有盖住任何一个像素）', () => {
    expect(coversBrowser({ left: 64, width: 260 }, { left: 324, width: 900 })).toBe(false)
  })

  it('没有浏览器视图（没有打开页面、或者不在浏览器入口）：不收', () => {
    expect(coversBrowser({ left: 64, width: 260 }, null)).toBe(false)
  })
})

/**
 * 浮层贴边弹出时的收口。
 *
 * 边界是左列而不是整个窗口：右栏开着时，贴着左列右缘弹的菜单不能伸进右栏。
 */
describe('clampOverlayBox', () => {
  const bounds = { left: 0, width: 700, height: 900 }
  const size = { width: 198, height: 300 }

  it('空间够就保持按下点的位置', () => {
    expect(clampOverlayBox({ left: 120, top: 200 }, size, bounds)).toEqual({ left: 120, top: 200 })
  })

  it('贴左列右缘时往左翻，右边界留 8px', () => {
    expect(clampOverlayBox({ left: 650, top: 200 }, size, bounds)).toEqual({ left: 494, top: 200 })
  })

  it('贴下缘时往上翻，下边界留 8px', () => {
    expect(clampOverlayBox({ left: 120, top: 880 }, size, bounds)).toEqual({ left: 120, top: 592 })
  })

  it('左列比浮层还窄时贴着左边，不出现负坐标', () => {
    expect(clampOverlayBox({ left: 100, top: 0 }, size, { left: 0, width: 150, height: 900 })).toEqual({
      left: 8,
      top: 8
    })
  })
})
