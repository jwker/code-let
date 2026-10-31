import type { FileTab } from '@contract/index'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { fileMark } from './fileDisplay'

/**
 * 文件浏览器 —— 文件标签栏 + 文件树 + 内容区。
 *
 * **只吃 props，不读 store**（PLAN.md D20）：以后要挂到独立窗口里，只需要在那边
 * 提供同样的 props，这个组件不用改。
 *
 * 布局自适应：容器宽 ≥ 480 显示「树 | 内容」两栏，窄了就收起树只留内容。
 * 面板宽度是用户的（他可能特意拖窄了），所以这里不强行改宽度。
 */
export function FileBrowser({
  cwd,
  files,
  activeFileId,
  onActivate,
  onClose
}: {
  /** 文件树的根 —— 当前活动会话标签的 cwd */
  cwd: string
  files: FileTab[]
  activeFileId: string | null
  onActivate: (fileId: string) => void
  onClose: (fileId: string) => void
}) {
  const active = files.find((f) => f.id === activeFileId) ?? null

  return (
    <div className="file-browser">
      <div className="file-tabs">
        {files.length === 0 && <span className="file-tabs-empty">没有打开的文件</span>}
        {files.map((file) => (
          <button
            key={file.id}
            type="button"
            title={file.relPath}
            onClick={() => onActivate(file.id)}
            className={['file-tab', file.id === activeFileId ? 'is-active' : ''].join(' ')}
          >
            <span className="file-tab-mark">{fileMark(file.relPath, 'file')}</span>
            <span className="file-tab-name">{file.relPath.split('/').pop()}</span>
            <span
              role="button"
              tabIndex={0}
              aria-label={`关闭 ${file.relPath}`}
              onClick={(event) => {
                event.stopPropagation()
                onClose(file.id)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.stopPropagation()
                event.preventDefault()
                onClose(file.id)
              }}
              className="file-tab-close"
            >
              ×
            </span>
          </button>
        ))}
      </div>

      <div className="file-body">
        {/*
          树的显示由 CSS 容器查询决定：窄了自动隐藏。
          这样不用在 JS 里量宽度、也不会有闪烁。
        */}
        <div className="file-tree-pane">
          {cwd ? <FileTree cwd={cwd} /> : <div className="file-tree-empty">没有打开的会话</div>}
        </div>
        <div className="file-content-pane">
          {active ? (
            <>
              {/* 顶部只放操作，不放文件名 —— 文件标签栏已经显示了 */}
              <div className="file-actions">
                <span className="file-actions-path" title={active.path}>
                  {active.relPath}
                </span>
                <button
                  type="button"
                  title="复制路径"
                  aria-label="复制路径"
                  onClick={() => void navigator.clipboard?.writeText(active.path)}
                  className="file-action"
                >
                  ⧉
                </button>
              </div>
              <div className="file-content">
                <FileViewer file={active} />
              </div>
            </>
          ) : (
            <div className="file-viewer-state">从左边选一个文件</div>
          )}
        </div>
      </div>
    </div>
  )
}
