import { useState } from 'react'
import { useStore } from '../store'
import { IconChevron, IconFolder } from './icons'
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
    <div className="relative px-2.5 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={current?.path}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left transition-colors hover:bg-sunken"
      >
        <span className="flex-none text-fg-2">
          <IconFolder />
        </span>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg-1">
          {current?.name ?? '未选择项目'}
        </span>
        <span className="flex-none text-fg-3">
          <IconChevron />
        </span>
      </button>

      {open && (
        <div
          className="absolute left-2.5 right-2.5 top-full z-20 mt-1 overflow-hidden rounded-xl border border-hairline bg-raised p-1"
          style={{ boxShadow: 'var(--sh-lg)' }}
        >
          <div className="px-2.5 py-2 text-[11px] text-fg-3">最近项目</div>
          {snapshot.projects.length === 0 && (
            <div className="px-2.5 py-2 text-[12px] text-fg-3">还没有项目</div>
          )}
          {snapshot.projects.map((project) => (
            <button
              key={project.path}
              type="button"
              onClick={() => void handleSwitch(project.path)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] text-fg-2 transition-colors hover:bg-sunken"
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="min-w-0 truncate font-mono text-[10px] text-fg-3">
                {shorten(project.path)}
              </span>
            </button>
          ))}
          <div className="my-1 h-px bg-hairline" />
          <button
            type="button"
            onClick={() => void handleOpenProject()}
            className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[12.5px] text-fg-1 transition-colors hover:bg-sunken"
          >
            打开项目…
          </button>
        </div>
      )}
    </div>
  )
}
