import { useEffect, useRef, useState } from 'react'
import type { ConversationInfo, ProjectInfo, TabInfo } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import {
  IconClearSelection,
  IconCollapseAll,
  IconExpandAll,
  IconFolder,
  IconPencil,
  IconSelectAll,
  IconSliders,
  IconTrash
} from './icons'
import { ConfirmDialog } from './ConfirmDialog'
import { batchDeleteCopy, countAffectedTabs, projectNamesOf, singleDeleteCopy } from './conversationDelete'
import {
  allSelected,
  clearSelection,
  exitSelection,
  extendSelection,
  groupCheck,
  pruneSelection,
  selectAll,
  setGroupSelection,
  startSelection,
  toggleSelection,
  type ConversationSelection
} from './conversationSelection'
import { collapseAll, expandAll, showExpandAll } from './sidebarCollapse'

/**
 * 上下文侧栏 —— 宿主独占（PLAN.md D11 修订）。
 *
 * 顶部是**标题「项目」+ 两颗按钮**（收放全部、选项）。
 * 下面是**按项目分组**的全部会话。
 *
 * 删除会话（PLAN.md D23）有两种入口：
 * - 单条：行悬停时右侧出现废纸篓，确认后移入系统废纸篓
 * - 批量：项目选项菜单里进「选择对话」，勾选后从工具条删
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

/** 待确认的删除：单条记标题，批量只记路径（数量从快照现算） */
type PendingDelete =
  | { kind: 'single'; path: string; title: string }
  | { kind: 'batch'; paths: string[] }

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
  /** 批量选择状态 —— 纯界面状态，不落盘 */
  const [selection, setSelection] = useState<ConversationSelection>(exitSelection)
  /** 待确认的删除 */
  const [pending, setPending] = useState<PendingDelete | null>(null)
  /** 删除请求进行中 */
  const [deleting, setDeleting] = useState(false)
  /** 正在内联改名的会话路径 */
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  /** 改名请求进行中 */
  const [savingRename, setSavingRename] = useState(false)
  /** 删除 / 改名失败的原因 */
  const [actionError, setActionError] = useState<string | null>(null)
  const optionsRef = useRef<HTMLDivElement>(null)

  // 分组只按**清单里的项目**分 —— 不是 Pi 聊过的所有项目
  const groups = groupByProject(projects, conversations)
  const allPaths = conversations.map((conversation) => conversation.path)
  /** 范围选择只覆盖当前可见的行（折叠组里的要靠整组勾选） */
  const visibleOrder = groups.flatMap((group) =>
    collapsed.has(group.path) ? [] : group.conversations.map((conversation) => conversation.path)
  )
  const everySelected = allSelected(selection.paths, allPaths)

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

  // 选择模式里按 Esc 退出；确认框开着的时候交给 ConfirmDialog 自己关
  useEffect(() => {
    if (!selection.active || pending) return
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setSelection(exitSelection())
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selection.active, pending])

  // 快照刷新后剔掉已经不存在的会话（比如删成功了、或者别处删了）
  useEffect(() => {
    setSelection((current) => {
      if (!current.active) return current
      const next = pruneSelection(current, new Set(conversations.map((c) => c.path)))
      if (next === current) return current
      // 列表空了就退出选择模式，否则留着让用户接着选
      return conversations.length === 0 ? exitSelection() : next
    })
  }, [conversations])

  // 正在改名的会话被删掉了（本机或别处）—— 关掉输入框，别让它提交到一个不存在的路径
  useEffect(() => {
    if (!renamingPath) return
    if (!conversations.some((conversation) => conversation.path === renamingPath)) setRenamingPath(null)
  }, [conversations, renamingPath])

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

  /** 选择模式里点一行：Shift 走范围选择，否则切换勾选 */
  function pickRow(path: string, shiftKey: boolean): void {
    setSelection((current) =>
      shiftKey ? extendSelection(current, path, visibleOrder) : toggleSelection(current, path)
    )
  }

  function pickGroup(paths: string[], selected: boolean): void {
    setSelection((current) => setGroupSelection(current, paths, selected))
  }

  function startRename(path: string): void {
    setActionError(null)
    setRenamingPath(path)
  }

  /**
   * 提交改名。
   *
   * 空名字是合法的：清掉自定义名，标题退回首条用户消息。
   * 名字没变就不发请求，免得往会话文件里写一条无意义的 session_info。
   */
  async function commitRename(path: string, value: string): Promise<void> {
    const conversation = conversations.find((item) => item.path === path)
    if (!conversation) {
      setRenamingPath(null)
      return
    }
    const next = value.trim()
    if (next === (conversation.name ?? '').trim()) {
      setRenamingPath(null)
      return
    }
    setSavingRename(true)
    try {
      await host.renameConversation(path, next)
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setSavingRename(false)
      setRenamingPath(null)
    }
  }

  function askDeleteOne(conversation: ConversationInfo): void {
    setActionError(null)
    setPending({ kind: 'single', path: conversation.path, title: conversation.title })
  }

  function askDeleteSelected(): void {
    if (selection.paths.size === 0) return
    setActionError(null)
    setPending({ kind: 'batch', paths: [...selection.paths] })
  }

  /** 确认框里点了删除 —— 两种确认共用一个流程 */
  async function confirmDelete(): Promise<void> {
    if (!pending || deleting) return
    const current = pending
    setDeleting(true)
    setActionError(null)
    try {
      const paths = current.kind === 'single' ? [current.path] : current.paths
      const result = await host.deleteConversations(paths)
      if (result.failed.length > 0) {
        setActionError(`有 ${result.failed.length} 个没删掉：${result.failed[0].reason}`)
        // 批量删除部分失败 —— 留在选择模式，只保留失败的那些，方便直接重试
        if (current.kind === 'batch') {
          setSelection({
            active: true,
            paths: new Set(result.failed.map((item) => item.path)),
            anchor: null
          })
        }
      } else if (current.kind === 'batch') {
        setSelection(exitSelection())
      }
      setPending(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      setPending(null)
    } finally {
      setDeleting(false)
    }
  }

  const pendingPaths = pending
    ? pending.kind === 'single'
      ? [pending.path]
      : pending.paths
    : []
  const affected = countAffectedTabs(pendingPaths, tabs)
  const copy = pending
    ? pending.kind === 'single'
      ? singleDeleteCopy(pending.title, affected)
      : batchDeleteCopy(pending.paths.length, projectNamesOf(pending.paths, conversations, projects), affected)
    : null

  return (
    <aside className="shell-card side">
      <div className="side-panel">
        <div className="relative px-2.5 pt-3" ref={optionsRef}>
          {selection.active ? (
            /* 选择模式：头部换成工具条 */
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSelection(exitSelection())}
                className="h-6 flex-none rounded-md border border-hairline-strong px-2 text-[12px] text-fg-1 transition-colors hover:bg-sunken"
              >
                取消
              </button>
              <span
                aria-live="polite"
                className="min-w-0 flex-1 truncate text-center font-mono text-[11.5px] text-fg-2"
              >
                已选 {selection.paths.size} / {conversations.length}
              </span>
              <button
                type="button"
                title={everySelected ? '清空选择' : '全选'}
                aria-label={everySelected ? '清空选择' : '全选'}
                onClick={() =>
                  setSelection((current) =>
                    allSelected(current.paths, allPaths)
                      ? clearSelection(current)
                      : selectAll(current, allPaths)
                  )
                }
                className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
              >
                {everySelected ? <IconClearSelection size={15} /> : <IconSelectAll size={15} />}
              </button>
              <button
                type="button"
                title="删除选中的对话"
                aria-label="删除选中的对话"
                disabled={selection.paths.size === 0}
                onClick={askDeleteSelected}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-danger transition-colors hover:bg-danger-wash disabled:cursor-default disabled:text-fg-3 disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <IconTrash size={15} />
              </button>
            </div>
          ) : (
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
          )}

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
              <div className="my-1 h-px bg-hairline" />
              <button
                type="button"
                role="menuitem"
                disabled={conversations.length === 0}
                onClick={() => {
                  setOptionsOpen(false)
                  setActionError(null)
                  setRenamingPath(null)
                  setSelection(startSelection())
                }}
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-fg-1 transition-colors hover:bg-sunken disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="flex-none text-fg-2">
                  <IconSelectAll size={15} />
                </span>
                <span>选择对话</span>
              </button>
            </div>
          )}
        </div>

        <div className="mx-2.5 mt-2 h-px bg-hairline" />

        {actionError && (
          <div
            role="alert"
            style={{ borderColor: 'var(--danger-line)' }}
            className="mx-2.5 mt-2 rounded-lg border bg-danger-wash px-2.5 py-1.5 text-[11.5px] leading-snug text-danger"
          >
            {actionError}
          </div>
        )}

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
              selecting={selection.active}
              selectedPaths={selection.paths}
              onToggleGroup={pickGroup}
              onRowClick={pickRow}
              onDeleteRow={askDeleteOne}
              renamingPath={renamingPath}
              savingRename={savingRename}
              onStartRename={startRename}
              onCommitRename={commitRename}
              onCancelRename={() => setRenamingPath(null)}
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

      {copy && pending && (
        <ConfirmDialog
          title={copy.title}
          body={copy.body}
          warning={copy.warning}
          confirmText={copy.confirmText}
          danger
          busy={deleting}
          busyText="删除中…"
          onCancel={() => {
            if (!deleting) setPending(null)
          }}
          onConfirm={() => void confirmDelete()}
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
  activeTabId,
  selecting,
  selectedPaths,
  onToggleGroup,
  onRowClick,
  onDeleteRow,
  renamingPath,
  savingRename,
  onStartRename,
  onCommitRename,
  onCancelRename
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
  selecting: boolean
  selectedPaths: ReadonlySet<string>
  onToggleGroup: (paths: string[], selected: boolean) => void
  onRowClick: (path: string, shiftKey: boolean) => void
  onDeleteRow: (conversation: ConversationInfo) => void
  renamingPath: string | null
  savingRename: boolean
  onStartRename: (path: string) => void
  onCommitRename: (path: string, value: string) => void
  onCancelRename: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const groupPaths = conversations.map((conversation) => conversation.path)
  const check = groupCheck(selectedPaths, groupPaths)

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
        {selecting && (
          <button
            type="button"
            role="checkbox"
            aria-checked={check === 'some' ? 'mixed' : check === 'all'}
            aria-label={`选择 ${name} 的全部对话`}
            title={`选择 ${name} 的全部对话`}
            onClick={() => onToggleGroup(groupPaths, check !== 'all')}
            className="flex h-5 w-5 flex-none items-center justify-center rounded"
          >
            <Checkbox checked={check === 'all'} mixed={check === 'some'} />
          </button>
        )}
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
              {group.conversations.map((conversation) => {
                const tab = tabs.find((candidate) => candidate.path === conversation.path)
                const renaming = renamingPath === conversation.path
                return (
                  <ConversationRow
                    key={conversation.path}
                    conversation={conversation}
                    tab={tab}
                    active={tab?.id === activeTabId}
                    selecting={selecting}
                    selected={selectedPaths.has(conversation.path)}
                    renaming={renaming}
                    savingRename={savingRename && renaming}
                    onActivate={() => void openConversation(conversation, tab)}
                    onToggle={() => onRowClick(conversation.path, false)}
                    onExtend={() => onRowClick(conversation.path, true)}
                    onDelete={() => onDeleteRow(conversation)}
                    onStartRename={() => onStartRename(conversation.path)}
                    onCommitRename={(value) => onCommitRename(conversation.path, value)}
                    onCancelRename={onCancelRename}
                  />
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 打开一条会话：已经在标签栏里开着就切过去 */
async function openConversation(conversation: ConversationInfo, tab: TabInfo | undefined): Promise<void> {
  if (tab) {
    await host.activateTab(tab.id)
    return
  }
  await host.openConversation(conversation.path, conversation.cwd)
}

/** 一条会话 */
function ConversationRow({
  conversation,
  tab,
  active,
  selecting,
  selected,
  renaming,
  savingRename,
  onActivate,
  onToggle,
  onExtend,
  onDelete,
  onStartRename,
  onCommitRename,
  onCancelRename
}: {
  conversation: ConversationInfo
  tab: TabInfo | undefined
  active: boolean
  selecting: boolean
  selected: boolean
  renaming: boolean
  savingRename: boolean
  onActivate: () => void
  onToggle: () => void
  onExtend: () => void
  onDelete: () => void
  onStartRename: () => void
  onCommitRename: (value: string) => void
  onCancelRename: () => void
}) {
  const title = conversation.title

  if (renaming && !selecting) {
    return (
      <div className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1">
        <TabDot tab={tab} />
        <RenameInput
          initial={conversation.name ?? ''}
          placeholder={title}
          disabled={savingRename}
          onCommit={onCommitRename}
          onCancel={onCancelRename}
        />
      </div>
    )
  }

  if (selecting) {
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={selected}
        onClick={(event) => (event.shiftKey ? onExtend() : onToggle())}
        title={title}
        className={[
          'flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-left transition-colors',
          selected ? 'bg-accent-wash text-fg-1' : 'text-fg-2 hover:bg-sunken'
        ].join(' ')}
      >
        <Checkbox checked={selected} />
        <TabDot tab={tab} />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{title}</span>
      </button>
    )
  }

  return (
    <div
      className={[
        'group relative flex w-full items-center rounded-lg transition-colors',
        active ? 'bg-accent-wash text-fg-1' : 'text-fg-2 hover:bg-sunken'
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onActivate}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left"
      >
        <TabDot tab={tab} />
        <span
          className={['min-w-0 flex-1 truncate text-[13.5px]', active ? 'font-medium' : ''].join(' ')}
        >
          {title}
        </span>
        <span className="flex-none font-mono text-[10px] text-fg-3 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
          {relativeTime(conversation.modified)}
        </span>
      </button>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          title={`重命名「${title}」`}
          aria-label={`重命名「${title}」`}
          onClick={onStartRename}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
        >
          <IconPencil size={14} />
        </button>
        <button
          type="button"
          title={`删除「${title}」`}
          aria-label={`删除「${title}」`}
          onClick={onDelete}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-danger-wash hover:text-danger"
        >
          <IconTrash size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * 行内改名输入框。
 *
 * 回车提交，Esc 取消，失焦提交。输入法选词的回车不提交。
 * 初始值是**自定义名**（没有就空），占位符是当前默认标题 ——
 * 这样“留空 = 恢复默认标题”是看得见的。
 */
function RenameInput({
  initial,
  placeholder,
  disabled,
  onCommit,
  onCancel
}: {
  initial: string
  placeholder: string
  disabled: boolean
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const committed = useRef(false)
  const cancelled = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function commit(): void {
    if (committed.current) return
    committed.current = true
    onCommit(value)
  }

  function cancel(): void {
    cancelled.current = true
    onCancel()
  }

  return (
    <input
      ref={inputRef}
      value={value}
      disabled={disabled}
      maxLength={80}
      spellCheck={false}
      autoComplete="off"
      placeholder={placeholder}
      aria-label="对话名称"
      title="回车保存，Esc 取消；留空恢复默认标题"
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        // 输入法选词的回车不提交
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          cancel()
        }
      }}
      onBlur={() => {
        if (!cancelled.current) commit()
      }}
      className="h-6 min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface px-1.5 text-[13px] text-fg-1 outline-none transition-colors focus:border-accent-line disabled:opacity-60"
    />
  )
}

/** 会话是否开着标签：开着的灰点，正在跑的蓝点 */
function TabDot({ tab }: { tab: TabInfo | undefined }) {
  if (!tab) return null
  return (
    <span
      className={[
        'h-1.5 w-1.5 flex-none rounded-full',
        tab.streaming ? 'animate-pulse bg-info' : 'bg-fg-3 opacity-60'
      ].join(' ')}
    />
  )
}

/** 自定义复选框 —— 原生 input 的对勾在暗色下难对齐，用 span + SVG */
function Checkbox({ checked, mixed = false }: { checked: boolean; mixed?: boolean }) {
  const on = checked || mixed
  return (
    <span
      aria-hidden="true"
      className={[
        'flex h-[15px] w-[15px] flex-none items-center justify-center rounded-[4px] border',
        on ? 'border-accent bg-accent text-accent-fg' : 'border-hairline-strong bg-surface'
      ].join(' ')}
    >
      {mixed ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2 5h6" />
        </svg>
      ) : checked ? (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2 5.2 4.1 7.3 8 3.2" />
        </svg>
      ) : null}
    </span>
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
