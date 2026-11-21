import { describe, expect, it } from 'vitest'
import { coversBrowser } from '../host/renderer/src/shell/overlay'

/**
 * 窄轨上的气泡 / 菜单要不要收起右边的原生浏览器视图。
 *
 * 判据是横向重叠：浏览器占满右列整个高度，纵向一定重叠；横向不沾边就不该收，
 * 收了会让右边的页面无端闪一下（用户看到的是「鼠标扫过头像，页面没了」）。
 */
describe('coversBrowser', () => {
  const browser = { left: 436, width: 800 }

  it('气泡整个落在区域 5 里：不收', () => {
    // 窄轨右边 64px 起，最宽 260px，到 324 —— 离浏览器还有 112px
    expect(coversBrowser({ left: 64, width: 260 }, browser)).toBe(false)
  })

  it('区域 5 很窄，气泡压到浏览器上：收', () => {
    expect(coversBrowser({ left: 64, width: 260 }, { left: 276, width: 900 })).toBe(true)
  })

  it('气泡右边缘正好贴到浏览器左边缘：不收（没有盖住任何一个像素）', () => {
    expect(coversBrowser({ left: 64, width: 260 }, { left: 324, width: 900 })).toBe(false)
  })

  it('没有浏览器视图（没有打开页面、或者不在浏览器入口）：不收', () => {
    expect(coversBrowser({ left: 64, width: 260 }, null)).toBe(false)
  })
})
