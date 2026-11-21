/**
 * 浮层和原生浏览器视图的几何关系。
 *
 * 浏览器的页面是一个原生 `WebContentsView`，永远画在 DOM 之上。DOM 里只有两种选择：
 * 要么把原生视图收起来（气泡、菜单会整片消失），要么让它盖住浮层。
 *
 * 所以只在**浮层真的会跟浏览器矩形重叠**时才收起它 —— 窄轨上那些贴着左边缘的
 * 气泡和菜单落在区域 5 里，跟浏览器一点不沾边，收起来只会让右边的页面闪一下。
 */

export interface HorizontalSpan {
  /** 左边缘（窗口坐标） */
  left: number
  width: number
}

/** 浮层会不会盖住浏览器视图。浏览器占满右列整个高度，所以只看横向就够了 */
export function coversBrowser(tip: HorizontalSpan, browser: HorizontalSpan | null): boolean {
  if (!browser) return false
  return tip.left < browser.left + browser.width && tip.left + tip.width > browser.left
}
