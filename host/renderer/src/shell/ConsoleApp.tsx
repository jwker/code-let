import { useEffect } from 'react'
import { host } from '../host'
import { ConsolePane } from './ConsolePane'
import { WindowHeader } from './WindowHeader'

/**
 * 控制台的独立窗口 —— 从右侧面板分离出去的那一个。
 *
 * 跟设置窗口一样复用同一个渲染页面，靠查询参数区分。
 * 窗口自己带一条标题栏：标题 + 「收回面板」（关掉这个窗口，主窗口里的面板还在）。
 */
export function ConsoleApp() {
  // 文档标题 = 窗口标题。Dock 菜单和红绿灯旁边显示的都是它。
  useEffect(() => {
    document.title = '调试控制台'
  }, [])

  return (
    <div className="flex h-screen min-h-0 flex-col bg-canvas text-fg-1">
      <WindowHeader title="调试控制台">
        <button
          type="button"
          onClick={() => void host.closeConsoleWindow()}
          className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-fg-2 hover:text-fg-1"
        >
          收回面板
        </button>
      </WindowHeader>
      <div className="flex min-h-0 flex-1">
        <ConsolePane detached />
      </div>
    </div>
  )
}
