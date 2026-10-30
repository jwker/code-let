import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ConversationInfo, TabInfo } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { IconFolder } from './icons'
import { createTabCloseController, runningTabCloseCopy } from './tabClose'

/**
 * 标签栏 —— 顶部那一排，每个标签是一个打开的会话（PLAN.md D4 修订）。
 *
 * 位置是设计稿的 A 方案：标题栏下方独立一行，横向只盖主区那一列。
 *
 * 标签可以跨项目，所以每个标签上标出它属于哪个项目。
 */

/** 「＋」按钮宽度 —— 量可用宽度时要给它留出位置 */
const NEW_W = 26

export function TabBar() {
  const tabs = useStore((s) => s.snapshot.tabs)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)
  const conversations = useStore((s) => s.snapshot.conversations)

  const containerRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(Number.MAX_SAFE_INTEGER)

  /**
   * 排不下的标签进「⋯」菜单。
   *
   * 量法：所有标签都摆在一条不换行的行里（`overflow: hidden` 裁掉多余的），
   * 逐个看它的右边缘有没有超出容器的可用宽度 —— 超出的第一个开始就是排不下的。
   */
  useLayoutEffect(() => {
    const strip = stripRef.current
    const container = containerRef.current
    if (!strip || !container) return

    function recompute(): void {
      if (!strip || !container) return
      const children = [...strip.children] as HTMLElement[]
      const limit = container.clientWidth - NEW_W
      let count = children.length
      for (let i = 0; i < children.length; i++) {
        if (children[i].offsetLeft + children[i].offsetWidth > limit) {
          count = i
          break
        }
      }
      setVisibleCount(Math.max(1, count))
    }

    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(container)
    return () => observer.disconnect()
  }, [tabs.length])

  const hidden = visibleCount < tabs.length ? tabs.slice(visibleCount) : []
  const projects = useProjects(conversations, tabs)

  return (
    <div ref={containerRef} className="shell-tabs flex min-w-0 items-stretch">
      <div ref={stripRef} className="flex min-w-0 flex-1 overflow-hidden">
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

  return (
    <>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => void host.activateTab(tab.id)}
        title={`${tab.title} · ${tab.projectName}`}
        className={[
          'tab group/tab relative flex max-w-[190px] flex-none items-center gap-1.5 border-r border-hairline px-2.5 text-left text-[11.5px] transition-colors',
          active ? 'bg-surface text-fg-1' : 'text-fg-2 hover:bg-sunken',
          clipped ? 'invisible' : ''
        ].join(' ')}
      >
        {tab.streaming ? (
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-info" />
        ) : null}
        <span
          className={[
            'min-w-0 truncate',
            active ? 'font-semibold' : 'font-medium'
          ].join(' ')}
        >
          {tab.title}
        </span>
        {/*
          项目标识用中间点，不画竖线。
          竖线跟标签之间的分隔线（border-r）挨着会读成双竖线 ——
          标签里只剩一条竖线时，它就只表示「标签边界」，不再有歧义。
          中间点也是应用里已有的分隔语言（元信息行、摘要行都用「·」）。
        */}
        <span className="flex flex-none items-center gap-1 text-[9.5px] text-fg-3">
          <span aria-hidden="true" className="text-[11px] leading-none opacity-70">
            ·
          </span>
          <span className="max-w-[78px] truncate">{tab.projectName}</span>
        </span>
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
        className="flex h-full w-[26px] items-center justify-center text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-60 rounded-xl border border-hairline bg-raised p-1"
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
        className="flex h-full w-[26px] items-center justify-center text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
      >
        ＋
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-60 rounded-xl border border-hairline bg-raised p-1"
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

/** 一个项目 */
interface ProjectEntry {
  path: string
  name: string
}

/**
 * 项目清单：从会话列表和打开的标签里取（目录就是项目）。
 *
 * `cwd` 为空的老会话归到「未知项目」—— Pi 的注释里写了老会话可能是空字符串。
 */
function useProjects(conversations: ConversationInfo[], tabs: TabInfo[]): ProjectEntry[] {
  return useMemo(() => {
    const map = new Map<string, ProjectEntry>()
    const add = (path: string): void => {
      if (!path) return
      if (map.has(path)) return
      map.set(path, { path, name: basenameOf(path) })
    }
    for (const conversation of conversations) add(conversation.cwd)
    for (const tab of tabs) add(tab.cwd)
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [conversations, tabs])
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}

/** 确认框（关掉正在跑的标签时用） */
function ConfirmDialog({
  title,
  body,
  confirmText,
  cancelText,
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  confirmText: string
  cancelText: string
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-[330px] rounded-xl border border-hairline bg-raised p-4"
        style={{ boxShadow: 'var(--sh-lg)' }}
      >
        <div className="text-[13.5px] font-semibold text-fg-1">{title}</div>
        <div className="mt-2 text-[12.5px] leading-relaxed text-fg-2">{body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 rounded-lg border border-hairline-strong px-3 text-[12.5px] text-fg-1 transition-colors hover:bg-sunken"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="h-7 rounded-lg bg-danger px-3 text-[12.5px] text-white transition-opacity hover:opacity-90"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
