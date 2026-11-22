import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { SessionTree } from '@contract/index'
import { host } from '../host'
import { useStore } from '../store'
import { PromptDialog } from '../shell/PromptDialog'
import { useLeftColumnOverlay } from '../shell/useOverlay'
import { treeToRows, type TreeRow } from './treeRows'
import { gutterWidth, laneX, layoutTree, ROW_HEIGHT, type TreeRowLayout } from './treeLayout'

/**
 * 会话树弹窗（GLOSSARY.md「对话结构」）。
 *
 * 一行一轮：提问是正文，回答压成一行小字。左边一条主干拉到当前叶，
 * 别的支线从分叉点拐进右边的窄缝，各占一条竖线、各用一种颜色。
 * 正文全部对齐，不随支线缩进；选中只给正文区上背景。
 *
 * 操作不靠悬停：点一行选中，底部操作栏常驻。
 */

/** 支线颜色的个数 —— 超过就循环，靠「支线 N」区分 */
const BRANCH_PALETTE = 4

function branchColor(branch: number): string {
  return `var(--branch-${((branch - 1) % BRANCH_PALETTE) + 1})`
}

function branchWash(branch: number): string {
  return `var(--branch-${((branch - 1) % BRANCH_PALETTE) + 1}-wash)`
}

/** 主进程抛回来的错误带着 IPC 包装，只留人能看的那句 */
function reasonOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

function clockOf(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function ConversationTree({
  agentId,
  cwd,
  tree,
  streaming,
  onClose,
  onTreeChanged,
  onComposerText
}: {
  agentId: string
  cwd: string
  tree: SessionTree
  streaming: boolean
  onClose: () => void
  /** 树变了：让外面重新拉一份 */
  onTreeChanged: () => void
  /** 「回到这一轮」把提问原文放回输入框 */
  onComposerText: (text: string) => void
}) {
  useLeftColumnOverlay()
  const setItems = useStore((s) => s.setItems)
  const layout = useMemo(() => layoutTree(tree, treeToRows(tree)), [tree])
  const rows = layout.rows

  const leafRow = rows.find((row) => row.isLeaf)
  const [selectedKey, setSelectedKey] = useState<string | null>(leafRow?.row.key ?? null)
  const [summarize, setSummarize] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [labelRow, setLabelRow] = useState<TreeRow | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  // 树刷新之后选中的那一行可能已经不在了（切完支线、截断）
  const selected = rows.find((row) => row.row.key === selectedKey) ?? leafRow ?? rows[rows.length - 1]

  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!selected) return
    rowRefs.current.get(selected.row.key)?.scrollIntoView({ block: 'nearest' })
  }, [selected?.row.key])

  const refresh = useCallback(async () => {
    setItems(agentId, await host.getAgentEntries(agentId))
    onTreeChanged()
  }, [agentId, onTreeChanged, setItems])

  async function run(task: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      await task()
    } catch (error) {
      setNotice(reasonOf(error))
    } finally {
      setBusy(false)
    }
  }

  /** 主按钮：切到这轮所在的支线，或者把上下文截断到这一轮 */
  function go(): void {
    if (!selected) return
    void run(async () => {
      const result = await host.navigateTree(agentId, selected.row.leafTargetId, { summarize })
      if (result.cancelled) {
        setNotice('这一次没有切过去')
        return
      }
      await refresh()
      onClose()
    })
  }

  /** 回到这一轮：叶落到这一轮的提问之前，原文回输入框 —— 改完再发就是新支线 */
  function back(): void {
    if (!selected) return
    void run(async () => {
      const result = await host.navigateTree(agentId, selected.row.userId)
      if (result.cancelled) {
        setNotice('这一次没有退回去')
        return
      }
      if (result.editorText !== undefined) onComposerText(result.editorText)
      await refresh()
      onClose()
    })
  }

  /** 另开一个会话：复制成新会话文件，在窄轨里多一个头像 */
  function fork(): void {
    if (!selected) return
    void run(async () => {
      const path = await host.forkTree(agentId, selected.row.leafTargetId)
      await host.openConversation(path, cwd)
      onClose()
    })
  }

  function move(delta: number): void {
    if (rows.length === 0) return
    const current = selected ? rows.indexOf(selected) : 0
    const next = Math.max(0, Math.min(rows.length - 1, current + delta))
    setSelectedKey(rows[next].row.key)
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (labelRow) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      go()
    }
  }

  const spineEnd = rows.reduce((last, row) => (row.onPath ? row.index : last), -1)
  const branches = useMemo(() => groupBranches(rows), [rows])
  const gutter = gutterWidth(layout.laneCount)

  return (
    <>
      {/* 遮罩只压左列；面板挂在入口按钮下方，跟着按钮走 */}
      <div className="conv-tree-backdrop left-scope" onClick={onClose} />
      <div className="conv-tree-pop">
        {notice && (
          <div className="conv-tree-notice" role="alert">
            {notice}
          </div>
        )}
        <div
          ref={panelRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="对话结构"
          className="conv-tree-panel"
          onKeyDown={onKeyDown}
        >
        <div className="conv-tree-head">
          <div className="conv-tree-title">对话结构</div>
          <div className="conv-tree-sub">
            {rows.length} 轮 · {layout.otherBranches} 条别的支线
          </div>
          <div className="conv-tree-legend" aria-hidden="true">
            <span className="conv-tree-legend-dot is-main" />
            当前支线
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={summarize}
            className={`conv-tree-switch${summarize ? ' is-on' : ''}`}
            onClick={() => setSummarize((value) => !value)}
            title="切支线前先让模型给离开的那条支线一句总结"
          >
            <span className="conv-tree-switch-knob" />
            总结被放弃的支线
          </button>
          <button type="button" className="conv-tree-close" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="conv-tree-body">
          {rows.length === 0 ? (
            <div className="conv-tree-empty">这个对话还没有说过话</div>
          ) : (
            <div className="conv-tree" style={{ width: '100%' }}>
              <svg
                className="conv-tree-lines"
                width={gutter}
                height={rows.length * ROW_HEIGHT}
                aria-hidden="true"
              >
                {spineEnd >= 0 && (
                  <line
                    x1={laneX(0)}
                    y1={ROW_HEIGHT / 2}
                    x2={laneX(0)}
                    y2={spineEnd * ROW_HEIGHT + ROW_HEIGHT / 2}
                    stroke="var(--graph-line)"
                    strokeWidth={1.6}
                    strokeLinecap="round"
                  />
                )}
                {branches.map((branch) => (
                  <path
                    key={branch.number}
                    d={branchPath(branch)}
                    fill="none"
                    stroke={branchColor(branch.number)}
                    strokeWidth={1.6}
                    strokeLinecap="round"
                  />
                ))}
              </svg>

              {rows.map((entry) => (
                <TreeLine
                  key={entry.row.key}
                  entry={entry}
                  gutter={gutter}
                  selected={selected?.row.key === entry.row.key}
                  streaming={streaming}
                  onSelect={() => setSelectedKey(entry.row.key)}
                  register={(node) => {
                    if (node) rowRefs.current.set(entry.row.key, node)
                    else rowRefs.current.delete(entry.row.key)
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <div className="conv-tree-foot">
          <button type="button" className="conv-tree-btn" disabled={!selected || busy} onClick={back}>
            回到这一轮
          </button>
          <button type="button" className="conv-tree-btn" disabled={!selected || busy} onClick={fork}>
            另开一个会话
          </button>
          <button
            type="button"
            className="conv-tree-btn"
            disabled={!selected || busy}
            onClick={() => selected && setLabelRow(selected.row)}
          >
            {selected?.row.label ? '改标签' : '加标签'}
          </button>
          <button
            type="button"
            className="conv-tree-btn is-primary"
            disabled={!selected || busy}
            onClick={go}
          >
            {selected?.onPath ? '从这里继续' : '切到这里'}
          </button>
        </div>
      </div>

      {labelRow && (
        <PromptDialog
          title={labelRow.label ? '改标签' : '加标签'}
          subtitle="标签是这条会话里的书签：写在会话文件里，下次回来还在。留空等于清掉。"
          label="标签"
          initialValue={labelRow.label ?? ''}
          maxLength={80}
          confirmText="保存"
          busy={busy}
          onCancel={() => setLabelRow(null)}
          onConfirm={(value) => {
            const row = labelRow
            setLabelRow(null)
            void run(async () => {
              await host.labelTree(agentId, row.userId, value)
              onTreeChanged()
            })
          }}
        />
      )}
      </div>
    </>
  )
}

/** 一条支线的线：从分叉点拐到窄缝里，再一路画到它自己的末尾 */
function groupBranches(rows: readonly TreeRowLayout[]): Array<{
  number: number
  from: number
  fromLane: number
  lane: number
  end: number
}> {
  const grouped = new Map<number, { number: number; from: number; fromLane: number; lane: number; end: number }>()
  for (const row of rows) {
    if (row.onPath || row.branch <= 0) continue
    const existing = grouped.get(row.branch)
    if (existing) {
      existing.end = row.index
      continue
    }
    const parent = row.forkFrom === null ? null : rows[row.forkFrom]
    grouped.set(row.branch, {
      number: row.branch,
      from: row.forkFrom ?? row.index,
      fromLane: parent ? parent.lane : 0,
      lane: row.lane,
      end: row.index
    })
  }
  return [...grouped.values()]
}

/**
 * 支线的线：从分叉点那一刻就拐弯，再一路竖直画到自己的末尾。
 *
 * 不能先沿主干往下走一段 —— 那一段会盖在主干上，看起来像主干变了色。
 */
function branchPath(branch: { from: number; fromLane: number; lane: number; end: number }): string {
  const x0 = laneX(branch.fromLane)
  const x1 = laneX(branch.lane)
  const y0 = branch.from * ROW_HEIGHT + ROW_HEIGHT / 2
  const y1 = branch.end * ROW_HEIGHT + ROW_HEIGHT / 2
  const knee = y0 + 24
  return `M ${x0} ${y0} C ${x0} ${y0 + 16} ${x1} ${y0 + 8} ${x1} ${knee} L ${x1} ${y1}`
}

/** 一行：图形区的点 + 正文 + 右侧元信息 */
function TreeLine({
  entry,
  gutter,
  selected,
  streaming,
  onSelect,
  register
}: {
  entry: TreeRowLayout
  gutter: number
  selected: boolean
  streaming: boolean
  onSelect: () => void
  register: (node: HTMLButtonElement | null) => void
}) {
  const { row, onPath, branch, isLeaf, lane } = entry
  const live = isLeaf && onPath && streaming
  const answer = live ? '正在生成…' : row.answer || '还没有回答'

  return (
    <button
      ref={register}
      type="button"
      className={`conv-tree-row${selected ? ' is-selected' : ''}`}
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
    >
      <span className="conv-tree-glyph" style={{ width: `${gutter}px` }}>
        <span
          className={`conv-tree-dot${isLeaf ? ' is-leaf' : ''}`}
          style={
            {
              left: `${laneX(lane)}px`,
              '--dot-ring': onPath ? 'var(--accent)' : branchColor(branch),
              ...(onPath ? {} : { background: branchColor(branch), width: 7, height: 7 })
            } as CSSProperties
          }
        />
      </span>
      <span className="conv-tree-content">
        <span className="conv-tree-ask" style={onPath ? undefined : { color: 'var(--fg-2)' }}>
          {row.text || '（空消息）'}
        </span>
        <span className={`conv-tree-answer${live ? ' is-live' : ''}`}>{answer}</span>
      </span>
      <span className="conv-tree-meta">
        {entry.forkLabel && (
          <span
            className="conv-tree-tag is-branch"
            style={{ color: branchColor(branch), borderColor: branchColor(branch), background: branchWash(branch) }}
          >
            {entry.forkLabel}
          </span>
        )}
        {row.label && <span className="conv-tree-tag is-label">⚑ {row.label}</span>}
        {isLeaf && <span className="conv-tree-tag is-leaf">当前</span>}
        <span className="conv-tree-time">{clockOf(row.timestamp)}</span>
      </span>
    </button>
  )
}
