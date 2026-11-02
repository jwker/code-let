import { useEffect } from 'react'

/**
 * 确认框 —— 需要用户点头才继续的那种操作（关掉正在跑的标签、把项目移出清单）。
 *
 * 居中浮层，点外面或按 Esc 都算取消。
 */
export function ConfirmDialog({
  title,
  body,
  warning,
  confirmText,
  cancelText = '取消',
  danger = false,
  busy = false,
  busyText = '处理中…',
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  /** 危险提示（会关标签 / 会中止），按警告色单独一行 */
  warning?: string
  confirmText: string
  cancelText?: string
  /** 危险操作 —— 确认按钮用危险色 */
  danger?: boolean
  /** 请求进行中 —— 两个按钮都禁用，也不许用 Esc / 点遮罩关掉 */
  busy?: boolean
  busyText?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={busy ? undefined : onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-[330px] rounded-xl border border-hairline bg-raised p-4"
        style={{ boxShadow: 'var(--sh-lg)' }}
      >
        <div className="text-[13.5px] font-semibold text-fg-1">{title}</div>
        <div className="mt-2 whitespace-pre-line text-[12.5px] leading-relaxed text-fg-2">{body}</div>
        {warning && (
          <div className="mt-2 text-[12.5px] leading-relaxed text-warn">{warning}</div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-7 rounded-lg border border-hairline-strong px-3 text-[12.5px] text-fg-1 transition-colors hover:bg-sunken disabled:cursor-default disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className={[
              'h-7 rounded-lg px-3 text-[12.5px] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60',
              danger ? 'bg-danger text-white' : 'bg-accent text-accent-fg'
            ].join(' ')}
          >
            {busy ? busyText : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
