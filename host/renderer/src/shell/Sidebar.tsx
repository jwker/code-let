import { useEffect, useRef, useState } from 'react'
import type { ConversationInfo, ProjectInfo, TabInfo } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { IconCollapseAll, IconExpandAll, IconFolder, IconSliders } from './icons'
import { ConfirmDialog } from './ConfirmDialog'
import { collapseAll, expandAll, showExpandAll } from './sidebarCollapse'

/**
 * 上下文侧栏 —— 宿主独占（PLAN.md D11 修订）。
 *
 * 顶部是**标题「项目」+ 一颗选项钮**（sliders）—— 标题不是按钮，
 * 所有动作（打开项目、收起/展开全部）都在那颗钮的浮层里。
 * 下面是**按项目分组**的全部会话。
 * 没有「当前项目」了 —— 标签栏之后每个标签自带自己的目录（PLAN.md D4 修订）。
 */

/** 分组状态记在 localStorage —— 渲染进程的 UI 状态，不进主进程 */
const COLLAPSED_KEY = 'codelet:sidebar-collapsed-projects'

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    const parsed = raw ? (JSON.parse(raw) as string[]) : []
    return new Set(Array.isArray(parsed) ? parsed : [])
  } catch {
    return new Set()
  }
}

function saveCollapsed(collapsed: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
  } catch {
    // 存不下就算了
  }
}

export function Sidebar() {
  const conversations = useStore((s) => s.snapshot.conversations)
  const projects = useStore((s) => s.snapshot.projects)
  const tabs = useStore((s) => s.snapshot.tabs)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed())
  /** 待确认移除的项目 */
  const [removing, setRemoving] = useState<ProjectInfo | null>(null)
  /** 头部那颗 sliders 打开的浮层 */
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsRef = useRef<HTMLDivElement>(null)

  // 分组只按**清单里的项目**分 —— 不是 Pi 聊过的所有项目
  const groups = groupByProject(projects, conversations)

  // 浮层开着的时候，点外面或按 Esc 关掉
  useEffect(() => {
    if (!optionsOpen) return
    function onDown(event: MouseEvent): void {
      if (optionsRef.current && !optionsRef.current.contains(event.target as Node)) setOptionsOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOptionsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [optionsOpen])

  function toggle(project: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      saveCollapsed(next)
      return next
    })
  }

  /** 一次收放所有项目 —— 约定一：有组收着就展开，没有就全收起 */
  function toggleAll(): void {
    setCollapsed((prev) => {
      const next = showExpandAll(projects, prev) ? expandAll() : collapseAll(projects)
      saveCollapsed(next)
      return next
    })
  }

  /** 该显示「展开全部项目」还是「收起全部项目」 */
  const expandAllShown = showExpandAll(projects, collapsed)

  return (
    <aside className="shell-card side">
      <div className="side-panel">
        {/*
          头部：标题 + 两颗按钮。
          标题就是标题 —— 看着是个分区标题，点它没反应。
          右边两颗：收放全部（直接生效，不藏在菜单里）、选项（浮层里是「打开项目」）。
          收放全部单独拎出来，因为它是一次性动作，跟「打开项目」那种会开浮层的不是一类；
          而且常收常展，每次点两下太绕。
        */}
        <div className="relative px-2.5 pt-3" ref={optionsRef}>
          <div className="flex items-center gap-1">
            <span className="flex-1 pl-1.5 text-[12.5px] font-semibold text-fg-2">项目</span>
            {/* 一个项目都没有时没有可收放的东西 */}
            {projects.length > 0 && (
              <button
                type="button"
                aria-label={expandAllShown ? '展开全部项目' : '收起全部项目'}
                title={expandAllShown ? '展开全部项目' : '收起全部项目'}
                onClick={toggleAll}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
              >
                {expandAllShown ? <IconExpandAll /> : <IconCollapseAll />}
              </button>
            )}
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={optionsOpen}
              aria-label="项目选项"
              title="项目选项"
              onClick={() => setOptionsOpen((v) => !v)}
              className={[
                'flex h-7 w-7 flex-none items-center justify-center rounded-lg transition-colors',
                optionsOpen ? 'bg-sunken text-fg-1' : 'text-fg-3 hover:bg-sunken hover:text-fg-1'
              ].join(' ')}
            >
              <IconSliders />
            </button>
          </div>

          {optionsOpen && (
            <div
              role="menu"
              className="absolute right-2.5 top-full z-30 mt-1 w-[168px] rounded-xl border border-hairline bg-raised p-1"
              style={{ boxShadow: 'var(--sh-md)' }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOptionsOpen(false)
                  void host.openProject()
                }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-fg-1 transition-colors hover:bg-sunken"
              >
                <span className="flex-none text-fg-2">
                  <IconFolder size={15} />
                </span>
                <span>打开项目…</span>
              </button>
            </div>
          )}
        </div>

        <div className="mx-2.5 mt-2 h-px bg-hairline" />

        <div className="flex-1 overflow-y-auto pb-4">
          {groups.length === 0 && (
            <div className="px-4 py-8 text-center text-[12.5px] text-fg-3">
              还没有对话
              <br />
              点右上角的选项，打开一个项目
            </div>
          )}

          {groups.map((group) => (
            <ProjectGroup
              key={group.path}
              project={group.path}
              name={group.name}
              count={group.conversations.length}
              collapsed={collapsed.has(group.path)}
              onToggle={() => toggle(group.path)}
              onRemove={() => setRemoving(group)}
              conversations={group.conversations}
              tabs={tabs}
              activeTabId={activeTabId}
            />
          ))}
        </div>
      </div>

      {removing && (
        <ConfirmDialog
          title="从 Codelet 移除这个项目？"
          body={`「${removing.name}」不会再出现在 Codelet 的项目列表里。Pi 存的对话还在磁盘上，一个字都没动 —— 重新「打开项目」指到同一个目录就能回来。`}
          confirmText="移除"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const target = removing
            setRemoving(null)
            void host.removeProject(target.path)
          }}
        />
      )}
    </aside>
  )
}

/** 一个项目分组 */
function ProjectGroup({
  project,
  name,
  count,
  collapsed,
  onToggle,
  onRemove,
  conversations,
  tabs,
  activeTabId
}: {
  project: string
  name: string
  count: number
  collapsed: boolean
  onToggle: () => void
  onRemove: () => void
  conversations: ConversationInfo[]
  tabs: TabInfo[]
  activeTabId: string | null
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // 点外面关掉菜单
  useEffect(() => {
    if (!menuOpen) return
    function onDown(event: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div className="px-2 pt-2">
      <div className="group/grp relative flex h-7 items-center gap-1 rounded-lg px-1.5 hover:bg-sunken">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          <span className="w-3 flex-none text-center text-[9px] text-fg-3">{collapsed ? '▶' : '▼'}</span>
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-fg-1">{name}</span>
          <span className="flex-none font-mono text-[10px] text-fg-3">{count}</span>
        </button>

        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`${name} 的操作`}
            title="更多"
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-5 w-5 flex-none items-center justify-center rounded text-fg-3 opacity-0 transition-opacity hover:bg-sunken hover:text-fg-1 focus:opacity-100 group-hover/grp:opacity-100"
          >
            ⋯
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full z-30 mt-1 w-44 rounded-xl border border-hairline bg-raised p-1"
              style={{ boxShadow: 'var(--sh-md)' }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void host.newConversation(project)
                }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-fg-1 transition-colors hover:bg-sunken"
              >
                <span>新建对话</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  void navigator.clipboard?.writeText(project)
                }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-fg-1 transition-colors hover:bg-sunken"
              >
                <span>复制项目路径</span>
              </button>
              <div className="my-1 h-px bg-hairline" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  onRemove()
                }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-danger transition-colors hover:bg-sunken"
              >
                <span>从 Codelet 移除</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="pb-1 pl-3">
          {groupByTime(conversations).map((group) => (
            <div key={group.label}>
              <div className="px-2 pb-1 pt-2 text-[11px] text-fg-3">{group.label}</div>
              {group.conversations.map((conversation) => (
                <ConversationRow
                  key={conversation.path}
                  conversation={conversation}
                  tab={tabs.find((t) => t.path === conversation.path)}
                  active={tabs.find((t) => t.path === conversation.path)?.id === activeTabId}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 一条会话 */
function ConversationRow({
  conversation,
  tab,
  active
}: {
  conversation: ConversationInfo
  tab: TabInfo | undefined
  active: boolean
}) {
  async function open(): Promise<void> {
    // 已经在标签栏里开着 → 切过去，不要再开一个
    if (tab) {
      await host.activateTab(tab.id)
      return
    }
    await host.openConversation(conversation.path, conversation.cwd)
  }

  return (
    <button
      type="button"
      onClick={() => void open()}
      title={conversation.title}
      className={[
        'group flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors',
        active ? 'bg-accent-wash text-fg-1' : 'text-fg-2 hover:bg-sunken'
      ].join(' ')}
    >
      {tab?.streaming ? (
        <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-info" />
      ) : tab ? (
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-fg-3 opacity-60" />
      ) : null}
      <span className={['min-w-0 flex-1 truncate text-[13.5px]', active ? 'font-medium' : ''].join(' ')}>
        {conversation.title}
      </span>
      <span className="flex-none font-mono text-[10px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">
        {relativeTime(conversation.modified)}
      </span>
    </button>
  )
}

/** 一个项目分组 */
interface ProjectGroupData extends ProjectInfo {
  conversations: ConversationInfo[]
}

/**
 * 按项目分组。
 *
 * **以清单为准** —— 用户没选的项目，它的会话不列出来。
 * 清单里的项目即使一个会话都没有，也照样列出来（不然用户不知道自己选了什么）。
 */
function groupByProject(projects: ProjectInfo[], conversations: ConversationInfo[]): ProjectGroupData[] {
  return projects.map((project) => ({
    ...project,
    conversations: conversations.filter((conversation) => conversation.cwd === project.path)
  }))
}

function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function groupOf(modified: string): '今天' | '昨天' | '更早' {
  const time = new Date(modified).getTime()
  const today = startOfToday()
  if (time >= today) return '今天'
  if (time >= today - 86_400_000) return '昨天'
  return '更早'
}

const GROUP_ORDER = ['今天', '昨天', '更早'] as const

/** 组内按时间分组 */
function groupByTime(conversations: ConversationInfo[]): { label: string; conversations: ConversationInfo[] }[] {
  const groups = new Map<string, ConversationInfo[]>()
  for (const conversation of conversations) {
    const key = groupOf(conversation.modified)
    const bucket = groups.get(key)
    if (bucket) bucket.push(conversation)
    else groups.set(key, [conversation])
  }
  return GROUP_ORDER.filter((key) => groups.has(key)).map((key) => ({
    label: key,
    conversations: groups.get(key) ?? []
  }))
}

function relativeTime(modified: string): string {
  const diff = Math.max(0, Date.now() - new Date(modified).getTime())
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return `${Math.floor(diff / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)} 天前`
}
