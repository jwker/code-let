import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProjectTabInfo } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { ConfirmDialog } from './ConfirmDialog'
import { IconFolder } from './icons'

/**
 * 项目标签栏（PLAN.md D50）。
 *
 * **一个标签就是一个项目** —— 不再是「一个标签一个会话」。
 * 会话在窄轨里（一个 agent 一条），关标签只是收起这个项目的页面。
 *
 * 标签可以跨项目，标题用目录名；同名目录靠 `title` 属性给完整路径。
 */

/** 「＋」按钮宽度 —— 量可用宽度时要给它留出位置 */
const NEW_W = 26
/** 「⋯」按钮宽度 */
const OVERFLOW_W = 26
/** 药丸之间的间隙 */
const GAP = 6

export function ProjectTabs() {
  const tabs = useStore((s) => s.snapshot.projectTabs)
  const activeId = useStore((s) => s.snapshot.activeProjectTabId)
  const agents = useStore((s) => s.snapshot.agents)
  const opening = useRef(false)

  const containerRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER)
  const [hasOverflow, setHasOverflow] = useState(false)
  const [pendingClose, setPendingClose] = useState<ProjectTabInfo | null>(null)

  /**
   * 排不下的标签进「⋯」菜单。
   *
   * 量法跟以前一样：把每个标签的自然宽度加起来跟可用宽度比。
   * 可用宽度要扣掉右侧固定占位的两个按钮（「⋯」「＋」）和间隙 ——
   * 「⋯」出现与否必须先定下来再算宽度，否则会来回抖。
   */
  useLayoutEffect(() => {
    const strip = stripRef.current
    const container = containerRef.current
    if (!strip || !container) return

    function recompute(): void {
      if (!strip || !container) return
      const widths = ([...strip.children] as HTMLElement[]).map((el) => el.offsetWidth)
      /*
       * 一条都没量到就别改状态。
       *
       * 量宽度和「渲染多少个」互相依赖：如果这里把 visibleCount 写成 0，
       * 条里就没有子元素，下一次测量永远是空的 —— 卡死在 0，标签再也显示不出来。
       * 所以所有标签一律渲染（排不下的用 `tab-clipped` 藏起来，仍然有布局盒），
       * 这里只决定「显示几个」。
       */
      if (widths.length !== tabs.length) return
      let avail = container.clientWidth - NEW_W - GAP
      const total = widths.reduce((sum, width) => sum + width + GAP, 0)

      if (total <= avail) {
        setHasOverflow(false)
        setVisibleCount(widths.length)
        return
      }
      avail -= OVERFLOW_W + GAP
      let used = 0
      let count = 0
      for (const width of widths) {
        if (used + width + GAP > avail) break
        used += width + GAP
        count += 1
      }
      setHasOverflow(true)
      setVisibleCount(Math.max(1, count))
    }

    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(container)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [tabs.length, tabs.map((tab) => tab.title).join('|')])

  const hidden = tabs.slice(visibleCount)

  /**
   * 切项目：同时也把窄轨停回这个项目上次的入口（R34）。
   *
   * 入口状态记在项目标签上（`ProjectTabInfo.pane`），所以切回来还是上次那页。
   */
  async function activateProject(tabId: string): Promise<void> {
    await host.activateProjectTab(tabId)
    const tab = useStore.getState().snapshot.projectTabs.find((item) => item.id === tabId)
    if (tab) useStore.getState().setPane(tab.pane)
  }

  async function openProject(): Promise<void> {
    if (opening.current) return
    opening.current = true
    try {
      await host.openProject()
    } finally {
      opening.current = false
    }
  }

  /**
   * 点 ×。
   *
   * 这个项目里还有 agent 在跑时先问一句 —— 但**只说「不会停它」**：
   * 关标签不中止任何 agent（R44），确认只是为了让人知道页面会消失。
   */
  function requestClose(tab: ProjectTabInfo): void {
    const running = agents.filter(
      (agent) => agent.cwd === tab.cwd && agent.archivedAt === null && agent.streaming
    )
    if (running.length === 0) {
      void host.closeProjectTab(tab.id)
      return
    }
    setPendingClose(tab)
  }

  return (
    <div ref={containerRef} className="shell-tabs no-drag">
      <div ref={stripRef} className="shell-tabs-strip">
        {tabs.map((tab, index) => (
          <ProjectTab
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            clipped={index >= visibleCount}
            onActivate={() => void activateProject(tab.id)}
            onClose={() => requestClose(tab)}
          />
        ))}
      </div>

      {hasOverflow && (
        <OverflowMenu
          tabs={hidden}
          onPick={(id) => void activateProject(id)}
        />
      )}

      <button
        type="button"
        title="打开项目"
        aria-label="打开项目"
        onClick={() => void openProject()}
        className="tabs-new"
      >
        ＋
      </button>

      {pendingClose && (
        <ConfirmDialog
          title="关掉这个项目页？"
          body="这个项目里还有 agent 在跑。关掉只收起页面，不会停止它们 —— 再点回来还在跑。"
          warning="正在跑的 agent 会继续跑，后台事件不会丢"
          confirmText="关掉页面"
          onCancel={() => setPendingClose(null)}
          onConfirm={() => {
            void host.closeProjectTab(pendingClose.id)
            setPendingClose(null)
          }}
        />
      )}
    </div>
  )
}

function ProjectTab({
  tab,
  active,
  clipped,
  onActivate,
  onClose
}: {
  tab: ProjectTabInfo
  active: boolean
  /** 排不下 —— 脱离文档流藏起来，但仍然有布局盒（量宽度要用） */
  clipped: boolean
  onActivate: () => void
  onClose: () => void
}) {
  const agents = useStore((s) => s.snapshot.agents)
  // 项目里有没有 agent 在跑 —— 标签上给一个小圆点，不用点进去就知道
  const running = agents.some(
    (agent) => agent.cwd === tab.cwd && agent.archivedAt === null && agent.streaming
  )

  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onActivate}
      title={tab.cwd}
      className={[
        'tab group/tab no-drag flex items-center gap-1.5 px-2 text-left transition-colors',
        clipped ? 'tab-clipped' : ''
      ].join(' ')}
    >
      {running ? <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-info" /> : null}
      <span className="min-w-0 truncate">{tab.title}</span>
      <span
        role="button"
        tabIndex={0}
        aria-label={`关闭 ${tab.title}`}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.stopPropagation()
          event.preventDefault()
          onClose()
        }}
        className="flex h-4 w-4 flex-none items-center justify-center rounded text-fg-3 opacity-0 transition-opacity hover:bg-sunken hover:text-fg-1 focus:opacity-100 group-hover/tab:opacity-100"
      >
        ×
      </span>
    </button>
  )
}

/** 排不下的标签：「⋯」菜单 */
function OverflowMenu({ tabs, onPick }: { tabs: ProjectTabInfo[]; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative no-drag">
      <button
        type="button"
        title={`还有 ${tabs.length} 个项目`}
        aria-label={`还有 ${tabs.length} 个项目`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="tabs-overflow"
      >
        ⋯
      </button>
      {open && (
        <div className="tabs-menu" role="menu">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="menuitem"
              title={tab.cwd}
              onClick={() => {
                setOpen(false)
                onPick(tab.id)
              }}
              className="tabs-menu-item"
            >
              <IconFolder size={14} />
              <span className="truncate">{tab.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
