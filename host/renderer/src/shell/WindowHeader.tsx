import type { ReactNode } from 'react'

/**
 * 分离窗口的标题栏。
 *
 * 设置窗口和控制台的独立窗口都用它 —— 标题在左，动作在右。
 * 这两个窗口用的是系统标题栏（不是自绘的），所以窗口里自己再带一条标题栏，
 * 免得内容看起来没有着落。
 */
export function WindowHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="flex h-11 flex-none items-center gap-3 border-b border-hairline bg-panel px-4">
      <span className="text-[13.5px] font-semibold text-fg-1">{title}</span>
      {children && <div className="ml-auto flex items-center gap-1.5">{children}</div>}
    </header>
  )
}
