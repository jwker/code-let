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

/** 浮层能占的横向 / 纵向范围 */
export interface OverlayBounds {
  left: number
  width: number
  height: number
}

/**
 * 一条浮层贴边弹出时的位置。
 *
 * 先按鼠标位置 / 触发控件摆，超出范围的边往回收 —— 右下角弹菜单时菜单往左、往上翻，
 * 而不是被窗口裁掉。左列是浮层的边界，不是整个窗口。
 */
export function clampOverlayBox(
  desired: { left: number; top: number },
  size: { width: number; height: number },
  bounds: OverlayBounds,
  margin = 8
): { left: number; top: number } {
  const minLeft = bounds.left + margin
  const maxLeft = bounds.left + bounds.width - size.width - margin
  const maxTop = bounds.height - size.height - margin
  return {
    left: Math.max(minLeft, Math.min(desired.left, Math.max(minLeft, maxLeft))),
    top: Math.max(margin, Math.min(desired.top, Math.max(margin, maxTop)))
  }
}

/**
 * 左列在视口里的范围 —— 浮层的边界。
 *
 * 右栏开着时左列只占窗口左边一段，菜单 / 气泡用窗口宽度去钳就会伸进右栏。
 * 拿不到 `.shell-left`（首帧、测试）时退回整个窗口。
 */
export function leftColumnBounds(): OverlayBounds {
  const el = document.querySelector<HTMLElement>('.shell-left')
  if (!el) return { left: 0, width: window.innerWidth, height: window.innerHeight }
  const rect = el.getBoundingClientRect()
  return { left: rect.left, width: rect.width, height: rect.height }
}
