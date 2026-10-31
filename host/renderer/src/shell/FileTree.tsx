import { useEffect, useMemo, useState } from 'react'
import type { FileEntry } from '@contract/index'
import { useStore } from '../store'
import { fileMark } from './fileDisplay'

/**
 * 文件树 —— 懒加载、默认全收起。
 *
 * 展开状态**按 cwd 分开记**（PLAN.md D22）：切回项目 A，A 的树恢复到你上次展开的样子。
 */

export function FileTree({ cwd }: { cwd: string }) {
  const treeEntries = useStore((s) => s.treeEntries)
  const treeExpanded = useStore((s) => s.treeExpanded)
  const toggleDir = useStore((s) => s.toggleDir)
  const loadDir = useStore((s) => s.loadDir)
  const openFile = useStore((s) => s.openFile)
  const activeFileId = useStore((s) => s.snapshot.activeFileId)
  const files = useStore((s) => s.snapshot.files)

  // 第一次进来（或者切到另一个项目的 cwd）把根目录读出来。
  // 只加载、不展开 —— 根目录的条目是「第一层」，展开的是它下面的子目录。
  useEffect(() => {
    void loadDir(cwd, '')
  }, [cwd, loadDir])

  const expanded = treeExpanded[cwd] ?? []

  /*
   * 恢复的展开状态要把对应的目录读出来。
   *
   * 平时展开一个目录时 `toggleDir` 会顺手加载；但**重启后** `treeExpanded`
   * 从 localStorage 里恢复，那些目录没走过 `toggleDir`，内容还是空的 ——
   * 界面上会一直显示「加载中」。这里补上。
   *
   * `loadDir` 自己有缓存判断，已经加载过的不会再读。
   */
  useEffect(() => {
    for (const dir of expanded) {
      if (!treeEntries[`${cwd}\u0001${dir}`]) void loadDir(cwd, dir)
    }
    // expanded 是 store 里的数组引用，展开/收起才会变
  }, [cwd, expanded, treeEntries, loadDir])

  const rootKey = `${cwd}\u0001`
  const [query, setQuery] = useState('')

  /*
   * 搜索只筛**已经加载过**的节点。
   *
   * 不扫盘 —— 全局搜索是另一件事（要读整棵目录树）。这里的定位是
   * 「我刚才看见过那个文件，名字记得一半」，筛已加载的够用。
   */
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    const out: Array<{ dir: string; entry: FileEntry }> = []
    for (const [key, entries] of Object.entries(treeEntries)) {
      const [entryCwd, dir] = key.split('\u0001')
      if (entryCwd !== cwd) continue
      for (const entry of entries) {
        if (entry.name.toLowerCase().includes(q)) out.push({ dir, entry })
      }
    }
    return out
  }, [query, treeEntries, cwd])

  const activePath = files.find((f) => f.id === activeFileId)?.path ?? null

  return (
    <div className="file-tree">
      <div className="file-search">
        <span className="file-search-icon" aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选已加载的文件"
          aria-label="筛选文件"
          className="file-search-input"
        />
        {query !== '' && (
          <button type="button" aria-label="清空筛选" onClick={() => setQuery('')} className="file-search-clear">
            ×
          </button>
        )}
      </div>

      {matches ? (
        <div className="file-search-results">
          {matches.length === 0 && <div className="file-tree-empty">没有匹配的文件</div>}
          {matches.map(({ dir, entry }) => {
            const childPath = dir ? `${dir}/${entry.name}` : entry.name
            const full = `${cwd}/${childPath}`
            return (
              <button
                key={`${dir}\u0001${entry.name}`}
                type="button"
                title={childPath}
                onClick={() => {
                  if (entry.kind === 'file') void openFile(cwd, full)
                  else void toggleDir(cwd, childPath)
                }}
                className={[
                  'file-node',
                  activePath === full ? 'is-active' : '',
                  entry.kind === 'dir' ? 'is-dir' : '',
                  entry.ignored ? 'is-ignored' : ''
                ].join(' ')}
              >
                <span className="file-node-mark">{fileMark(entry.name, entry.kind)}</span>
                <span className="file-node-name">{entry.name}</span>
                {dir !== '' && <span className="file-node-dir">{dir}</span>}
              </button>
            )
          })}
        </div>
      ) : (
        <>
          {!treeEntries[rootKey] && <div className="file-tree-empty">加载中…</div>}
          {treeEntries[rootKey] && (
            <Level
              cwd={cwd}
              dir=""
              depth={0}
              entries={treeEntries[rootKey]}
              expanded={expanded}
              activePath={activePath}
              onToggle={toggleDir}
              onOpen={openFile}
            />
          )}
        </>
      )}
    </div>
  )
}

function Level({
  cwd,
  dir,
  depth,
  entries,
  expanded,
  activePath,
  onToggle,
  onOpen
}: {
  cwd: string
  dir: string
  depth: number
  entries: FileEntry[]
  expanded: string[]
  activePath: string | null
  onToggle: (cwd: string, dir: string) => Promise<void>
  onOpen: (cwd: string, path: string) => Promise<void>
}) {
  return (
    <>
      {entries.map((entry) => {
        const childPath = dir ? `${dir}/${entry.name}` : entry.name
        const isOpen = expanded.includes(childPath)
        const fullPath = `${cwd}/${childPath}`
        const active = entry.kind === 'file' && activePath === fullPath
        return (
          <div key={childPath}>
            <button
              type="button"
              title={childPath}
              onClick={() => {
                if (entry.kind === 'dir') void onToggle(cwd, childPath)
                else void onOpen(cwd, fullPath)
              }}
              className={[
                'file-node',
                active ? 'is-active' : '',
                entry.kind === 'dir' ? 'is-dir' : '',
                // 被 .gitignore 命中 —— 置灰，但仍然显示
                entry.ignored ? 'is-ignored' : ''
              ].join(' ')}
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              <span className="file-node-mark">
                {entry.kind === 'dir' ? (isOpen ? '▾' : '▸') : fileMark(entry.name, entry.kind)}
              </span>
              <span className="file-node-name">{entry.name}</span>
            </button>
            {entry.kind === 'dir' && isOpen && (
              <ChildLevel
                cwd={cwd}
                dir={childPath}
                depth={depth + 1}
                expanded={expanded}
                activePath={activePath}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

/** 展开的目录：从缓存里取条目，没加载过就显示一行「加载中」 */
function ChildLevel({
  cwd,
  dir,
  depth,
  expanded,
  activePath,
  onToggle,
  onOpen
}: {
  cwd: string
  dir: string
  depth: number
  expanded: string[]
  activePath: string | null
  onToggle: (cwd: string, dir: string) => Promise<void>
  onOpen: (cwd: string, path: string) => Promise<void>
}) {
  const entries = useStore((s) => s.treeEntries[`${cwd}\u0001${dir}`])
  if (!entries) {
    return <div className="file-tree-loading" style={{ paddingLeft: 16 + depth * 12 }}>加载中…</div>
  }
  if (entries.length === 0) {
    return <div className="file-tree-loading" style={{ paddingLeft: 16 + depth * 12 }}>（空）</div>
  }
  return (
    <Level
      cwd={cwd}
      dir={dir}
      depth={depth}
      entries={entries}
      expanded={expanded}
      activePath={activePath}
      onToggle={onToggle}
      onOpen={onOpen}
    />
  )
}
