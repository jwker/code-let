import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { TabInfo } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { IconFolder } from './icons'
import { createTabCloseController, runningTabCloseCopy } from './tabClose'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * 标签栏 —— 顶部那一排，每个标签是一个打开的会话（PLAN.md D4 修订）。
 *
 * 位置是设计稿的 A 方案：标题栏下方独立一行，横向只盖主区那一列。
 *
 * 标签可以跨项目，所以每个标签上标出它属于哪个项目。
 */

/** 「＋」按钮宽度 —— 量可用宽度时要给它留出位置 */
const NEW_W = 26
/** 「⋯」按钮宽度 */
const OVERFLOW_W = 26
/** 药丸之间的间隙 */
const GAP = 6

export function TabBar() {
  const tabs = useStore((s) => s.snapshot.tabs)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)

  const containerRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER)
  const [hasOverflow, setHasOverflow] = useState(false)

  /**
   * 排不下的标签进「⋯」菜单。
   *
   * 量法：把每个标签的自然宽度加起来，跟**可用宽度**比。
   * 可用宽度要扣掉右侧固定占位的两个按钮（「⋯」「＋」）和它们之间的间隙 ——
   * 早先只扣了「＋」，多算进来的那截正好是「⋯」的位置，
   * 于是最后一个标签压在按钮底下，看着像「被挡住」。
   *
   * 「⋯」出现与否要先定下来再算宽度：不然「算宽度 → 出按钮 → 宽度变了 → 再算」会来回抖。
   * 所以分两种情况各算一次，一次定死。
   */
  useLayoutEffect(() => {
    const strip = stripRef.current
    const container = containerRef.current
    if (!strip || !container) return

    function recompute(): void {
      if (!strip || !container) return
      const widths = ([...strip.children] as HTMLElement[]).map((el) => el.offsetWidth)
      // 「＋」按钮 + 间隙：一直都在
      let avail = container.clientWidth - NEW_W - GAP
      const total = widths.reduce((sum, w) => sum + w + GAP, 0)

      if (total <= avail) {
        // 全部放得下 —— 不需要「⋯」
        setHasOverflow(false)
        setVisibleCount(widths.length)
        return
      }
      // 放不下 —— 「⋯」按钮也要占地方（它自己 + 间隙）
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
    // 标签的标题变了，宽度也跟着变 —— 得重量
  }, [tabs.map((t) => `${t.title}|${t.projectName}`).join('\u0001')])

  const hidden = hasOverflow && visibleCount < tabs.length ? tabs.slice(visibleCount) : []
  // 「＋」只列**清单里**的项目 —— 不是 Pi 聊过的所有项目
  const projects = useStore((s) => s.snapshot.projects)

  return (
    <div ref={containerRef} className="shell-tabs">
      <div ref={stripRef} className="shell-tabs-strip flex min-w-0 items-center overflow-hidden">
        {tabs.map((tab, index) => (
          <Tab
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            clipped={index >= visibleCount}
          />
        ))}
      </div>

      {hidden.length > 0 && <OverflowMenu tabs={hidden} onPick={(id) => void host.activateTab(id)} />}

      <NewTabMenu projects={projects} />
    </div>
  )
}

/** 一个标签 */
function Tab({ tab, active, clipped }: { tab: TabInfo; active: boolean; clipped: boolean }) {
  // 关标签的流程在 tabClose.ts 里（纯逻辑，好测）
  //
  // 标签对象每次快照都是新的 —— 控制器读 ref 里的最新那份，
  // 「那一轮是不是还在跑」才不会停在创建控制器的那一刻。
  const tabRef = useRef(tab)
  tabRef.current = tab
  const controller = useMemo(
    () =>
      createTabCloseController({
        getTab: () => tabRef.current,
        closeTab: (tabId) => host.closeTab(tabId)
      }),
    [tab.id]
  )
  const { asking } = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)

  async function close(): Promise<void> {
    // 正在跑就先问一句 —— 关掉就中止那一轮（D4 修订）
    await controller.requestClose()
  }

  /**
   * 重新加载：这个会话在别处被改过，重建 runtime 从磁盘重读。
   *
   * 重建完要让渲染进程把内容流也重读一遍 —— 不然 runtime 是新的、屏幕还是旧的。
   */
  async function reload(): Promise<void> {
    await useStore.getState().reloadTab(tab.id)
  }

  return (
    <>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => void host.activateTab(tab.id)}
        title={[
          `${tab.title} · ${tab.projectName}`,
          tab.removed ? '（这个项目已经从 Codelet 移除，对话还在磁盘上）' : '',
          tab.stale ? '（这个会话在别处有更新，点右边的 ↻ 重新加载）' : ''
        ].join('')}
        className={[
          'tab group/tab no-drag flex items-center gap-1.5 px-2 text-left transition-colors',
          clipped ? 'tab-clipped' : ''
        ].join(' ')}
      >
        {tab.streaming ? (
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-info" />
        ) : null}
        <span className="min-w-0 truncate">{tab.title}</span>
        {/* 项目标识：药丸里用圆点分隔，不用竖线（竖线跟药丸边框会读成双线） */}
        <span aria-hidden="true" className="flex-none text-[11px] leading-none text-fg-3 opacity-70">
          ·
        </span>
        <span
          className={[
            'max-w-[72px] flex-none truncate text-[9.5px]',
            // 项目已经从清单里移走了 —— 用告警色标出来
            tab.removed ? 'text-warn' : 'text-fg-3'
          ].join(' ')}
        >
          {tab.projectName}
        </span>
        {/*
          会话在别处被改过 —— 给一个重新加载的入口。
          不自动同步：重建 runtime 会丢掉当前状态，而且如果别处还在写，重建完很快又落后。
        */}
        {tab.stale ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={`重新加载 ${tab.title}`}
            title="这个会话在别处有更新，点一下重新加载"
            onClick={(event) => {
              event.stopPropagation()
              void reload()
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.stopPropagation()
              event.preventDefault()
              void reload()
            }}
            className="flex h-4 w-4 flex-none items-center justify-center rounded text-warn transition-colors hover:bg-sunken"
          >
            ↻
          </span>
        ) : null}
        <span
          role="button"
          tabIndex={0}
          aria-label={`关闭 ${tab.title}`}
          onClick={(event) => {
            event.stopPropagation()
            void close()
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.stopPropagation()
            event.preventDefault()
            void close()
          }}
          className="flex h-4 w-4 flex-none items-center justify-center rounded text-fg-3 opacity-0 transition-opacity hover:bg-sunken hover:text-fg-1 focus:opacity-100 group-hover/tab:opacity-100"
        >
          ×
        </span>
      </button>

      {asking && (
        <ConfirmDialog
          {...runningTabCloseCopy(tab)}
          onCancel={() => controller.cancel()}
          onConfirm={() => {
            void controller.confirm()
          }}
        />
      )}
    </>
  )
}

/** 排不下的标签：「⋯」菜单 */
function OverflowMenu({ tabs, onPick }: { tabs: TabInfo[]; onPick: (id: string) => void }) {
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
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative flex-none" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="其他标签"
        title="其他标签"
        onClick={() => setOpen((v) => !v)}
        className="no-drag flex h-6 w-6 flex-none items-center justify-center rounded text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
      >
        »
      </button>
      {open && (
        <div
          role="menu"
          className="no-drag absolute right-0 top-full z-40 mt-1 w-60 rounded-xl border border-hairline bg-raised p-1"
          style={{ boxShadow: 'var(--sh-md)' }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onPick(tab.id)
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-sunken"
            >
              {tab.streaming ? (
                <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-info" />
              ) : null}
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-1">{tab.title}</span>
              <span className="max-w-[90px] flex-none truncate text-[10px] text-fg-3">{tab.projectName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** 「＋」：按项目列的菜单（新建对话需要一个目录，而「当前项目」这个概念已经没了） */
function NewTabMenu({ projects }: { projects: ProjectEntry[] }) {
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
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative flex-none" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="新建标签"
        title="新建标签"
        onClick={() => setOpen((v) => !v)}
        className="no-drag flex h-6 w-6 flex-none items-center justify-center rounded border border-dashed border-hairline-strong text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
      >
        ＋
      </button>
      {open && (
        <div
          role="menu"
          className="no-drag absolute right-0 top-full z-40 mt-1 w-60 rounded-xl border border-hairline bg-raised p-1"
          style={{ boxShadow: 'var(--sh-md)' }}
        >
          <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] text-fg-3">在哪个项目里新建</div>
          {projects.map((project) => (
            <button
              key={project.path}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                void host.newConversation(project.path)
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-fg-1 transition-colors hover:bg-sunken"
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              <span className="max-w-[110px] flex-none truncate font-mono text-[10px] text-fg-3">{project.path}</span>
            </button>
          ))}
          <div className="my-1 h-px bg-hairline" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              void host.openProject()
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-fg-1 transition-colors hover:bg-sunken"
          >
            <span className="flex-none text-fg-2">
              <IconFolder />
            </span>
            <span>打开项目…</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** 一个项目 —— 来自项目清单 */
interface ProjectEntry {
  path: string
  name: string
}
