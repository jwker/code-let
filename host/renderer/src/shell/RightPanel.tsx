import { useEffect, type ReactElement } from 'react'
import type { RightPanelKind, RightPanelState } from '@contract/index'
import { host } from '../host'
import { activeProjectTab, useStore } from '../store'
import { IconBrowser, IconChevron, IconCode, IconDoc, IconPanel, IconPanelCollapse } from './icons'
import { FileTree } from './FileTree'
import { GitChanges } from './GitChanges'
import { FilePreview } from './FilePreview'
import { GitDiffView } from './GitDiffView'
import { PaneResizer } from './PaneResizer'
import { changeCount } from './gitFormat'

/**
 * 右栏（票 02）。
 *
 * 从窗口顶边贯到底边，同一时刻只放一个功能区。这一版只有代码功能区接上；
 * 浏览器和文档的按钮先在空态里占位，下一单接上（票 04 / 05）。
 *
 * 收起后整条不渲染 —— 左列吃满窗口。
 */

const KIND_META: Record<RightPanelKind, { label: string; icon: () => ReactElement }> = {
  code: { label: '代码', icon: IconCode },
  docs: { label: '文档', icon: IconDoc },
  browser: { label: '浏览器', icon: IconBrowser }
}

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
    <div className="code-split">
      <div className="code-tree">
        <CodeTabs />
        <div className="code-tree-body">
          {mode === 'changes' ? <GitChanges cwd={cwd} /> : <FileTree cwd={cwd} />}
        </div>
      </div>
      <div className="code-body">
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

/** 还没接上的功能区（文档 / 浏览器）—— 下一单换成真内容 */
function PendingPanel({ kind }: { kind: 'docs' | 'browser' }) {
  const Icon = KIND_META[kind].icon
  return (
    <div className="rp-empty">
      <div className="rp-empty-icon">
        <Icon />
      </div>
      <h3>{KIND_META[kind].label}功能区还没接上</h3>
      <p>这一版右栏先只开代码。下一单接上{KIND_META[kind].label}。</p>
    </div>
  )
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
        <button type="button" disabled title="下一单接上">
          <IconBrowser />
          浏览器
        </button>
        <button type="button" onClick={() => openRightPanel('code')}>
          <IconCode />
          代码
        </button>
        <button type="button" disabled title="下一单接上">
          <IconDoc />
          文档
        </button>
      </div>
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
  const cwd = activeProjectTab(snapshot)?.cwd ?? ''

  const kind = panel.kind
  const meta = kind ? KIND_META[kind] : null
  const Icon = meta?.icon ?? null

  /*
   * 顶栏左边写在看什么：代码功能区写当前文件名（没开文件就写项目名）。
   * 文档 / 浏览器在各自的单里接上真标题。
   */
  let title = ''
  if (kind === 'code') {
    const file = snapshot.files.find((item) => item.id === activeFileId)
    title = change?.path ?? file?.relPath ?? (cwd ? cwd.split('/').pop()! : '代码')
  } else if (kind) {
    title = meta!.label
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
          {Icon && meta ? (
            /*
             * 功能切换器的位置先占住。下拉在票 04 接上 ——
             * 现在显示的是「当前是哪个功能区」，点不开。
             */
            <button
              type="button"
              className="rp-func"
              aria-haspopup="menu"
              aria-expanded={false}
              disabled
              title="切换功能区（下一单接上）"
            >
              <Icon />
              <span>{meta.label}</span>
              <span className="rp-func-chev">
                <IconChevron />
              </span>
            </button>
          ) : null}
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
        ) : kind ? (
          <PendingPanel kind={kind} />
        ) : (
          <EmptyPanel />
        )}
      </div>
    </aside>
  )
}
