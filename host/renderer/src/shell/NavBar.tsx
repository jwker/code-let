import type { ReactElement } from 'react'
import type { NavEntry } from '@contract/index'
import { useStore } from '../store'
import { IconBoard, IconCode, IconMemory, IconSession, IconTerminal } from './icons'

/**
 * 导航栏 —— 原来在左边的导航轨，现在放在右侧面板顶部。
 *
 * 两种形态：
 * - 展开（检视器面板开着）：图标横排，5 个各占一格均匀铺满
 * - 收起（检视器收成 38px 窄轨）：图标竖排
 *
 * **只有图标，没有文字** —— 所以每一项都必须有 `title`，悬停能看到名字。
 */

const ENTRIES: Array<{ key: NavEntry; label: string; icon: () => ReactElement }> = [
  { key: 'session', label: '会话', icon: IconSession },
  { key: 'board', label: '看板', icon: IconBoard },
  { key: 'memory', label: '记忆', icon: IconMemory },
  { key: 'code', label: '代码', icon: IconCode },
  { key: 'terminal', label: '终端', icon: IconTerminal }
]

export function NavBar({ compact }: { compact: boolean }) {
  const nav = useStore((s) => s.nav)
  const setNav = useStore((s) => s.setNav)

  return (
    <div className={compact ? 'nav-rail' : 'nav-bar'}>
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
              'flex items-center justify-center rounded-lg transition-colors',
              compact ? 'h-7 w-7 flex-none' : 'h-6 flex-1',
              active ? 'bg-accent-wash text-fg-1' : 'text-fg-3 hover:bg-sunken hover:text-fg-2'
            ].join(' ')}
          >
            <IconComponent />
          </button>
        )
      })}
    </div>
  )
}
