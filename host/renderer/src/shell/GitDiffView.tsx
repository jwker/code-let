import type { GitDiff, GitDiffScope } from '@contract/index'
import { useStore } from '../store'
import { countPatchLines, scopeLabel, statusTone } from './gitFormat'

/**
 * 区域 6 的 diff（PLAN.md D52 / R37）。
 *
 * 列表在区域 5，这里只负责把选中的那一份 patch 画出来 —— 所以它有整列宽度可读，
 * 不像原来挤在 300px 的右栏里。
 */

/** 从 Git 状态里找出这个改动对应的 status 字母 —— 头部的小方块要用 */
function statusOf(
  status: ReturnType<typeof useStore.getState>['git']['status'],
  path: string,
  scope: GitDiffScope
): string {
  const file = status?.[scope]?.find((item) => item.path === path)
  return file?.status ?? 'M'
}

export function GitDiffView() {
  const git = useStore((s) => s.git)
  const closeChange = useStore((s) => s.closeChange)
  const selected = git.selected

  if (!selected) return null
  const mark = statusOf(git.status, selected.path, selected.scope)
  const counts = git.diff && !git.diff.error ? countPatchLines(git.diff.patch) : null

  return (
    <div className="git-diff">
      <div className="git-diff-head">
        <button
          type="button"
          className="git-diff-back"
          title="回到文件预览（Esc）"
          aria-label="回到文件预览"
          onClick={closeChange}
        >
          ←
        </button>
        <span className={`git-row-mark ${statusTone(mark)}`}>{mark}</span>
        <span className="git-diff-path" title={selected.path}>
          {selected.path}
        </span>
        <span className="git-diff-scope">{scopeLabel(selected.scope)}</span>
        {counts && (
          <span className="git-diff-stat">
            {counts.added > 0 && <span className="is-add">+{counts.added}</span>}
            {counts.removed > 0 && <span className="is-del">−{counts.removed}</span>}
          </span>
        )}
      </div>

      <div className="git-diff-body">
        {git.diffLoading && <div className="zone6-empty">正在读取 diff…</div>}
        {!git.diffLoading && git.diffError && <div className="zone6-empty">{git.diffError}</div>}
        {!git.diffLoading && git.diff && <Patch diff={git.diff} />}
      </div>
    </div>
  )
}

function Patch({ diff }: { diff: GitDiff }) {
  if (diff.error) return <div className="zone6-empty">{diff.error}</div>
  if (diff.binary) {
    return (
      <div className="zone6-empty">
        二进制文件。这里不渲染内容 —— 要看得用外部工具打开。
      </div>
    )
  }
  return (
    <div className="git-patch">
      {diff.patch.split('\n').map((line, index) => {
        const isHunk = line.startsWith('@@')
        const isHeader = line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')
        const isAdd = line.startsWith('+') && !line.startsWith('+++')
        const isDel = line.startsWith('-') && !line.startsWith('---')
        const tone = isAdd
          ? 'is-add'
          : isDel
            ? 'is-del'
            : isHunk
              ? 'is-hunk'
              : isHeader
                ? 'is-header'
                : ''
        return (
          <div key={index} className={`git-patch-line ${tone}`}>
            <span className="git-patch-no">{index + 1}</span>
            <span className="git-patch-sign">{isAdd ? '+' : isDel ? '−' : isHunk ? '@' : ''}</span>
            <span className="git-patch-text">{line}</span>
          </div>
        )
      })}
      {diff.truncated && <div className="git-note">diff 太大，只显示前 512KB。</div>}
    </div>
  )
}
