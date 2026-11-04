import { useEffect, useState } from 'react'
import type {
  ContextDiffGroup,
  ContextDiffSession,
  ContextDiffView,
  ContextMessageSummary,
  ContextSnapshotRef
} from '@contract/index'
import { host } from '../host'
import { useStore } from '../store'

function tokenLabel(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens)
}

function roleLabel(role: string): string {
  if (role === 'user') return 'USER'
  if (role === 'assistant') return 'ASSISTANT'
  if (role === 'toolResult') return 'TOOL'
  if (role === 'system') return 'SYSTEM'
  return role.toUpperCase()
}

function refLabel(ref: ContextSnapshotRef | null): string {
  if (!ref) return '无基线'
  const name = ref.sessionName || ref.sessionId.slice(0, 8)
  return `${name} · 第 ${ref.turn} 轮 · 第 ${ref.request} 次`
}

function systemLabel(value: ContextDiffView['system']): string {
  if (value === 'same') return '相同'
  if (value === 'changed') return '已修改'
  if (value === 'only-current') return '仅当前有'
  if (value === 'only-baseline') return '仅基线有'
  return '未知'
}

function toolsLabel(value: ContextDiffView['tools'], approximate: boolean): string {
  if (value === 'same') return '相同'
  if (value === 'changed') return approximate ? '有变化（近似）' : '有变化'
  return '近似/未知'
}

/** 右侧检视器的上下文变化：默认摘要，基线选择时进入请求历史，宽面板可双栏。 */
export function ContextDiffPane() {
  const diff = useStore((s) => s.snapshot.contextDiff)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)
  const [view, setView] = useState<ContextDiffView | null>(diff)
  const [baselineId, setBaselineId] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [snapshots, setSnapshots] = useState<ContextSnapshotRef[]>([])
  const [sessions, setSessions] = useState<ContextDiffSession[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<{
    title: string
    text: string
    truncated: boolean
    released: boolean
    before: { text: string; truncated: boolean; released: boolean } | null
  } | null>(null)

  useEffect(() => {
    setView(diff)
    setBaselineId(null)
    setPickerOpen(false)
    setSnapshots([])
    setSessions([])
    setDetail(null)
    setError(null)
  }, [activeTabId])

  useEffect(() => {
    if (!baselineId) {
      setView(diff)
      return
    }
    if (!activeTabId) return
    let cancelled = false
    host
      .getContextDiff(activeTabId, baselineId)
      .then((next) => {
        if (cancelled) return
        if (next) {
          setView(next)
        } else {
          setBaselineId(null)
          setView(diff)
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [activeTabId, baselineId, diff?.current.id])



  async function openPicker(): Promise<void> {
    if (!activeTabId) return
    setPickerOpen(true)
    setLoading(true)
    setError(null)
    try {
      const [sessionList, snapshotList] = await Promise.all([
        host.listContextDiffSessions(),
        host.listContextDiffSnapshots(activeTabId)
      ])
      setSessions(sessionList)
      setSnapshots(snapshotList)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  function chooseBaseline(snapshotId: string): void {
    if (snapshotId === view?.current.id) return
    setBaselineId(snapshotId)
    setPickerOpen(false)
  }

  function resetBaseline(): void {
    setBaselineId(null)
    setPickerOpen(false)
    if (view?.approximate && activeTabId) {
      void host.getApproximateContextDiff(activeTabId).then(setView)
    } else {
      setView(diff)
    }
  }

  async function loadApproximate(): Promise<void> {
    if (!activeTabId) return
    setLoading(true)
    setError(null)
    try {
      const next = await host.getApproximateContextDiff(activeTabId)
      setBaselineId(null)
      setView(next)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  async function openDetail(
    snapshotId: string,
    message: ContextMessageSummary,
    baselineId?: string
  ): Promise<void> {
    if (!activeTabId) return
    setLoading(true)
    try {
      const [result, previous] = await Promise.all([
        host.getContextDiffDetail(activeTabId, snapshotId, message.key),
        message.previousKey && baselineId
          ? host.getContextDiffDetail(activeTabId, baselineId, message.previousKey)
          : Promise.resolve(null)
      ])
      const before =
        message.previousKey && baselineId
          ? {
              text: previous?.text ?? message.previousPreview ?? '',
              truncated: previous?.truncated ?? false,
              released: !previous
            }
          : null
      setDetail({
        title: `${roleLabel(message.role)} · ${tokenLabel(message.tokens)} tokens${before ? ' · 修改' : ''}`,
        text: result?.text ?? message.preview,
        truncated: result?.truncated ?? false,
        released: !result,
        before
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  if (!activeTabId) {
    return (
      <div className="insp-body">
        <section className="flex min-h-0 flex-1 flex-col p-5 text-[12px] text-fg-3">
          打开一个对话后才能查看上下文变化。
        </section>
      </div>
    )
  }

  const current = view?.current ?? null
  const maxTokens = Math.max(view?.tokens.before ?? 0, view?.tokens.after ?? 0, 1)
  const beforePct = Math.round(((view?.tokens.before ?? 0) / maxTokens) * 100)
  const afterPct = Math.round(((view?.tokens.after ?? 0) / maxTokens) * 100)
  const added = view?.groups.find((group) => group.kind === 'added')
  const removed = view?.groups.find((group) => group.kind === 'removed')
  const modified = view?.groups.find((group) => group.kind === 'modified')
  const compacted = view?.groups.find((group) => group.kind === 'compacted')

  return (
    <div className="insp-body">
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
          <h2 className="text-[13px] font-medium text-fg-1">上下文变化</h2>
          <span className="rounded border border-hairline px-1.5 text-[9px] text-fg-3">Diff</span>
          <span className="ml-auto text-[9px] text-fg-3">
            {baselineId ? '自定义基线' : '最近两次请求'}
          </span>
          {view && (
            <button
              type="button"
              onClick={() => void openPicker()}
              className="text-[9px] text-fg-3 hover:text-fg-1"
            >
              切换
            </button>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading && <div className="mb-2 text-[10px] text-fg-3">正在读取上下文…</div>}
          {error && <div className="mb-2 text-[10px] text-danger">{error}</div>}
          {view?.approximate && (
            <div className="mb-2 rounded-lg border border-warn/40 bg-warn-wash px-2.5 py-2 text-[9.5px] leading-5 text-warn">
              近似视图：按会话历史中的用户轮次重建，不包含 system、工具声明和请求级转换。
              这个会话没有请求级快照，可能是在终端里产生的对话。
            </div>
          )}

          {pickerOpen && (
            <BaselinePicker
              snapshots={snapshots}
              sessions={sessions}
              currentId={current?.id ?? null}
              baselineId={baselineId}
              loading={loading}
              onPick={chooseBaseline}
              onReset={resetBaseline}
              onClose={() => setPickerOpen(false)}
            />
          )}

          {!view || !current ? (
            <div className="px-2 py-10 text-center text-[11.5px] leading-7 text-fg-3">
              <div className="mb-2 text-[18px] text-fg-2">≋</div>
              还没有请求级上下文快照。<br />
              下一次模型请求后，这里会显示这一轮和上一轮的变化。
              <div className="mt-3 border-t border-hairline pt-3 text-left">
                <p className="text-[10px] leading-6 text-fg-3">
                  如果在终端里聊过这个会话，终端进程不会加载 Codelet 的请求级采集器，
                  所以这里没有精确快照。可以只用会话历史重建一份近似对比。
                </p>
                <button
                  type="button"
                  onClick={() => void loadApproximate()}
                  className="mt-2 rounded-md border border-hairline-strong bg-surface px-2.5 py-1 text-[10px] text-fg-2 hover:bg-sunken"
                >
                  从会话历史重建近似对比
                </button>
              </div>
            </div>
          ) : (
            <SummaryView
              view={view}
              added={added}
              removed={removed}
              modified={modified}
              compacted={compacted}
              beforePct={beforePct}
              afterPct={afterPct}
              onBaseline={() => void openPicker()}
              onDetail={(snapshotId, message, baselineId) => void openDetail(snapshotId, message, baselineId)}
            />
          )}
        </div>

        {view && (
          <div className="flex flex-none items-center gap-2 border-t border-hairline px-3 py-1.5 text-[9px] text-fg-3">
            <span>{view.counts.shared} 条共享 · {view.counts.added + view.counts.removed + view.counts.modified} 条变化</span>
            <span className="ml-auto">详情按需读取</span>
          </div>
        )}
      </section>

      {detail && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 p-5"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetail(null)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="上下文消息详情"
            className="flex max-h-[70vh] w-[min(560px,100%)] flex-col overflow-hidden rounded-2xl border border-hairline-strong bg-raised shadow-[var(--sh-lg)]"
          >
            <header className="flex items-center gap-2 border-b border-hairline px-4 py-3">
              <span className="text-[11px] font-medium text-fg-1">{detail.title}</span>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="ml-auto text-[17px] text-fg-3 hover:text-fg-1"
                aria-label="关闭详情"
              >
                ×
              </button>
            </header>
            <div className="min-h-0 overflow-y-auto p-4">
              {detail.before ? (
                <div className="flex flex-col gap-3">
                  <DetailBlock label="修改前" text={detail.before.text} tone="before" />
                  <DetailBlock label="修改后" text={detail.text} />
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words text-[11.5px] leading-6 text-fg-2">
                  {detail.text}
                </div>
              )}
            </div>
            {(detail.truncated || detail.released || detail.before?.truncated || detail.before?.released) && (
              <div className="border-t border-hairline px-4 py-2 text-[10px] text-fg-3">
                {[
                  detail.before?.released && '修改前详情已释放，显示 preview。',
                  detail.before?.truncated && '修改前内容过长，只显示前 256KB。',
                  detail.released && '详情已释放，显示 preview。',
                  detail.truncated && '内容过长，只显示前 256KB。'
                ]
                  .filter(Boolean)
                  .join(' ')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function BaselinePicker({
  snapshots,
  sessions,
  currentId,
  baselineId,
  loading,
  onPick,
  onReset,
  onClose
}: {
  snapshots: ContextSnapshotRef[]
  sessions: ContextDiffSession[]
  currentId: string | null
  baselineId: string | null
  loading: boolean
  onPick: (id: string) => void
  onReset: () => void
  onClose: () => void
}) {
  return (
    <div className="mb-3 rounded-lg border border-hairline-strong bg-panel p-2.5 shadow-[var(--sh-sm)]">
      <div className="flex items-center gap-2 border-b border-hairline pb-2">
        <span className="text-[10px] font-medium text-fg-1">选择基线</span>
        <span className="text-[8.5px] text-fg-3">当前请求不变</span>
        <button type="button" onClick={onReset} className="ml-auto text-[9px] text-fg-3 hover:text-fg-1">
          最近两次
        </button>
        <button type="button" onClick={onClose} className="text-[15px] leading-none text-fg-3 hover:text-fg-1" aria-label="关闭基线选择">
          ×
        </button>
      </div>

      {loading && <div className="py-2 text-[9px] text-fg-3">正在读取快照…</div>}

      <div className="mt-2">
        <div className="mb-1 text-[8.5px] uppercase tracking-[.06em] text-fg-3">本会话请求</div>
        <div className="flex flex-col gap-0.5">
          {!loading && snapshots.length === 0 && (
            <div className="py-1 text-[9px] text-fg-3">还没有请求级快照。</div>
          )}
          {[...snapshots].reverse().map((snapshot) => {
            const isCurrent = snapshot.id === currentId
            const selected = snapshot.id === baselineId
            return (
              <button
                key={snapshot.id}
                type="button"
                disabled={isCurrent}
                onClick={() => onPick(snapshot.id)}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-left text-[9px] ${
                  selected
                    ? 'bg-accent-wash text-fg-1'
                    : isCurrent
                      ? 'text-fg-3'
                      : 'text-fg-2 hover:bg-sunken'
                }`}
              >
                <span className="font-mono text-[8px] text-fg-3">
                  第 {snapshot.turn} 轮 · 第 {snapshot.request} 次
                </span>
                <span className="ml-auto font-mono text-[8px] text-fg-3">
                  {tokenLabel(snapshot.totalTokens)}
                </span>
                {isCurrent && <span className="rounded-full border border-hairline px-1 text-[7.5px]">当前</span>}
                {selected && <span className="text-[9px] text-ok">✓</span>}
              </button>
            )
          })}
        </div>
      </div>

      <div className="mt-2 border-t border-hairline pt-2">
        <div className="mb-1 text-[8.5px] uppercase tracking-[.06em] text-fg-3">跨会话</div>
        <div className="flex flex-col gap-1">
          {!loading && sessions.length === 0 && (
            <div className="py-1 text-[9px] text-fg-3">还没有其他已保存的快照。</div>
          )}
          {sessions.map((session) => (
            <div key={session.sessionId} className="rounded border border-hairline bg-surface px-1.5 py-1">
              <div className="truncate text-[9px] text-fg-2">
                {session.sessionName || session.sessionId.slice(0, 10)}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {session.first && session.first.id !== currentId && (
                  <button
                    type="button"
                    onClick={() => onPick(session.first!.id)}
                    className={`rounded border px-1.5 py-0.5 text-[8px] ${
                      session.first.id === baselineId
                        ? 'border-hairline-strong bg-accent-wash text-fg-1'
                        : 'border-hairline text-fg-3 hover:bg-sunken'
                    }`}
                  >
                    第一次 · {tokenLabel(session.first.totalTokens)}
                  </button>
                )}
                {session.last && session.last.id !== currentId && (
                  <button
                    type="button"
                    onClick={() => onPick(session.last!.id)}
                    className={`rounded border px-1.5 py-0.5 text-[8px] ${
                      session.last.id === baselineId
                        ? 'border-hairline-strong bg-accent-wash text-fg-1'
                        : 'border-hairline text-fg-3 hover:bg-sunken'
                    }`}
                  >
                    最后一次 · {tokenLabel(session.last.totalTokens)}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function SummaryView({
  view,
  added,
  removed,
  modified,
  compacted,
  beforePct,
  afterPct,
  onBaseline,
  onDetail
}: {
  view: ContextDiffView
  added?: ContextDiffGroup
  removed?: ContextDiffGroup
  modified?: ContextDiffGroup
  compacted?: ContextDiffGroup
  beforePct: number
  afterPct: number
  onBaseline: () => void
  onDetail: (snapshotId: string, message: ContextMessageSummary, baselineId?: string) => void
}) {
  const currentId = view.current.id
  const baselineId = view.baseline?.id
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1">
        <CompareRow label="当前" value={refLabel(view.current)} tokens={view.current.totalTokens} current />
        <CompareRow
          label="基线"
          value={view.baseline ? refLabel(view.baseline) : '还没有可比较的上一次请求'}
          tokens={view.baseline?.totalTokens ?? 0}
          onClick={onBaseline}
        />
      </div>

      <div className="rounded-lg border border-hairline bg-panel p-2.5">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-[11px] font-semibold text-fg-1">{tokenLabel(view.tokens.before)}</span>
          <span className="text-[10px] text-fg-3">→</span>
          <span className="font-mono text-[11px] font-semibold text-fg-1">{tokenLabel(view.tokens.after)}</span>
          <span className="ml-auto font-mono text-[9px] text-ok">
            {view.tokens.after - view.tokens.before >= 0 ? '+' : ''}
            {tokenLabel(view.tokens.after - view.tokens.before)}
          </span>
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <TokenBar label="基线" pct={beforePct} />
          <TokenBar label="当前" pct={afterPct} newPart={Math.max(0, afterPct - beforePct)} />
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        <Chip tone="add">+{view.counts.added} 新增</Chip>
        <Chip tone="warn">~{view.counts.modified} 修改</Chip>
        <Chip>{view.counts.removed} 删除</Chip>
        <Chip>{view.counts.shared} 共享</Chip>
      </div>

      <div className="rounded-lg border border-hairline">
        <div className="flex items-center gap-2 border-b border-hairline bg-panel px-2.5 py-1.5 text-[10px] text-fg-3">
          <b className="font-medium text-fg-2">System 与工具</b>
          <span className="ml-auto">{systemLabel(view.system)} · {toolsLabel(view.tools, view.toolsApproximate)}</span>
        </div>
      </div>

      {compacted && (
        <div className="rounded-lg border border-warn/40 bg-warn-wash px-2.5 py-2 text-[10px] text-warn">
          {compacted.label}
        </div>
      )}

      {modified && modified.messages.length > 0 && (
        <MessageGroup
          title={modified.label}
          messages={modified.messages}
          snapshotId={currentId}
          onDetail={(id, message) => onDetail(id, message, baselineId)}
          modified
        />
      )}
      {added && added.messages.length > 0 && (
        <MessageGroup
          title={added.label}
          messages={added.messages}
          snapshotId={currentId}
          onDetail={onDetail}
        />
      )}
      {removed && removed.messages.length > 0 && (
        <MessageGroup
          title={removed.label}
          messages={removed.messages}
          snapshotId={baselineId ?? currentId}
          onDetail={onDetail}
          removed
        />
      )}

      {view.counts.added === 0 && view.counts.removed === 0 && view.counts.modified === 0 && !compacted && (
        <div className="rounded-lg border border-hairline px-2.5 py-3 text-center text-[10px] text-fg-3">
          这两次请求的上下文消息没有变化。
        </div>
      )}
    </div>
  )
}

function DetailBlock({
  label,
  text,
  tone
}: {
  label: string
  text: string
  tone?: 'before'
}) {
  return (
    <section>
      <div className={`mb-1 text-[8.5px] uppercase tracking-[.06em] ${tone === 'before' ? 'text-fg-3' : 'text-ok'}`}>
        {label}
      </div>
      <div
        className={`whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 text-[11px] leading-6 ${
          tone === 'before'
            ? 'border-hairline bg-panel text-fg-3'
            : 'border-hairline-strong bg-surface text-fg-2'
        }`}
      >
        {text}
      </div>
    </section>
  )
}

function CompareRow({
  label,
  value,
  tokens,
  current,
  onClick
}: {
  label: string
  value: string
  tokens: number
  current?: boolean
  onClick?: () => void
}) {
  const content = (
    <>
      <span className="w-7 flex-none text-[9px] text-fg-3">{label}</span>
      <span className={`min-w-0 flex-1 truncate rounded-md border px-2 py-1 text-[10px] ${current ? 'border-hairline-strong bg-surface text-fg-1' : 'border-hairline bg-panel text-fg-2'}`}>
        {value}
      </span>
      <span className="w-10 flex-none text-right font-mono text-[9px] text-fg-3">{tokenLabel(tokens)}</span>
    </>
  )
  return onClick ? (
    <button type="button" onClick={onClick} className="flex items-center gap-1 text-left hover:opacity-80">
      {content}
      <span className="flex-none text-[9px] text-fg-3">▾</span>
    </button>
  ) : (
    <div className="flex items-center gap-1">{content}</div>
  )
}

function TokenBar({ label, pct, newPart = 0 }: { label: string; pct: number; newPart?: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-7 flex-none text-[8.5px] text-fg-3">{label}</span>
      <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-sunken">
        <span className="h-full bg-fg-3/55" style={{ width: `${Math.max(0, pct - newPart)}%` }} />
        {newPart > 0 && <span className="h-full bg-ok/70" style={{ width: `${newPart}%` }} />}
      </span>
    </div>
  )
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: 'add' | 'warn' }) {
  return (
    <span className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[8.5px] ${
      tone === 'add'
        ? 'border-ok/30 bg-ok-wash text-ok'
        : tone === 'warn'
          ? 'border-warn/30 bg-warn-wash text-warn'
          : 'border-hairline bg-panel text-fg-3'
    }`}>
      {children}
    </span>
  )
}

function MessageGroup({
  title,
  messages,
  snapshotId,
  onDetail,
  removed,
  modified
}: {
  title: string
  messages: ContextMessageSummary[]
  snapshotId: string
  onDetail: (snapshotId: string, message: ContextMessageSummary) => void
  removed?: boolean
  modified?: boolean
}) {
  const visible = messages.slice(0, 12)
  return (
    <div className="overflow-hidden rounded-lg border border-hairline">
      <div className="flex items-center gap-2 border-b border-hairline bg-panel px-2.5 py-1.5 text-[9.5px] text-fg-3">
        <b className="font-medium text-fg-2">{title}</b>
        <span className="ml-auto font-mono">{messages.length}</span>
      </div>
      {visible.map((message) => (
        <button
          key={message.key}
          type="button"
          onClick={() => onDetail(snapshotId, message)}
          className={`flex w-full items-start gap-1.5 border-t border-hairline px-2.5 py-1.5 text-left text-[9.5px] transition-colors hover:bg-sunken ${removed ? 'bg-danger-wash/30' : modified ? 'bg-warn-wash/30' : 'bg-ok-wash/25'}`}
          title="查看全文"
        >
          <span className={`w-12 flex-none pt-0.5 font-mono text-[8px] ${removed ? 'text-danger' : modified ? 'text-warn' : 'text-ok'}`}>{roleLabel(message.role)}</span>
          <span className="min-w-0 flex-1 overflow-hidden text-fg-2" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
            {message.preview}
          </span>
          <span className="flex-none pt-0.5 font-mono text-[8px] text-fg-3">{tokenLabel(message.tokens)}</span>
        </button>
      ))}
      {messages.length > visible.length && (
        <div className="border-t border-hairline px-2.5 py-1.5 text-[9px] text-fg-3">
          还有 {messages.length - visible.length} 条，已折叠。
        </div>
      )}
    </div>
  )
}

