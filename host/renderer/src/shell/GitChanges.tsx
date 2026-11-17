import { useEffect } from 'react'
import type { GitDiffScope, GitFile } from '@contract/index'
import { useStore } from '../store'
import { splitPath, statusTone } from './gitFormat'

/**
 * 区域 5 的「改动」tab（PLAN.md D52 / R37）。
 *
 * 只列改了什么，diff 在区域 6 看 —— 这是它和原来右侧面板的 Git 视图的区别：
 * 那边列表和详情挤在一列里，一个 300px 宽的 diff 没法读。
 *
 * **只读**：不做 stage / commit / discard。
 */

const GROUPS: Array<{ key: GitDiffScope; title: string }> = [
  { key: 'staged', title: '已暂存' },
  { key: 'unstaged', title: '未暂存' },
  { key: 'untracked', title: '未跟踪' },
  { key: 'conflicts', title: '冲突' }
]

export function GitChanges({ cwd }: { cwd: string }) {
  const git = useStore((s) => s.git)
  const loadGitStatus = useStore((s) => s.loadGitStatus)
  const selectChange = useStore((s) => s.selectChange)
  const gitRevision = useStore((s) => s.gitRevision)

  // 切目录、或者 agent 跑完（gitRevision 变化）就重读；防抖 350ms 免得狂发 git 命令
  useEffect(() => {
    if (!cwd) return
    const timer = window.setTimeout(() => void loadGitStatus(cwd), gitRevision === 0 ? 0 : 350)
    return () => window.clearTimeout(timer)
  }, [cwd, gitRevision, loadGitStatus])

  // 窗口重新获得焦点时刷新 —— 补上终端或外部编辑器里的改动
  useEffect(() => {
    if (!cwd) return
    function onFocus(): void {
      void loadGitStatus(cwd)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [cwd, loadGitStatus])

  const { status, loading, error, selected } = git

  if (!cwd) {
    return <div className="zone5-empty">先打开一个项目</div>
  }
  if (loading && !status) {
    return <div className="zone5-empty">正在读取 Git 状态…</div>
  }
  if (error && !loading) {
    return (
      <div className="zone5-empty">
        Git 读取失败
        <br />
        {error}
        <br />
        <button type="button" className="zone5-retry" onClick={() => void loadGitStatus(cwd)}>
          重试
        </button>
      </div>
    )
  }
  if (status && !status.repo) {
    return (
      <div className="zone5-empty">
        当前目录不是 Git 仓库。
        <br />
        这里只显示仓库状态，不会初始化仓库。
      </div>
    )
  }
  if (status?.repo && status.clean) {
    return (
      <div className="zone5-empty">
        工作区没有改动
        {status.branch ? (
          <>
            <br />
            {status.branch} · clean
          </>
        ) : null}
      </div>
    )
  }
  if (!status) return null

  return (
    <div className="git-changes">
      <div className="git-branch">
        {status.branch ? (
          <>
            <i className="git-branch-dot" />
            <span className="git-branch-name">{status.branch}</span>
          </>
        ) : (
          <span className="git-branch-name">没有分支</span>
        )}
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="git-sync">
            {status.ahead > 0 ? `↑${status.ahead}` : ''}
            {status.behind > 0 ? ` ↓${status.behind}` : ''}
          </span>
        )}
        <button
          type="button"
          className="git-refresh"
          title="刷新 Git 状态"
          aria-label="刷新 Git 状态"
          onClick={() => void loadGitStatus(cwd)}
        >
          ↻
        </button>
      </div>

      {GROUPS.map(({ key, title }) => {
        const files = status[key]
        if (files.length === 0) return null
        return (
          <section key={key} className="git-group">
            <div className="git-group-head">
              <span>{title}</span>
              <span className="git-group-count">{files.length}</span>
            </div>
            {files.map((file) => (
              <GitRow
                key={`${key}:${file.path}`}
                file={file}
                scope={key}
                active={selected?.path === file.path && selected?.scope === key}
                onOpen={() => void selectChange(file.path, key)}
              />
            ))}
          </section>
        )
      })}

      {status.truncated && <div className="git-note">改动太多，只显示前 2000 项。</div>}
    </div>
  )
}

function GitRow({
  file,
  active,
  onOpen
}: {
  file: GitFile
  scope: GitDiffScope
  active: boolean
  onOpen: () => void
}) {
  const { dir, name } = splitPath(file.path)
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active}
      title={file.oldPath ? `${file.path} ← ${file.oldPath}` : file.path}
      className={['git-row', active ? 'is-active' : ''].join(' ')}
    >
      <span className={`git-row-mark ${statusTone(file.status)}`}>{file.status}</span>
      <span className="git-row-path">
        {dir && <span className="git-row-dir">{dir}</span>}
        {name}
      </span>
      {(file.additions !== undefined || file.deletions !== undefined) && (
        <span className="git-row-stat">
          {file.additions ? <span className="is-add">+{file.additions}</span> : null}
          {file.deletions ? <span className="is-del">−{file.deletions}</span> : null}
        </span>
      )}
    </button>
  )
}
