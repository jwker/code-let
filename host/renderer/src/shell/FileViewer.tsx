import type { FileContent, FileTab } from '@contract/index'
import { Markdown } from '../conversation/Markdown'
import { useStore } from '../store'
import { formatSize } from './fileDisplay'

/**
 * 文件内容区 —— 按扩展名分派到不同的渲染方式。
 *
 * 切片 1 只有：md（复用对话区的渲染器）、图片、纯文本 + 行号。
 * html 沙箱和代码高亮在切片 3 / 4。
 */
export function FileViewer({ file }: { file: FileTab }) {
  const content = useStore((s) => s.fileContents[file.path])

  if (!content) {
    return <div className="file-viewer-state">加载中…</div>
  }

  switch (content.kind) {
    case 'image':
      return (
        <div className="file-image">
          <img src={content.dataUrl} alt={file.relPath} />
          <div className="file-image-meta">{formatSize(content.size)}</div>
        </div>
      )

    case 'unsupported':
      return <div className="file-viewer-state">{content.reason}</div>

    case 'text':
      return <TextView file={file} content={content} />
  }
}

function TextView({ file, content }: { file: FileTab; content: Extract<FileContent, { kind: 'text' }> }) {
  if (content.tooLarge) {
    return (
      <div className="file-viewer-state">
        文件太大（{formatSize(content.size)}），不预览
      </div>
    )
  }
  if (content.binary) {
    return <div className="file-viewer-state">这是个二进制文件，不预览</div>
  }

  const ext = (file.relPath.split('.').pop() ?? '').toLowerCase()

  // markdown 渲染成格式，不显示源码
  if (ext === 'md' || ext === 'markdown') {
    return (
      <div className="file-markdown">
        <Markdown text={content.text} variant="normal" />
      </div>
    )
  }

  // 其余：等宽 + 行号
  const lines = content.text.split('\n')
  // 末尾换行会多出一个空行，去掉
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return (
    <div className="file-code">
      <div className="file-code-gutter" aria-hidden="true">
        {lines.map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="file-code-lines">
        {lines.map((line, i) => (
          <div key={i}>{line === '' ? '\u00a0' : line}</div>
        ))}
      </div>
    </div>
  )
}
