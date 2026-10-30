import { useEffect, useRef, useState } from 'react'
import type { ConversationInfo, TabInfo } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { IconFolder } from './icons'

/**
 * 上下文侧栏 —— 宿主独占（PLAN.md D11 修订）。
 *
 * 顶部是应用名 +「打开项目」，下面是**按项目分组**的全部会话。
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
  const tabs = useStore((s) => s.snapshot.tabs)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed())

  // 项目分组：按会话的 cwd 分组，顺序按最近修改
  const groups = groupByProject(conversations)

  function toggle(project: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      saveCollapsed(next)
      return next
    })
  }

  return (
    <aside className="shell-card side">
      <div className="side-panel">
        <div className="px-2.5 pt-3">
          <button
            type="button"
            title="打开项目"
            aria-label="打开项目"
            onClick={() => void host.openProject()}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-[13.5px] text-fg-1 transition-colors hover:bg-sunken"
          >
            <span className="flex-none text-fg-2">
              <IconFolder />
            </span>
            <span>打开项目</span>
          </button>
        </div>

        <div className="mx-2.5 mt-2 h-px bg-hairline" />

        <div className="flex-1 overflow-y-auto pb-4">
          {groups.length === 0 && (
            <div className="px-4 py-8 text-center text-[12.5px] text-fg-3">
              还没有对话
              <br />
              点上面的「打开项目」开始
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
              conversations={group.conversations}
              tabs={tabs}
              activeTabId={activeTabId}
            />
          ))}
        </div>
      </div>
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
  conversations,
  tabs,
  activeTabId
}: {
  project: string
  name: string
  count: number
  collapsed: boolean
  onToggle: () => void
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

/** 一个项目 */
interface ProjectGroupData {
  path: string
  name: string
  conversations: ConversationInfo[]
}

/** 按项目分组。会话按 cwd 分，顺序按最近修改 */
function groupByProject(conversations: ConversationInfo[]): ProjectGroupData[] {
  const map = new Map<string, ConversationInfo[]>()
  for (const conversation of conversations) {
    const key = conversation.cwd || UNKNOWN_PROJECT
    const bucket = map.get(key)
    if (bucket) bucket.push(conversation)
    else map.set(key, [conversation])
  }
  return [...map.entries()].map(([path, list]) => ({
    path,
    name: path === UNKNOWN_PROJECT ? '未知项目' : basenameOf(path),
    conversations: list
  }))
}

/** 老会话的 cwd 可能是空字符串（Pi 的注释里写了）—— 归到「未知项目」 */
const UNKNOWN_PROJECT = 'unknown'

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
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
