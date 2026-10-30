import { useState } from 'react'
import type { StreamItem } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { IconArrowUp } from '../shell/icons'
import { NormalStream } from './NormalStream'
import { ScrollJump } from './ScrollJump'
import { TerminalStream } from './TerminalStream'
import { useAutoScroll } from './useAutoScroll'

/** 还没有内容流时的空数组 —— 稳定引用，别每次渲染新建 */
const EMPTY_ITEMS: StreamItem[] = []

/**
 * 对话区 —— 应用的核心组件（PLAN.md D10）。
 *
 * 一条内容流，三种排版。普通和终端读同一个数组（R3），
 * HTML 模式这一轮留空 —— 它不是排版，是 skill 的产物。
 */
export function ConversationArea() {
  const mode = useStore((s) => s.mode)
  const session = useStore((s) => s.snapshot.session)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)
  // 内容流按标签存（D4 修订）—— 这里只读活动标签那一份
  const items = useStore((s) => (s.snapshot.activeTabId ? s.items[s.snapshot.activeTabId] : undefined) ?? EMPTY_ITEMS)
  const streaming = useStore(
    (s) => (s.snapshot.activeTabId ? s.streaming[s.snapshot.activeTabId] : undefined) ?? false
  )
  const openPicker = useStore((s) => s.openModelPicker)
  const [draft, setDraft] = useState('')

  // 实时流往下长 —— 视图要跟着走，不然用户看不到刚出来的内容（R2）
  const { setRef, scrollToBottom, jumpTo, scrollable, atBottom } = useAutoScroll(
    items,
    streaming,
    session.sessionId
  )

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || !activeTabId) return
    setDraft('')
    scrollToBottom()
    await host.prompt(activeTabId, text)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="min-h-0 flex-1">
        {mode === 'normal' &&
          (items.length > 0 ? (
            <div className="conv-normal" ref={setRef}>
              <NormalStream items={items} streaming={streaming} tabId={activeTabId} />
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
              <TerminalStream items={items} streaming={streaming} tabId={activeTabId} />
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

      <footer className="conv-footer flex-none pb-5 pt-2">
        <div className="relative mx-auto w-full max-w-[var(--content-max)]">
          {/* 现阶段只有普通模式有这个钮（PLAN.md D14）；钉在内容列右下角、输入卡上方 */}
          {mode === 'normal' && (
            <ScrollJump scrollable={scrollable} atBottom={atBottom} onJump={jumpTo} />
          )}

          <div className="rounded-[18px] border border-hairline bg-raised p-3 shadow-[var(--sh-md)] transition-colors focus-within:border-hairline-strong">
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
              placeholder="说点什么…"
              className="min-h-[52px] w-full resize-none border-0 bg-transparent px-2 pt-1 text-[14.5px] leading-6 text-fg-1 outline-none placeholder:text-fg-3"
            />

            <div className="mt-1 flex items-center gap-3 px-2">
              {/*
                模型：显示与切换的唯一位置（换模型是「准备发下一条」时做的决定）。
                生成中禁用 —— 本轮的模型已经定了，要换得等这轮结束。
              */}
              <button
                type="button"
                disabled={streaming || !session.model}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  openPicker({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
                }}
                title={session.model ? `${session.model.provider}/${session.model.id}` : '未选模型'}
                className="conv-model flex min-w-0 max-w-[230px] items-center gap-1 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] text-fg-2 transition-colors hover:border-hairline-strong hover:bg-panel hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex-none text-fg-3">◇</span>
                <span className="conv-model-name min-w-0 truncate font-mono">
                  {session.model ? session.model.name : '未选模型'}
                </span>
                <span className="conv-model-caret flex-none text-fg-3">▾</span>
              </button>
              <span className="conv-hint flex-none text-[11.5px] text-fg-3">⌘↵ 发送</span>
              {session.error && (
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-danger" title={session.error}>
                  {session.error}
                </span>
              )}
              <button
                type="button"
                onClick={() => void send()}
                disabled={!draft.trim()}
                aria-label="发送"
                title="发送"
                className="ml-auto grid h-8 w-8 flex-none place-items-center rounded-full bg-accent text-accent-fg transition-opacity hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconArrowUp />
              </button>
            </div>
          </div>
        </div>
      </footer>
    </section>
  )
}
