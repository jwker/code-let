import { useState } from 'react'
import type { ConversationMode } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { NormalStream } from './NormalStream'
import { TerminalStream } from './TerminalStream'
import { useAutoScroll } from './useAutoScroll'

const MODES: Array<{ key: ConversationMode; label: string }> = [
  { key: 'normal', label: '普通' },
  { key: 'terminal', label: '终端' },
  { key: 'html', label: 'HTML' }
]

/**
 * 对话区 —— 应用的核心组件（PLAN.md D10）。
 *
 * 一条内容流，三种排版。普通和终端读同一个数组（R3），
 * HTML 模式这一轮留空 —— 它不是排版，是 skill 的产物。
 */
export function ConversationArea() {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const session = useStore((s) => s.snapshot.session)
  const items = useStore((s) => s.items)
  const streaming = useStore((s) => s.streaming)
  const [draft, setDraft] = useState('')

  // 实时流往下长 —— 视图要跟着走，不然用户看不到刚出来的内容（R2）
  const { setRef, scrollToBottom } = useAutoScroll(items, streaming, session.sessionId)

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    scrollToBottom()
    await host.prompt(text)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-11 flex-none items-center gap-3 border-b border-hairline px-4">
        <h1 className="text-[13px] font-semibold text-fg-1">会话</h1>

        <div
          role="tablist"
          aria-label="对话区渲染模式"
          className="flex items-center gap-0.5 rounded-md border border-hairline bg-sunken p-0.5"
        >
          {MODES.map((item) => {
            const active = mode === item.key
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setMode(item.key)}
                className={[
                  'rounded-sm px-2.5 py-1 text-[11.5px] transition-colors',
                  active ? 'bg-raised text-fg-1' : 'text-fg-3 hover:text-fg-2'
                ].join(' ')}
                style={active ? { boxShadow: 'var(--sh-sm)' } : undefined}
              >
                {item.label}
              </button>
            )
          })}
        </div>

        {session.error && (
          <span className="truncate text-[11.5px] text-danger" title={session.error}>
            {session.error}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1">
        {mode === 'normal' &&
          (items.length > 0 ? (
            <div className="conv-normal" ref={setRef}>
              <NormalStream items={items} streaming={streaming} />
            </div>
          ) : (
            <div className="conv-normal" ref={setRef}>
              <div className="placeholder">
                <div>普通模式 · 气泡消息流</div>
                <div className="text-[11.5px]">这个对话还没说过话</div>
              </div>
            </div>
          ))}

        {mode === 'terminal' &&
          (items.length > 0 ? (
            <div className="conv-terminal" ref={setRef}>
              <TerminalStream items={items} streaming={streaming} />
            </div>
          ) : (
            <div className="conv-terminal" ref={setRef}>
              <div className="placeholder font-sans">
                <div>终端模式 · 等宽执行流</div>
                <div className="text-[11.5px]">这个对话还没说过话</div>
              </div>
            </div>
          ))}

        {mode === 'html' && (
          <div className="conv-html" ref={setRef}>
            <div className="placeholder">
              <div>HTML 模式 · 这一轮留空</div>
              <div className="text-[11.5px]">它不是排版，是 skill 的产物</div>
            </div>
          </div>
        )}
      </div>

      <footer className="flex-none border-t border-hairline px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder="说点什么…（⌘↵ 发送）"
            className="min-h-[44px] flex-1 resize-none rounded-md border border-hairline bg-sunken px-3 py-2 text-[13px] text-fg-1 outline-none placeholder:text-fg-3 focus:border-accent-line"
          />
          <button
            type="button"
            onClick={() => void send()}
            className="h-9 flex-none rounded-md bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-colors hover:bg-accent-hover"
          >
            发送
          </button>
        </div>
      </footer>
    </section>
  )
}
