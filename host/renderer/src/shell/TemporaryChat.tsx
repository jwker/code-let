import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelOption, StreamItem } from '@contract/index'
import { host } from '../host'
import { useStore } from '../store'
import { NormalStream } from '../conversation/NormalStream'
import { useAutoScroll } from '../conversation/useAutoScroll'
import {
  attachmentTotalError,
  formatBytes,
  formatTokenEstimate,
  type ComposerAttachment
} from '../conversation/composerCommands'
import { ModelPicker } from './ModelPicker'
import { IconArrowUp, IconPaperclip, IconStop } from './icons'

const EMPTY_ITEMS: StreamItem[] = []

/** 贴在输入框上沿左侧；输入框变高或主区变窄时重新算 */
function temporaryBounds(): { left: number; bottom: number } {
  const main = document.querySelector<HTMLElement>('.shell-card.main')
  const composer = document.querySelector<HTMLElement>('.conv-footer')
  const mainRect = main?.getBoundingClientRect()
  const composerRect = composer?.getBoundingClientRect()
  if (!mainRect) return { left: 24, bottom: 24 }
  return {
    left: mainRect.left + 12,
    bottom: composerRect ? window.innerHeight - composerRect.top + 12 : 24
  }
}

/**
 * 临时对话浮层（PLAN.md D40）。
 *
 * 会话只存在主进程内存里；这里只负责窗口、输入、附件和模型。最小化只隐藏浮层，
 * 彻底关闭才会丢弃会话。输入不挂 `/` 和 `@` 菜单。
 */
export function TemporaryChat() {
  const temp = useStore((s) => s.snapshot.temporaryChat)
  const minimized = useStore((s) => s.tempMinimized)
  const setMinimized = useStore((s) => s.setTempMinimized)
  const setSnapshot = useStore((s) => s.setSnapshot)
  const clearTabItems = useStore((s) => s.clearTabItems)
  const setItems = useStore((s) => s.setItems)
  const items = useStore((s) => (temp ? (s.items[temp.id] ?? EMPTY_ITEMS) : EMPTY_ITEMS))
  const streaming = useStore((s) => (temp ? (s.streaming[temp.id] ?? false) : false))

  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [closing, setClosing] = useState(false)
  const [modelPicker, setModelPicker] = useState<{ left: number; bottom: number } | null>(null)
  const [models, setModels] = useState<ModelOption[]>([])
  const [bounds, setBounds] = useState(temporaryBounds)
  const [done, setDone] = useState(false)
  const wasStreaming = useRef(streaming)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { setRef, scrollToBottom } = useAutoScroll(items, streaming, temp?.id ?? null)

  // 浮层跟着输入框上沿走：输入框变高、主区变窄时都重算
  useEffect(() => {
    if (!temp) return
    const main = document.querySelector<HTMLElement>('.shell-card.main')
    const composer = document.querySelector<HTMLElement>('.conv-footer')
    const update = (): void => setBounds(temporaryBounds())
    update()
    const observer = new ResizeObserver(update)
    if (main) observer.observe(main)
    if (composer) observer.observe(composer)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [temp?.id])

  // 最小化期间如果一轮跑完，球显示对勾；恢复窗口后回到箭头
  useEffect(() => {
    if (!minimized) {
      setDone(false)
      wasStreaming.current = streaming
      return
    }
    if (wasStreaming.current && !streaming) setDone(true)
    wasStreaming.current = streaming
  }, [minimized, streaming])

  // 新临时会话：清空窗口内的草稿和附件（最小化恢复不走这里）
  useEffect(() => {
    setDraft('')
    setAttachments([])
    setError(null)
    setConfirmClose(false)
    setModelPicker(null)
    setClosing(false)
    setDone(false)
    wasStreaming.current = false
  }, [temp?.id])

  // 渲染进程重载/最小化恢复时，内容流可能不在 store 里；从内存会话读一次
  useEffect(() => {
    if (!temp) return
    if (useStore.getState().items[temp.id]) return
    let cancelled = false
    void host
      .getTabEntries(temp.id)
      .then((next) => {
        if (!cancelled) setItems(temp.id, next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [setItems, temp])

  // 打开/恢复时聚焦输入框
  useLayoutEffect(() => {
    if (!temp || minimized) return
    textareaRef.current?.focus()
  }, [temp, minimized])

  // Esc：只取消确认/模型选择；不关闭临时对话
  useEffect(() => {
    if (!temp || minimized) return
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== 'Escape') return
      if (confirmClose) {
        event.preventDefault()
        setConfirmClose(false)
        return
      }
      if (modelPicker) {
        event.preventDefault()
        setModelPicker(null)
        return
      }
      // 不关闭窗口。阻止传播，避免主界面的 Esc 停止逻辑误触。
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [confirmClose, minimized, modelPicker, temp])

  if (!temp) return null

  if (minimized) {
    const status = streaming ? '回答中…' : done ? '已完成' : '可继续'
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        style={{ left: bounds.left, bottom: bounds.bottom }}
        className="fixed z-[80] grid h-11 w-11 place-items-center rounded-full transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        title={`临时对话 · ${status}`}
        aria-label="恢复临时对话"
      >
        <span className="grid h-10 w-10 place-items-center rounded-full bg-[#171715] text-[#FAFAF9] shadow-[0_12px_30px_-8px_rgba(0,0,0,0.5)]">
          {streaming ? (
            <span className="conv-stop-ring h-4 w-4" aria-hidden="true" />
          ) : done ? (
            <span className="text-[15px] font-bold" aria-hidden="true">✓</span>
          ) : (
            <span className="text-[17px]" aria-hidden="true">↗</span>
          )}
        </span>
      </button>
    )
  }

  async function pickAttachments(): Promise<void> {
    if (!temp || uploading) return
    setUploading(true)
    try {
      const result = await host.pickAttachments()
      let next = attachments
      for (const picked of result.attachments) {
        const attachment: ComposerAttachment = {
          path: picked.name,
          name: picked.name,
          uploadId: picked.id,
          kind: picked.kind,
          size: picked.size,
          tokens: picked.tokens
        }
        if (next.some((item) => item.uploadId === picked.id)) continue
        const totalError = attachmentTotalError(next, attachment)
        if (totalError) {
          setError(totalError)
          break
        }
        next = [...next, attachment]
      }
      setAttachments(next)
      if (result.errors.length > 0) setError(result.errors.join('；'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setUploading(false)
    }
  }

  function removeAttachment(item: ComposerAttachment): void {
    setAttachments((current) => current.filter((next) => (next.uploadId ?? next.path) !== (item.uploadId ?? item.path)))
  }

  async function openModels(event: React.MouseEvent<HTMLButtonElement>): Promise<void> {
    if (!temp || streaming) return
    const rect = event.currentTarget.getBoundingClientRect()
    setModelPicker({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
    try {
      setModels(await host.listTemporaryModels(temp.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function send(): Promise<void> {
    if (!temp || !draft.trim() || streaming || uploading) return
    const text = draft.trim()
    const previousAttachments = attachments
    setDraft('')
    setAttachments([])
    setError(null)
    scrollToBottom()
    try {
      await host.promptTemporary(
        temp.id,
        text,
        previousAttachments.flatMap((item) => (item.uploadId ? [item.uploadId] : []))
      )
    } catch (caught) {
      setDraft((current) => (current === '' ? text : current))
      setAttachments((current) => (current.length === 0 ? previousAttachments : current))
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function close(): Promise<void> {
    if (!temp || closing) return
    setClosing(true)
    setError(null)
    try {
      const snapshot = await host.closeTemporaryChat()
      clearTabItems(temp.id)
      setSnapshot(snapshot)
      setMinimized(false)
      setConfirmClose(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setClosing(false)
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    void send()
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6 backdrop-blur-[1.5px]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="临时对话"
        className="relative flex h-[min(700px,calc(100vh-64px))] w-[min(620px,calc(100vw-48px))] flex-col overflow-hidden rounded-[20px] border border-hairline-strong bg-surface shadow-[var(--sh-lg)]"
      >
        <header className="flex flex-none items-start gap-3 border-b border-hairline px-4 py-4">
          <div className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[10px] border border-dashed border-hairline-strong bg-sunken text-[15px] text-fg-2">
            ◌
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-semibold text-fg-1">临时对话</h2>
              <span className="rounded-full border border-hairline-strong px-1.5 text-[9px] font-semibold tracking-[.04em] text-fg-3">
                临时
              </span>
            </div>
            <div className="mt-0.5 text-[10.5px] text-fg-3">
              最小化可继续；彻底关闭后清除，不写入会话文件
            </div>
          </div>
          <div className="flex flex-none items-center gap-0.5">
            <button
              type="button"
              onClick={() => setMinimized(true)}
              className="grid h-7 w-7 place-items-center rounded-md text-[16px] text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
              title="最小化，保留对话"
              aria-label="最小化"
            >
              −
            </button>
            <button
              type="button"
              onClick={() => {
                setModelPicker(null)
                setConfirmClose(true)
              }}
              className="grid h-7 w-7 place-items-center rounded-md text-[18px] text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
              title="彻底关闭（会先确认）"
              aria-label="关闭临时对话"
            >
              ×
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto" ref={setRef}>
          {items.length === 0 ? (
            <div className="mx-auto mt-12 max-w-[320px] px-4 text-center text-[11.5px] leading-7 text-fg-3">
              <div className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-full border border-dashed border-hairline-strong text-[17px] text-fg-2">
                ◌
              </div>
              这段对话只存在于内存里。可以连续提问、上传附件或切换模型；关闭窗口就会清除。
            </div>
          ) : (
            <NormalStream items={items} streaming={streaming} tabId={temp.id} />
          )}
        </div>

        <footer className="flex-none border-t border-hairline px-4 pb-3 pt-2.5">
          {attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {attachments.map((item) => (
                <span
                  key={item.uploadId ?? item.path}
                  className="flex min-w-0 items-center gap-1 rounded-full border border-hairline bg-sunken py-0.5 pl-2 pr-1 text-[10px] text-fg-2"
                >
                  <span className="text-fg-3">{item.kind === 'image' ? '▧' : '▤'}</span>
                  <span className="max-w-[210px] truncate" title={item.name ?? item.path}>
                    {item.name ?? item.path}
                  </span>
                  <span className="font-mono text-[9px] text-fg-3">{formatBytes(item.size)}</span>
                  <span className="font-mono text-[9px] text-fg-3">{formatTokenEstimate(item.tokens)}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(item)}
                    className="grid h-4 w-4 place-items-center rounded-full text-fg-3 hover:bg-danger-wash hover:text-danger"
                    aria-label={`移除附件「${item.name ?? item.path}」`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {error && <div className="mb-1.5 text-[11px] text-danger">{error}</div>}
          <div className="rounded-[15px] border border-hairline-strong bg-raised px-3 pb-2 pt-2 shadow-[var(--sh-sm)]">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={2}
              placeholder="问点什么…"
              className="min-h-[42px] w-full resize-none border-0 bg-transparent text-[12.5px] leading-6 text-fg-1 outline-none placeholder:text-fg-3"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={uploading}
                onClick={() => void pickAttachments()}
                className="grid h-6 w-6 place-items-center rounded-full text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1 disabled:opacity-40"
                title={uploading ? '正在选择文件…' : '上传文件或图片'}
                aria-label="上传文件或图片"
              >
                <IconPaperclip />
              </button>
              <button
                type="button"
                disabled={streaming}
                onClick={(event) => void openModels(event)}
                className="flex h-[22px] max-w-[210px] items-center gap-1 rounded-full border border-hairline px-2 text-[10px] text-fg-2 transition-colors hover:border-hairline-strong hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50"
                title={temp.model ? `${temp.model.provider}/${temp.model.id}` : '未选模型'}
              >
                <span className="text-fg-3">◇</span>
                <span className="min-w-0 truncate font-mono">{temp.model?.name ?? '未选模型'}</span>
                <span className="text-[9px] text-fg-3">▾</span>
              </button>
              <span className="ml-auto text-[9.5px] text-fg-3">
                {streaming ? '回答中…' : '↵ 发送 · ⇧↵ 换行'}
              </span>
              {streaming ? (
                <button
                  type="button"
                  onClick={() => void host.abortTemporary(temp.id)}
                  className="grid h-[29px] w-[29px] place-items-center rounded-full bg-accent text-accent-fg"
                  title="停止"
                  aria-label="停止"
                >
                  <IconStop />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!draft.trim() || uploading}
                  onClick={() => void send()}
                  className="grid h-[29px] w-[29px] place-items-center rounded-full bg-accent text-accent-fg transition-opacity hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  title="发送"
                  aria-label="发送"
                >
                  <IconArrowUp />
                </button>
              )}
            </div>
          </div>
        </footer>

        {confirmClose && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/25 p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setConfirmClose(false)
            }}
          >
            <div
              role="alertdialog"
              aria-modal="true"
              aria-label="彻底关闭临时对话"
              className="w-[min(390px,100%)] rounded-2xl border border-hairline-strong bg-raised p-5 shadow-[var(--sh-lg)]"
            >
              <div className="flex gap-3">
                <span className="grid h-7 w-7 flex-none place-items-center rounded-full border border-danger-line bg-danger-wash text-[14px] font-bold text-danger">
                  !
                </span>
                <div>
                  <div className="text-[14px] font-semibold text-fg-1">彻底关闭临时对话？</div>
                  <p className="mt-1.5 text-[12px] leading-6 text-fg-2">
                    这段对话只存在内存里，关闭后消息、附件、草稿和模型选择都会清除，无法恢复。
                    可以改用最小化保留它。
                  </p>
                  <p className="mt-1.5 text-[11px] text-fg-3">如果正在生成，会先中止当前这一轮。</p>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-hairline pt-3">
                <span className="mr-auto text-[10px] text-fg-3">Esc 取消</span>
                <button
                  type="button"
                  onClick={() => setConfirmClose(false)}
                  className="h-7 rounded-md border border-hairline-strong bg-surface px-3 text-[11.5px] text-fg-2 hover:bg-sunken"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={closing}
                  onClick={() => void close()}
                  className="h-7 rounded-md bg-danger px-3 text-[11.5px] font-medium text-white hover:brightness-95 disabled:cursor-wait disabled:opacity-60"
                >
                  {closing ? '关闭中…' : '彻底关闭'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {modelPicker && (
        <div
          className="fixed z-[110]"
          style={{
            left: Math.max(8, Math.min(modelPicker.left, window.innerWidth - 436)),
            bottom: modelPicker.bottom
          }}
        >
          <ModelPicker
            models={models}
            current={temp.model}
            allowPersist={false}
            onPick={async (model) => {
              const snapshot = await host.selectTemporaryModel(temp.id, model.provider, model.id)
              setSnapshot(snapshot)
              setModelPicker(null)
            }}
            onClose={() => setModelPicker(null)}
          />
        </div>
      )}
    </div>
  )
}
