import type { FileTab } from '@contract/index'
import { FileViewer } from './FileViewer'
import { fileMark } from './fileDisplay'

/**
 * 代码功能区的正文：文件标签栏 + 内容。
 *
 * 树在功能区的左列（`FileTree`），这份组件管右边的标签栏与内容。
 * 仍然是**只吃 props、不读 store**（D20）—— 以后要挂到独立窗口，那边给同样的 props 就行。
 */
export function FilePreview({
  files,
  activeFileId,
  onActivate,
  onClose
}: {
  /** 打开的文件（按打开顺序） */
  files: FileTab[]
  activeFileId: string | null
  onActivate: (fileId: string) => void
  onClose: (fileId: string) => void
}) {
  const active = files.find((file) => file.id === activeFileId) ?? null

  return (
    <div className="file-preview">
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
            {/*
              文件在别处被改过 —— 给一个重新加载的入口。
              不自动刷新：用户可能正在看某一段，自动重读会把滚动位置也带走。
            */}
            {file.stale && (
              <span
                role="button"
                tabIndex={0}
                aria-label={`重新加载 ${file.relPath}`}
                title="这个文件在别处有更新，点一下重新加载"
                onClick={(event) => {
                  event.stopPropagation()
                  onActivate(file.id)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  onActivate(file.id)
                }}
                className="file-tab-stale"
              >
                ↻
              </span>
            )}
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
                event.preventDefault()
                event.stopPropagation()
                onClose(file.id)
              }}
              className="file-tab-close"
            >
              ×
            </span>
          </button>
        ))}
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
          <div className="file-viewer-state">从右侧的文件树里选一个文件</div>
        )}
      </div>
    </div>
  )
}
