import type { ReactElement } from 'react'
import type { NavEntry } from '@contract/index'
import { useStore } from '../store'
import {
  IconBoard,
  IconCode,
  IconMemory,
  IconMoon,
  IconPanelLeft,
  IconSession,
  IconSettings,
  IconSun,
  IconTerminal
} from './icons'

const ENTRIES: Array<{ key: NavEntry; label: string; icon: () => ReactElement }> = [
  { key: 'session', label: '会话', icon: IconSession },
  { key: 'board', label: '看板', icon: IconBoard },
  { key: 'memory', label: '记忆', icon: IconMemory },
  { key: 'code', label: '代码', icon: IconCode },
  { key: 'terminal', label: '终端', icon: IconTerminal }
]

/** 导航轨 —— 常驻终端面板是独立入口，跟对话区的终端模式不是一回事 */
export function Rail() {
  const nav = useStore((s) => s.nav)
  const setNav = useStore((s) => s.setNav)
  const theme = useStore((s) => s.theme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  return (
    <nav className="shell-rail flex flex-col items-center gap-1 bg-canvas px-2 py-3">
      <div
        aria-hidden="true"
        className="mb-3 grid h-8 w-8 place-items-center rounded-[10px] bg-fg-1 text-[13px] font-semibold text-canvas"
      >
        π
      </div>

      {ENTRIES.map((entry) => {
        const IconComponent = entry.icon
        const active = nav === entry.key
        return (
          <button
            key={entry.key}
            type="button"
            title={entry.label}
            aria-label={entry.label}
            aria-current={active}
            onClick={() => setNav(entry.key)}
            className={[
              'flex h-9 w-9 items-center justify-center rounded-[10px] transition-colors',
              active ? 'bg-accent-wash text-fg-1' : 'text-fg-3 hover:bg-sunken hover:text-fg-2'
            ].join(' ')}
          >
            <IconComponent />
          </button>
        )
      })}

      <div className="mt-auto flex flex-col items-center gap-1.5">
        <button
          type="button"
          title={sidebarOpen ? '隐藏侧栏 ⌘B' : '显示侧栏 ⌘B'}
          aria-label={sidebarOpen ? '隐藏侧栏' : '显示侧栏'}
          aria-pressed={sidebarOpen}
          onClick={toggleSidebar}
          className={[
            'flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-sunken hover:text-fg-2',
            sidebarOpen ? 'text-fg-2' : 'text-fg-3'
          ].join(' ')}
        >
          <IconPanelLeft />
        </button>
        <button
          type="button"
          title={theme === 'dark' ? '切到亮色' : '切到暗色'}
          aria-label={theme === 'dark' ? '切到亮色' : '切到暗色'}
          onClick={toggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-sunken hover:text-fg-2"
        >
          {theme === 'dark' ? <IconSun /> : <IconMoon />}
        </button>
        <button
          type="button"
          title="设置"
          aria-label="设置"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-sunken hover:text-fg-2"
        >
          <IconSettings />
        </button>
      </div>
    </nav>
  )
}
