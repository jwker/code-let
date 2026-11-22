import { useEffect, useState, type ReactElement } from 'react'
import type { RightPanelKind, RightPanelState } from '@contract/index'
import type { BrowserHost } from '@contract/browser'
import { host } from '../host'
import { activeProjectTab, paneOf, typeDefOf, useStore } from '../store'
import { IconBrowser, IconChevron, IconCode, IconDoc, IconPanel, IconPanelCollapse } from './icons'
import { FileTree } from './FileTree'
import { DocsList } from './DocsList'
import { BrowserPane } from './BrowserPane'
import { DocView } from './DocView'
import { GitChanges } from './GitChanges'
import { FilePreview } from './FilePreview'
import { GitDiffView } from './GitDiffView'
import { PaneResizer } from './PaneResizer'
import { useOverlay } from './useOverlay'
import { browserHostFor } from './browserHost'
import { changeCount } from './gitFormat'

/**
 * 右栏（票 02）。
 *
 * 从窗口顶边贯到底边，同一时刻只放一个功能区。顶栏右侧是功能切换器：
 * 图标和文字都是当前功能区，点开换别的。
 *
 * 收起后整条不渲染 —— 左列吃满窗口。
 */

const KIND_META: Record<RightPanelKind, { label: string; icon: () => ReactElement }> = {
  code: { label: '代码', icon: IconCode },
  docs: { label: '文档', icon: IconDoc },
  browser: { label: '浏览器', icon: IconBrowser }
}

/** 切换器里的三项，顺序跟原型一致：浏览器、代码、文档 */
const SWITCHABLE: RightPanelKind[] = ['browser', 'code', 'docs']

/** 代码功能区的两个视图：文件 / 改动。改动那个带未提交数量 */
function CodeTabs() {
  const mode = useStore((s) => s.codeMode)
  const setMode = useStore((s) => s.setCodeMode)
  const status = useStore((s) => s.git.status)
  const count = changeCount(status)

  const tabs: Array<{ key: 'files' | 'changes'; label: string; badge?: number }> = [
    { key: 'files', label: '文件' },
    { key: 'changes', label: '改动', badge: count }
  ]

  return (
    <div className="zone5-seg" role="tablist" aria-label="代码视图">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={mode === tab.key}
          onClick={() => setMode(tab.key)}
          className={['zone5-seg-item', mode === tab.key ? 'is-active' : ''].join(' ')}
        >
          {tab.label}
          {tab.badge ? <span className="zone5-seg-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** 代码功能区：左边文件树（文件 / 改动），右边文件内容或选中的 diff */
function CodePanel() {
  const mode = useStore((s) => s.codeMode)
  const snapshot = useStore((s) => s.snapshot)
  const files = snapshot.files
  const activeFileId = snapshot.activeFileId
  const change = useStore((s) => s.git.selected)
  const closeChange = useStore((s) => s.closeChange)
  const loadFile = useStore((s) => s.loadFile)
  const activeFile = files.find((file) => file.id === activeFileId) ?? null
  const cwd = activeProjectTab(snapshot)?.cwd ?? ''

  // 进代码功能区就把 Git 状态读一次 —— 「改动」tab 上的数量要先有
  useEffect(() => {
    if (!cwd) return
    void useStore.getState().loadGitStatus(cwd)
  }, [cwd])

  /*
   * 活动文件变了就去读它的内容。
   *
   * 不能只靠「打开文件」那一步：重启恢复出来的文件没走过 `openFile`，缓存是空的。
   * `loadFile` 自己有缓存判断，重复调无妨。
   */
  useEffect(() => {
    if (!activeFile) return
    void loadFile(activeFile.path, activeFile.cwd)
  }, [activeFile?.path, activeFile?.cwd, loadFile])

  // 选中一个改动时 Esc 回到文件预览 —— 跟原来 Git 面板的手感一致
  useEffect(() => {
    if (!change) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeChange()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [change, closeChange])

  if (!cwd) return <div className="rp-empty-note">先打开一个项目</div>

  return (
    <div className="panel-split">
      <div className="panel-tree">
        <CodeTabs />
        <div className="panel-tree-body">
          {mode === 'changes' ? <GitChanges cwd={cwd} /> : <FileTree cwd={cwd} />}
        </div>
      </div>
      <div className="panel-body">
        {change ? (
          <GitDiffView />
        ) : (
          <FilePreview
            files={files}
            activeFileId={activeFileId}
            onActivate={(id) => void host.activateFile(id)}
            onClose={(id) => void host.closeFile(id)}
          />
        )}
      </div>
    </div>
  )
}

/** 文档功能区：左边文档树，右边只读正文 */
function DocsPanel() {
  const snapshot = useStore((s) => s.snapshot)
  const cwd = activeProjectTab(snapshot)?.cwd ?? ''

  if (!cwd) return <div className="rp-empty-note">先打开一个项目</div>

  return (
    <div className="panel-split">
      <div className="panel-tree">
        <div className="panel-tree-body">
          <DocsList cwd={cwd} />
        </div>
      </div>
      <div className="panel-body">
        <DocView cwd={cwd} />
      </div>
    </div>
  )
}

/**
 * 浏览器功能区：工具栏、页面标签行和网页本身都在右栏里。
 *
 * 看哪个宿主由左列决定（`browserHostFor`）；`key` 让切 agent 时整个面板重建，
 * 不把上一个宿主的标签短暂地留在屏幕上。
 */
function BrowserPanel({ host }: { host: BrowserHost }) {
  return <BrowserPane key={host} host={host} />
}

/** 空态：右栏展开着但还没选功能区。空态不是收起 */
function EmptyPanel() {
  const openRightPanel = useStore((s) => s.openRightPanel)
  return (
    <div className="rp-empty">
      <div className="rp-empty-icon">
        <IconPanel />
      </div>
      <h3>右侧栏是空的</h3>
      <p>浏览器、代码、文档都放在这一栏。挑一样打开。</p>
      <div className="rp-pick">
        <button type="button" onClick={() => openRightPanel('browser')}>
          <IconBrowser />
          浏览器
        </button>
        <button type="button" onClick={() => openRightPanel('code')}>
          <IconCode />
          代码
        </button>
        <button type="button" onClick={() => openRightPanel('docs')}>
          <IconDoc />
          文档
        </button>
      </div>
    </div>
  )
}

/**
 * 功能切换器：图标和文字都是当前功能区，点开下拉换别的。
 *
 * 走跟空态三个按钮同一个动作（`openRightPanel`）—— 展开右栏、写入 kind、
 * 顶栏标识跟着快照一起换。不碰任何 agent。
 */
function FunctionSwitcher({ current }: { current: RightPanelKind }) {
  const openRightPanel = useStore((s) => s.openRightPanel)
  const [open, setOpen] = useState(false)
  const meta = KIND_META[current]
  const Icon = meta.icon

  /*
   * 下拉展开时会盖到右栏的页面上，而网页是原生视图、永远画在 DOM 之上 ——
   * 开着的时候把它收起来，菜单才看得到；关掉立刻露回去。
   */
  useOverlay(open)

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <div className="rp-func-wrap">
      <button
        type="button"
        className="rp-func"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`切换功能区，当前是${meta.label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon />
        <span>{meta.label}</span>
        <span className="rp-func-chev">
          <IconChevron />
        </span>
      </button>

      {open && (
        <>
          {/* 点外面关掉。不可见，不压右栏内容 */}
          <div className="fixed inset-0 z-[55]" onClick={() => setOpen(false)} />
          <div role="menu" aria-label="切换功能区" className="rp-func-menu">
            {SWITCHABLE.map((key) => {
              const item = KIND_META[key]
              const ItemIcon = item.icon
              return (
                <button
                  key={key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={key === current}
                  onClick={() => {
                    setOpen(false)
                    if (key !== current) openRightPanel(key)
                  }}
                >
                  <ItemIcon />
                  <span>{item.label}</span>
                  <span className="rp-func-check" aria-hidden="true">
                    ✓
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

interface RightPanelProps {
  panel: RightPanelState
  /** 当前宽度（像素）—— App 算好传进来 */
  width: number
  /** 拖动时只改 DOM 变量，不触发渲染 */
  onDrag: (width: number) => void
  onCommit: (width: number) => void
  minWidth: number
  maxWidth: number
  defaultWidth: number
}

/**
 * 右栏的壳：顶栏（在看什么 + 功能切换器 + 收起）与功能区。
 *
 * 顶栏高度跟标题栏一致 —— 两栏从视觉上从同一条顶线开始。
 */
export function RightPanel({
  panel,
  width,
  onDrag,
  onCommit,
  minWidth,
  maxWidth,
  defaultWidth
}: RightPanelProps) {
  const snapshot = useStore((s) => s.snapshot)
  const toggleRightPanel = useStore((s) => s.toggleRightPanel)
  const activeFileId = snapshot.activeFileId
  const change = useStore((s) => s.git.selected)
  const docsSelected = useStore((s) => s.docs.selected)
  const agentTypes = useStore((s) => s.agentTypes)
  const pane = useStore((s) => paneOf(s.snapshot))
  const activeAgent = snapshot.agents.find((item) => item.id === snapshot.activeAgentId) ?? null
  const browserHost = browserHostFor(pane, activeAgent, typeDefOf(agentTypes, activeAgent?.type))
  const browserState = useStore((s) => s.browserStates[browserHost])
  const cwd = activeProjectTab(snapshot)?.cwd ?? ''

  const kind = panel.kind
  const meta = kind ? KIND_META[kind] : null
  const Icon = meta?.icon ?? null

  /*
   * 顶栏左边写在看什么：代码写当前文件名（没开文件就写项目名），
   * 文档写选中的那一篇 —— 切换功能区后这里跟着换。
   */
  let title = ''
  if (kind === 'code') {
    const file = snapshot.files.find((item) => item.id === activeFileId)
    title = change?.path ?? file?.relPath ?? (cwd ? cwd.split('/').pop()! : '代码')
  } else if (kind === 'docs') {
    title = docsSelected ? (docsSelected.entry.relPath.split('/').pop() ?? '文档') : '文档'
  } else if (kind === 'browser') {
    const tab = browserState?.tabs.find((item) => item.id === browserState.activeTabId)
    title = tab?.title || '浏览器'
  }

  return (
    <aside className="right-panel" aria-label="右侧栏">
      <PaneResizer
        variant="right"
        label="调整右栏宽度"
        width={width}
        min={minWidth}
        defaultWidth={defaultWidth}
        ceiling={() => maxWidth}
        onDrag={onDrag}
        onCommit={onCommit}
      />

      <div className="rp-head">
        <div className="rp-title">
          {Icon ? <Icon /> : null}
          <span className="rp-title-name">{title}</span>
        </div>
        <div className="rp-head-actions">
          {kind && meta ? <FunctionSwitcher current={kind} /> : null}
          <button
            type="button"
            className="rp-close"
            aria-label="收起右栏"
            title="收起右栏"
            onClick={toggleRightPanel}
          >
            <IconPanelCollapse />
          </button>
        </div>
      </div>

      <div className="rp-body">
        {kind === 'code' ? (
          <CodePanel />
        ) : kind === 'docs' ? (
          <DocsPanel />
        ) : kind === 'browser' ? (
          <BrowserPanel host={browserHost} />
        ) : (
          <EmptyPanel />
        )}
      </div>
    </aside>
  )
}
