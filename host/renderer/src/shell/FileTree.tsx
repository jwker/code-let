import { useEffect } from 'react'
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
  const rootKey = `${cwd}`

  return (
    <div className="file-tree">
      {!treeEntries[rootKey] && <div className="file-tree-empty">加载中…</div>}
      {treeEntries[rootKey] && (
        <Level cwd={cwd} dir="" depth={0} entries={treeEntries[rootKey]} expanded={expanded}
          activePath={files.find((f) => f.id === activeFileId)?.path ?? null}
          onToggle={toggleDir} onOpen={openFile} />
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
              className={['file-node', active ? 'is-active' : '', entry.kind === 'dir' ? 'is-dir' : ''].join(' ')}
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
