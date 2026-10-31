import type { FileContent, FileTab } from '@contract/index'
import { Markdown } from '../conversation/Markdown'
import { host } from '../host'
import { useStore } from '../store'
import { formatSize } from './fileDisplay'

/**
 * 文件内容区 —— 按扩展名分派到不同的渲染方式。
 *
 * 切片 1：md（复用对话区的渲染器）、图片、纯文本 + 行号
 * 切片 3：html（沙箱）、预览不了时给「用系统默认程序打开」
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
      return <CannotPreview file={file} reason={content.reason} size={content.size} />

    case 'text':
      return <TextView file={file} content={content} />
  }
}

/**
 * 预览不了时的统一出口 —— 说清为什么，并给一条出路。
 *
 * 「用系统默认程序打开」走 `shell.openPath`，用系统登记的程序打开，
 * 不是执行它；主进程那边同样会校验路径不越界。
 */
function CannotPreview({ file, reason, size }: { file: FileTab; reason?: string; size?: number }) {
  async function openExternal(): Promise<void> {
    try {
      await host.openFileExternal(file.cwd, file.path)
    } catch {
      // 打不开就算了 —— 可能是没有默认程序，不值得弹窗
    }
  }

  return (
    <div className="file-cannot">
      <div className="file-cannot-reason">{reason ?? '这个文件不能预览'}</div>
      {size !== undefined && <div className="file-cannot-size">{formatSize(size)}</div>}
      <button type="button" onClick={() => void openExternal()} className="file-cannot-open">
        用默认程序打开
      </button>
    </div>
  )
}

function TextView({ file, content }: { file: FileTab; content: Extract<FileContent, { kind: 'text' }> }) {
  if (content.tooLarge) {
    return <CannotPreview file={file} reason="文件太大，不预览" size={content.size} />
  }
  if (content.binary) {
    return <CannotPreview file={file} reason="这是个二进制文件" size={content.size} />
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

  // html 在沙箱里跑
  if (ext === 'html' || ext === 'htm') {
    return <HtmlView file={file} html={content.text} />
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

/**
 * HTML 预览 —— 沙箱 iframe（PLAN.md D3 / R26）。
 *
 * `sandbox="allow-scripts"`：脚本能跑，但没有 `allow-same-origin`，
 * 所以 iframe 是**不透明源** —— 拿不到应用的 origin、cookie、localStorage，
 * 也碰不到父页面的 DOM。弹窗（alert/confirm）也被 sandbox 默认挡掉。
 *
 * **限制**：`srcDoc` 的文档地址是 `about:srcdoc`，相对路径解析不了 ——
 * HTML 里 `<img src="./logo.png">` 这种会加载失败。只支持内联的样式和脚本。
 * 要支持相对路径得注册一个能读本地文件的协议，那是另一件事。
 */
function HtmlView({ file, html }: { file: FileTab; html: string }) {
  return (
    <div className="file-html">
      <iframe
        sandbox="allow-scripts"
        srcDoc={html}
        title={file.relPath}
        className="file-html-frame"
      />
      <div className="file-html-note" title="srcDoc 的文档地址是 about:srcdoc，相对路径解析不了">
        沙箱里运行 · 相对路径引用的图片和样式加载不了
      </div>
    </div>
  )
}
