import { useEffect } from 'react'
import { useStore } from '../store'
import { coversBrowser, leftColumnBounds } from './overlay'

/**
 * 登记一个「浮在页面上的东西」。
 *
 * 浏览器页面是原生 `WebContentsView`，**永远画在 DOM 之上** —— 气泡、菜单、对话框
 * 只要跟它的矩形重叠，就会被盖住（连对话框都点不到）。DOM 这边没有 z-index 能赢过它，
 * 唯一的办法是：有浮层的时候把原生视图收起来。
 *
 * 只跟浏览器重叠的浮层才收（`coversBrowser`）—— 贴左边缘的气泡和菜单碰不到右边，
 * 收起来只会让右边的页面无端闪一下。铺满左列的对话框用 `useLeftColumnOverlay()`，
 * 它按左列的实际范围算；单独传 `true` 只剩「确定铺满整窗」那一种情况。
 *
 * 用法：在渲染浮层的组件里调一次，挂载时登记、卸载时撤销。计数而不是布尔 ——
 * 菜单里再开一个确认框时，关上内层不该把外层的也撤销掉。
 */
export function useOverlay(coversBrowser = true): void {
  const push = useStore((s) => s.pushOverlay)
  const pop = useStore((s) => s.popOverlay)
  useEffect(() => {
    if (!coversBrowser) return
    push(true)
    return () => pop(true)
  }, [coversBrowser, push, pop])
}

/**
 * 铺满左列的浮层（对话框、遮罩）的兜底判定。
 *
 * 它们的宽度被 `--left-w` 限在左列里，而原生视图在右栏 —— 几何上不重叠，
 * 正常路径上不会收起页面。真的遇到越界（将来有更怪的布局）时这里仍然会报重叠。
 */
export function useLeftColumnOverlay(): void {
  const push = useStore((s) => s.pushOverlay)
  const pop = useStore((s) => s.popOverlay)
  const browserSpan = useStore((s) => s.browserSpan)
  useEffect(() => {
    // 布局量在 effect 里读 —— 渲染期间读 DOM 会把副作用混进渲染
    if (!coversBrowser(leftColumnBounds(), browserSpan)) return
    push(true)
    return () => pop(true)
  }, [browserSpan, push, pop])
}
