import { useEffect } from 'react'
import { useStore } from '../store'

/**
 * 登记一个「浮在页面上的东西」。
 *
 * 浏览器页面是原生 `WebContentsView`，**永远画在 DOM 之上** —— 气泡、菜单、对话框
 * 只要跟它的矩形重叠，就会被盖住（连对话框都点不到）。DOM 这边没有 z-index 能赢过它，
 * 唯一的办法是：有浮层的时候把原生视图收起来。
 *
 * 用法：在渲染浮层的组件里调一次，挂载时登记、卸载时撤销。计数而不是布尔 ——
 * 菜单里再开一个确认框时，关上内层不该把外层的也撤销掉。
 */
export function useOverlay(): void {
  const push = useStore((s) => s.pushOverlay)
  const pop = useStore((s) => s.popOverlay)
  useEffect(() => {
    push()
    return () => pop()
  }, [push, pop])
}
