import { useEffect } from 'react'
import type { DocEntry } from '@contract/index'
import { useStore } from '../store'

/**
 * 区域 5 的文档区（PLAN.md D52 / R38）。
 *
 * 组不写死：宿主扫 `.ai/` 下的每个目录当一组，外加项目根的 `AGENTS.md`。
 * 这样以后新开一个 `.ai/artifacts` 不用改代码就会出现在这里。
 *
 * **只读** —— 写文档走对话，这里不提供编辑。
 */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 文件类型标：md / html / 其它 */
function kindOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? 'file' : name.slice(index + 1).toLowerCase()
}

export function DocsList({ cwd }: { cwd: string }) {
  const docs = useStore((s) => s.docs)
  const loadDocs = useStore((s) => s.loadDocs)
  const openDoc = useStore((s) => s.openDoc)

  useEffect(() => {
    if (!cwd) return
    void loadDocs(cwd)
  }, [cwd, loadDocs])

  if (!cwd) return <div className="zone5-empty">先打开一个项目</div>
  if (docs.loading && docs.groups.length === 0) return <div className="zone5-empty">正在读文档清单…</div>
  if (docs.error) {
    return (
      <div className="zone5-empty">
        读不到文档清单
        <br />
        {docs.error}
        <br />
        <button type="button" className="zone5-retry" onClick={() => void loadDocs(cwd)}>
          重试
        </button>
      </div>
    )
  }
  if (docs.groups.length === 0) {
    return (
      <div className="zone5-empty">
        这个项目还没有 AI 文档。
        <br />
        建一个 `AGENTS.md`，或者把计划和设计放进 `.ai/`，它们会出现在这里。
      </div>
    )
  }

  return (
    <div className="docs-list">
      {docs.groups.map((group) => (
        <section key={group.title} className="docs-group">
          <div className="docs-group-head">
            <span>{group.title}</span>
            <span className="docs-group-count">{group.entries.length}</span>
          </div>
          {group.entries.map((entry) => (
            <DocRow
              key={entry.path}
              entry={entry}
              active={docs.selected?.path === entry.path}
              onOpen={() => void openDoc(entry.path)}
            />
          ))}
        </section>
      ))}
      {docs.truncated && <div className="git-note">有的组条目太多，只显示了一部分。</div>}
    </div>
  )
}

function DocRow({ entry, active, onOpen }: { entry: DocEntry; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active}
      title={entry.relPath}
      className={['docs-row', active ? 'is-active' : ''].join(' ')}
    >
      <span className="docs-row-kind">{kindOf(entry.name)}</span>
      <span className="docs-row-name">{entry.name}</span>
      <span className="docs-row-size">{formatSize(entry.size)}</span>
    </button>
  )
}
