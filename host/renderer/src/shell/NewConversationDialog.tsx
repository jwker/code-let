import { useEffect, useRef, useState } from 'react'

/**
 * 新建对话前先起名。
 *
 * 输入框默认填「会话」加三位随机数 —— 直接回车就能建，
 * 想改就在这儿改。名字写进 Pi 的会话文件（`session_info`），
 * 所以侧栏、标签栏、控制台看到的都是它。
 */

/** 默认名字：会话 + 三位随机数 */
export function randomConversationName(): string {
  const digits = String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  return `会话${digits}`
}

export function NewConversationDialog({
  project,
  initialName,
  busy,
  onCreate,
  onCancel
}: {
  /** 在哪个项目里建 —— 只用于提示用户 */
  project: string
  initialName: string
  busy?: boolean
  onCreate: (name: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(initialName)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开就聚焦并全选 —— 想改名直接敲，不用先删默认值
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

  /**
   * 确定。
   *
   * 名字留空就用默认的那个 —— 用户清空输入框往往只是「不想自己起」，
   * 不该因此卡住不让建。
   */
  function submit(): void {
    if (busy) return
    onCreate(name.trim() || initialName)
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={busy ? undefined : onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="新建对话"
        className="relative w-[360px] rounded-xl border border-hairline bg-raised p-4"
        style={{ boxShadow: 'var(--sh-lg)' }}
      >
        <div className="text-[13.5px] font-semibold text-fg-1">新建对话</div>
        <div className="mt-1 truncate text-[11.5px] text-fg-3" title={project}>
          {project}
        </div>

        <label htmlFor="new-conversation-name" className="mt-3 block text-[11.5px] text-fg-2">
          名字
        </label>
        <input
          id="new-conversation-name"
          ref={inputRef}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          className="mt-1 w-full rounded-lg border border-hairline bg-sunken px-2.5 py-1.5 text-[13px] text-fg-1 outline-none focus:border-hairline-strong"
        />

        <div className="mt-1 text-[11px] text-fg-3">
          留空也行，会用默认名字。回车直接建，Esc 取消。
        </div>

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
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
