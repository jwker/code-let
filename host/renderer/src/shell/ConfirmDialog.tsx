import { useEffect } from 'react'

/**
 * 确认框 —— 需要用户点头才继续的那种操作（关掉正在跑的标签、把项目移出清单）。
 *
 * 居中浮层，点外面或按 Esc 都算取消。
 */
export function ConfirmDialog({
  title,
  body,
  confirmText,
  cancelText = '取消',
  danger = false,
  onCancel,
  onConfirm
}: {
  title: string
  body: string
  confirmText: string
  cancelText?: string
  /** 危险操作 —— 确认按钮用危险色 */
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-[330px] rounded-xl border border-hairline bg-raised p-4"
        style={{ boxShadow: 'var(--sh-lg)' }}
      >
        <div className="text-[13.5px] font-semibold text-fg-1">{title}</div>
        <div className="mt-2 text-[12.5px] leading-relaxed text-fg-2">{body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-7 rounded-lg border border-hairline-strong px-3 text-[12.5px] text-fg-1 transition-colors hover:bg-sunken"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={[
              'h-7 rounded-lg px-3 text-[12.5px] transition-opacity hover:opacity-90',
              danger ? 'bg-danger text-white' : 'bg-accent text-accent-fg'
            ].join(' ')}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
