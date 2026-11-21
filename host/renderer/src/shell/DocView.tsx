import { Markdown } from '../conversation/Markdown'
import { useStore } from '../store'
import { host } from '../host'

/**
 * 区域 6 的文档预览（PLAN.md D52 / R38）。
 *
 * `.md` 走现有的 Markdown 渲染；其它格式（设计稿的 `.html` 等）不在文档区渲染 ——
 * 说清楚并给一个「用文件预览打开」的出口，比在这里塞半个 HTML 渲染器好。
 *
 * **只读。**
 */

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md')
}

export function DocView({ cwd }: { cwd: string }) {
  const docs = useStore((s) => s.docs)
  const loadDocs = useStore((s) => s.loadDocs)
  const selected = docs.selected

  if (!selected) {
    return <div className="zone6-empty">从文档树里选一份文档</div>
  }

  const { entry } = selected

  return (
    <div className="doc-view">
      <div className="doc-view-head">
        <span className="doc-view-path" title={entry.relPath}>
          {entry.relPath}
        </span>
        <span className="doc-view-tag">只读</span>
        <button
          type="button"
          className="doc-view-action"
          title="用文件预览打开（html 等格式）"
          onClick={() => void host.openFile(cwd, entry.relPath)}
        >
          用文件预览打开
        </button>
        <button
          type="button"
          className="doc-view-action"
          title="重读这一篇"
          aria-label="重读这一篇"
          onClick={() => {
            void loadDocs(cwd)
            void useStore.getState().openDoc(entry.path)
          }}
        >
          ↻
        </button>
      </div>

      <div className="doc-view-body">
        {docs.contentLoading && <div className="zone6-empty">正在读取…</div>}

        {!docs.contentLoading && docs.contentError && (
          <div className="zone6-empty">
            {docs.contentError}
            <br />
            <button
              type="button"
              className="zone5-retry"
              onClick={() => void host.openFile(cwd, entry.relPath)}
            >
              用文件预览打开
            </button>
          </div>
        )}

        {!docs.contentLoading && !docs.contentError && docs.content !== null && (
          isMarkdown(entry.name) ? (
            <div className="doc-view-md">
              <Markdown text={docs.content} variant="normal" />
            </div>
          ) : (
            <pre className="doc-view-raw">{docs.content}</pre>
          )
        )}
      </div>
    </div>
  )
}
