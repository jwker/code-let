import { useEffect, useRef, useState } from 'react'
import { useLeftColumnOverlay } from './useOverlay'

/**
 * 一个只有输入框的小对话框。
 *
 * 给「改名」这类动作用 —— 重命名 agent、重命名会话、以后新建之类。
 * 抽出来是因为它们长得一模一样，各写一份迟早分叉（一处支持回车、一处忘了）。
 */
export function PromptDialog({
  title,
  subtitle,
  label,
  initialValue,
  placeholder,
  maxLength,
  hint,
  confirmText = '保存',
  busyText = '保存中…',
  busy = false,
  /** 返回错误文案就不提交；返回 null 表示可以 */
  validate,
  onCancel,
  onConfirm
}: {
  title: string
  subtitle?: string
  label: string
  initialValue: string
  placeholder?: string
  maxLength?: number
  hint?: string
  confirmText?: string
  busyText?: string
  busy?: boolean
  validate?: (value: string) => string | null
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  useLeftColumnOverlay()
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开就聚焦并全选 —— 想改名直接敲，不用先删掉原来的
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  function submit(): void {
    if (busy) return
    const trimmed = value.trim()
    const problem = validate ? validate(trimmed) : null
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    onConfirm(trimmed)
  }

  return (
    <div className="left-scope z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={busy ? undefined : onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="left-dialog relative w-[360px] rounded-xl border border-hairline bg-raised p-4"
        style={{ boxShadow: 'var(--sh-lg)' }}
      >
        <div className="text-[13.5px] font-semibold text-fg-1">{title}</div>
        {subtitle && <div className="mt-1 text-[11.5px] leading-5 text-fg-3">{subtitle}</div>}

        <label htmlFor="prompt-dialog-input" className="mt-3 block text-[11.5px] text-fg-2">
          {label}
        </label>
        <input
          id="prompt-dialog-input"
          ref={inputRef}
          value={value}
          disabled={busy}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            submit()
          }}
          className="mt-1 w-full rounded-lg border border-hairline bg-sunken px-2.5 py-1.5 text-[13px] text-fg-1 outline-none focus:border-hairline-strong"
        />

        {error ? (
          <div className="mt-1 text-[11px] text-danger" role="alert">
            {error}
          </div>
        ) : hint ? (
          <div className="mt-1 text-[11px] text-fg-3">{hint}</div>
        ) : null}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-7 rounded-lg border border-hairline px-3 text-[12.5px] text-fg-2 transition-colors hover:bg-sunken disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="h-7 rounded-lg bg-accent px-3 text-[12.5px] text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? busyText : confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
