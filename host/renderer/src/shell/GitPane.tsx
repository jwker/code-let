import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitDiff, GitDiffScope, GitFile, GitStatus } from '@contract/index'
import { host } from '../host'
import { useStore } from '../store'

/**
 * 右侧检视器的 Git 视图（只读）。
 *
 * 状态来自当前活动标签的 cwd；列表只带路径和状态，diff 点击文件后才读取。
 * 不做 stage / commit / discard —— 这一版只负责看清楚改了什么。
 */

type SelectedFile = { file: GitFile; scope: GitDiffScope }

const GROUP_TITLES: Array<{ key: keyof Pick<GitStatus, 'staged' | 'unstaged' | 'untracked' | 'conflicts'>; title: string }> = [
  { key: 'staged', title: '已暂存' },
  { key: 'unstaged', title: '未暂存' },
  { key: 'untracked', title: '未跟踪' },
  { key: 'conflicts', title: '冲突' }
]

function statusTone(status: string): string {
  if (status === 'A' || status === '?') return 'text-ok bg-ok-wash'
  if (status === 'D' || status === 'U') return 'text-danger bg-danger-wash'
  if (status === 'R' || status === 'C') return 'text-info bg-info-wash'
  return 'text-warn bg-warn-wash'
}

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/')
  return index < 0 ? { dir: '', name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

function scopeLabel(scope: GitDiffScope): string {
  if (scope === 'staged') return '相对 HEAD'
  if (scope === 'unstaged') return '相对 index'
  if (scope === 'conflicts') return '冲突'
  return '新文件'
}

export function GitPane() {
  const activeTabId = useStore((s) => s.snapshot.activeTabId)
  const gitRevision = useStore((s) => s.gitRevision)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<SelectedFile | null>(null)
  const [diff, setDiff] = useState<GitDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  const diffSeq = useRef(0)

  const loadStatus = useCallback(async (tabId: string): Promise<void> => {
    const seq = ++requestSeq.current
    setLoading(true)
    setError(null)
    try {
      const next = await host.getGitStatus(tabId)
      if (seq !== requestSeq.current) return
      setStatus(next)
      setError(next.error)
      setSelected((previous) => {
        if (!previous) return null
        const still = next[previous.scope].some((file) => file.path === previous.file.path)
        return still ? previous : null
      })
      setDiff((previous) => (previous ? previous : null))
    } catch (caught) {
      if (seq === requestSeq.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  // 切换标签就重新读；agent 结束后 gitRevision 变化，防抖后再读一次。
  useEffect(() => {
    if (!activeTabId) {
      setStatus(null)
      setError(null)
      setLoading(false)
      setSelected(null)
      setDiff(null)
      return
    }
    const timer = window.setTimeout(() => void loadStatus(activeTabId), gitRevision === 0 ? 0 : 350)
    return () => window.clearTimeout(timer)
  }, [activeTabId, gitRevision, loadStatus])

  // 窗口重新获得焦点时刷新，补上终端或外部编辑器里的改动。
  useEffect(() => {
    function onFocus(): void {
      if (activeTabId) void loadStatus(activeTabId)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [activeTabId, loadStatus])

  async function openDiff(file: GitFile, scope: GitDiffScope): Promise<void> {
    if (!activeTabId) return
    const seq = ++diffSeq.current
    setSelected({ file, scope })
    setDiff(null)
    setDiffError(null)
    setDiffLoading(true)
    try {
      const next = await host.getGitDiff(activeTabId, file.path, scope)
      if (seq !== diffSeq.current) return
      setDiff(next)
      setDiffError(next.error)
    } catch (caught) {
      if (seq === diffSeq.current) {
        setDiffError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (seq === diffSeq.current) setDiffLoading(false)
    }
  }

  function closeDiff(): void {
    diffSeq.current += 1
    setSelected(null)
    setDiff(null)
    setDiffError(null)
    setDiffLoading(false)
  }

  useEffect(() => {
    if (!selected) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeDiff()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selected])

  if (!activeTabId) {
    return (
      <div className="insp-body">
        <div className="px-2 py-10 text-center text-[11.5px] leading-7 text-fg-3">
          <div className="mb-2 text-[18px] text-fg-2">⑂</div>
          打开一个对话后才能查看 Git 状态。
        </div>
      </div>
    )
  }

  if (selected) {
    return (
      <div className="insp-body">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <header className="flex h-10 flex-none items-center gap-1.5 border-b border-hairline px-2">
            <button
              type="button"
              onClick={closeDiff}
              className="grid h-6 w-6 place-items-center rounded text-[15px] text-fg-3 hover:bg-sunken hover:text-fg-1"
              aria-label="返回 Git 列表"
            >
              ←
            </button>
            <span className={`grid h-4 w-4 flex-none place-items-center rounded font-mono text-[8px] ${statusTone(selected.file.status)}`}>
              {selected.file.status}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-fg-1">{selected.file.path}</span>
            <button
              type="button"
              onClick={() => void loadStatus(activeTabId)}
              className="grid h-6 w-6 place-items-center rounded text-[13px] text-fg-3 hover:bg-sunken hover:text-fg-1"
              aria-label="刷新 Git 状态"
            >
              ↻
            </button>
          </header>
          <div className="flex flex-none items-center gap-1.5 border-b border-hairline px-2.5 py-1.5 text-[8.5px] text-fg-3">
            <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[7.5px] text-fg-2">{scopeLabel(selected.scope)}</span>
            {selected.file.oldPath && <span className="truncate">← {selected.file.oldPath}</span>}
            {diff && !diff.binary && !diff.error && (
              <span className="ml-auto font-mono">
                {diff.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length > 0 && (
                  <span className="text-ok">+{diff.patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length}</span>
                )}
                {diff.patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length > 0 && (
                  <span className="ml-1 text-danger">-{diff.patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length}</span>
                )}
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-panel">
            {diffLoading && <div className="p-4 text-[10px] text-fg-3">正在读取 diff…</div>}
            {diffError && <div className="p-4 text-[10px] text-danger">{diffError}</div>}
            {diff && !diffLoading && <DiffPatch diff={diff} />}
          </div>
          <div className="flex flex-none items-center gap-2 border-t border-hairline px-3 py-1.5 text-[8.5px] text-fg-3">
            <span>只读</span>
            <span className="ml-auto">Esc 返回</span>
          </div>
        </section>
      </div>
    )
  }

  return (
    <div className="insp-body">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
          <h2 className="text-[13px] font-medium text-fg-1">Git</h2>
          <span className="rounded border border-hairline px-1.5 text-[8px] text-fg-3">status</span>
          {status?.branch && (
            <span className="flex h-[19px] max-w-[110px] items-center gap-1 overflow-hidden truncate rounded-full bg-sunken px-1.5 font-mono text-[8.5px] text-fg-2">
              <i className="h-1 w-1 flex-none rounded-full bg-ok" />
              {status.branch}
            </span>
          )}
          {status && (status.ahead > 0 || status.behind > 0) && (
            <span className="font-mono text-[8px] text-fg-3">
              {status.ahead > 0 ? `↑${status.ahead}` : ''}{status.behind > 0 ? ` ↓${status.behind}` : ''}
            </span>
          )}
          <button
            type="button"
            onClick={() => void loadStatus(activeTabId)}
            className="ml-auto grid h-6 w-6 place-items-center rounded text-[13px] text-fg-3 hover:bg-sunken hover:text-fg-1"
            aria-label="刷新 Git 状态"
          >
            ↻
          </button>
        </header>

        {status?.root && (
          <div className="flex h-6 flex-none items-center gap-1.5 border-b border-hairline px-3 text-[8px] text-fg-3">
            <span className="truncate font-mono text-fg-2">{status.root.split('/').pop()}</span>
            {status.upstream && <><span>·</span><span className="truncate">{status.upstream}</span></>}
            <span className="ml-auto font-mono text-warn">
              {status.clean ? 'clean' : `${status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length} changed`}
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading && !status && <div className="px-2 py-10 text-center text-[10px] text-fg-3">正在读取 Git 状态…</div>}
          {error && !loading && (
            <div className="px-2 py-10 text-center text-[10px] leading-6 text-fg-3">
              <div className="mb-2 text-[18px] text-fg-2">⑂</div>
              <b className="block text-[11px] text-fg-2">Git 读取失败</b>
              {error}
              <button type="button" onClick={() => void loadStatus(activeTabId)} className="mt-3 rounded border border-hairline-strong px-2 py-1 text-[9px] text-fg-2 hover:bg-sunken">
                重试
              </button>
            </div>
          )}
          {!loading && !error && status && !status.repo && (
            <div className="px-2 py-10 text-center text-[10px] leading-6 text-fg-3">
              <div className="mb-2 text-[18px] text-fg-2">⑂</div>
              <b className="block text-[11px] text-fg-2">当前目录不是 Git 仓库</b>
              这里只显示仓库状态，不会初始化仓库。
            </div>
          )}
          {!loading && !error && status?.repo && status.clean && (
            <div className="px-2 py-10 text-center text-[10px] leading-6 text-fg-3">
              <div className="mb-2 text-[18px] text-ok">✓</div>
              <b className="block text-[11px] text-fg-2">工作区没有改动</b>
              {status.branch && <span className="font-mono">{status.branch} · clean</span>}
            </div>
          )}
          {!loading && !error && status?.repo && !status.clean && (
            <div className="flex flex-col gap-1.5">
              {GROUP_TITLES.map(({ key, title }) => {
                const files = status[key]
                return (
                  <section key={key} className="overflow-hidden rounded-lg border border-hairline bg-raised">
                    <div className="flex h-6 items-center gap-1.5 bg-panel px-2 text-[8.5px] text-fg-3">
                      <span>{files.length > 0 ? '▾' : '▸'}</span>
                      <b className="font-medium text-fg-2">{title}</b>
                      <span className="ml-auto font-mono">{files.length}</span>
                    </div>
                    {files.map((file) => (
                      <GitRow key={`${file.path}:${file.status}`} file={file} scope={key} onOpen={openDiff} />
                    ))}
                  </section>
                )
              })}
              {status.truncated && <div className="px-2 py-1 text-[8.5px] text-warn">改动太多，只显示前 2000 项。</div>}
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-2 border-t border-hairline px-3 py-1.5 text-[8.5px] text-fg-3">
          <span>只读</span>
          <span>·</span>
          <span>点击文件看 diff</span>

        </div>
      </section>
    </div>
  )
}

function GitRow({ file, scope, onOpen }: { file: GitFile; scope: GitDiffScope; onOpen: (file: GitFile, scope: GitDiffScope) => void }) {
  const { dir, name } = splitPath(file.path)
  return (
    <button
      type="button"
      onClick={() => void onOpen(file, scope)}
      className="flex min-h-[26px] w-full items-center gap-1.5 border-t border-hairline px-2 py-1 text-left text-fg-2 hover:bg-sunken"
    >
      <span className={`grid h-3.5 w-3.5 flex-none place-items-center rounded font-mono text-[7.5px] font-semibold ${statusTone(file.status)}`}>
        {file.status}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[8.5px]">
        {dir && <span className="text-fg-3">{dir}</span>}
        <span className="text-fg-2">{name}</span>
      </span>
      {(file.additions !== undefined || file.deletions !== undefined) && (
        <span className="flex-none font-mono text-[7.5px]">
          {file.additions ? <span className="text-ok">+{file.additions}</span> : null}
          {file.additions && file.deletions ? ' ' : null}
          {file.deletions ? <span className="text-danger">−{file.deletions}</span> : null}
        </span>
      )}
      {file.oldPath && <span className="max-w-[80px] flex-none truncate text-[7.5px] text-fg-3">← {file.oldPath}</span>}
    </button>
  )
}

function DiffPatch({ diff }: { diff: GitDiff }) {
  if (diff.error) return <div className="p-4 text-[10px] text-danger">{diff.error}</div>
  if (diff.binary) {
    return (
      <div className="m-3 rounded-lg border border-dashed border-hairline-strong p-4 text-center text-[9px] leading-7 text-fg-3">
        <b className="block text-[10px] text-fg-2">二进制文件</b>
        这里不渲染二进制内容。
      </div>
    )
  }
  const lines = diff.patch.split('\n')
  return (
    <div className="min-w-max font-mono text-[8px] leading-[1.75]">
      {lines.map((line, index) => {
        const isHunk = line.startsWith('@@')
        const isHeader = line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')
        const isAdd = line.startsWith('+') && !line.startsWith('+++')
        const isDel = line.startsWith('-') && !line.startsWith('---')
        return (
          <div
            key={index}
            className={`flex whitespace-pre ${isAdd ? 'bg-ok-wash' : isDel ? 'bg-danger-wash' : isHunk ? 'bg-info-wash' : isHeader ? 'bg-surface text-fg-3' : 'text-fg-2'}`}
          >
            <span className="w-7 flex-none select-none pr-1 text-right text-fg-3/60">{index + 1}</span>
            <span className={`w-3 flex-none text-center ${isAdd ? 'text-ok' : isDel ? 'text-danger' : isHunk ? 'text-info' : 'text-fg-3'}`}>
              {isAdd ? '+' : isDel ? '−' : isHunk ? '@' : ''}
            </span>
            <span className="pr-3">{line}</span>
          </div>
        )
      })}
      {diff.truncated && (
        <div className="border-t border-hairline bg-surface px-3 py-2 text-[8.5px] text-warn">diff 太大，只显示前 512KB。</div>
      )}
    </div>
  )
}
