import { useState } from 'react'
import { useStore } from '../store'
import { IconChevron } from './icons'
import { host } from '../host'

function shorten(path: string): string {
  // 渲染进程没有 node，拿不到 HOME；按路径形状猜就够了
  const match = /^\/(?:Users|home)\/[^/]+/.exec(path)
  return match ? `~${path.slice(match[0].length)}` : path
}

/**
 * 项目切换器 —— 侧栏顶部。
 *
 * 项目 = 一个目录。列表由宿主维护（userData），切换即换一桶对话。
 */
export function ProjectSwitcher() {
  const snapshot = useStore((s) => s.snapshot)
  const [open, setOpen] = useState(false)
  const current = snapshot.currentProject

  async function handleOpenProject(): Promise<void> {
    setOpen(false)
    await host.openProject()
  }

  async function handleSwitch(path: string): Promise<void> {
    setOpen(false)
    await host.switchProject(path)
  }

  return (
    <div className="relative border-b border-hairline px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-sunken"
      >
        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-sm border border-accent-line bg-accent-wash text-[10px] font-semibold text-accent">
          {(current?.name ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-semibold text-fg-1">
            {current?.name ?? '未选择项目'}
          </span>
          <span className="block truncate font-mono text-[10px] text-fg-3">
            {current ? shorten(current.path) : '—'}
          </span>
        </span>
        <span className="flex-none text-fg-3">
          <IconChevron />
        </span>
      </button>

      {open && (
        <div
          className="absolute left-3 right-3 top-full z-20 mt-1 overflow-hidden rounded-md border border-hairline-strong bg-surface"
          style={{ boxShadow: 'var(--sh-lg)' }}
        >
          <div className="border-b border-hairline px-3 py-1.5 text-[10px] tracking-[0.07em] text-fg-3 uppercase">
            最近项目
          </div>
          {snapshot.projects.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-fg-3">还没有项目</div>
          )}
          {snapshot.projects.map((project) => (
            <button
              key={project.path}
              type="button"
              onClick={() => void handleSwitch(project.path)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-fg-2 hover:bg-sunken"
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="min-w-0 truncate font-mono text-[10px] text-fg-3">
                {shorten(project.path)}
              </span>
            </button>
          ))}
          <div className="h-px bg-hairline" />
          <button
            type="button"
            onClick={() => void handleOpenProject()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-fg-1 hover:bg-sunken"
          >
            打开项目…
          </button>
        </div>
      )}
    </div>
  )
}
