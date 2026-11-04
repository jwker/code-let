import { useEffect, useRef, useState } from 'react'
import { host } from '../host'
import { IconCheck, IconCopy } from '../shell/icons'
import type { TurnSummary } from './turnMeta'
import { formatDuration, formatTokens } from './usageFormat'
import { Thinking } from './Thinking'

/** 复制成功后回到「复制」的间隔 */
const COPIED_MS = 1500

/**
 * 一轮对话下方的元信息行（方案 B）。
 *
 * 生成中只显示走过的秒数；所有循环结束、最终答案输出完之后，才显示复制和 token。
 * 复制的是**这一轮的最终答案**，过程里的叙述不进去。
 */
export function ReplyMeta({
  summary,
  streaming,
  startedAt
}: {
  summary: TurnSummary
  streaming: boolean
  startedAt?: number
}) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  // 还在跑循环：只显示走过的秒数，不显示复制和 token。
  if (streaming) {
    return (
      <div className="mt-3 flex w-fit items-center gap-2 rounded-full border border-hairline bg-panel py-1.5 pl-3 pr-3">
        <Thinking />
        <span className="h-3 w-px flex-none bg-hairline-strong" />
        <Elapsed stats={summary.stats} startedAt={startedAt} showDot={false} />
      </div>
    )
  }

  async function copy(): Promise<void> {
    // 还在生成时答案不完整，不让复制 —— 否则拿到半截
    if (streaming || !summary.answer) return
    try {
      await host.copyText(summary.answer)
    } catch {
      // 剪贴板写不进去（没焦点之类）—— 不当作错误，UI 照旧
      return
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    // mt-3：正文最后一段的下边距被 Markdown 清成 0（.md-bubble .md-p），
    // 胶囊不自己留出间距就贴上去了。设计稿 .meta-b 的 margin-top 是 12px。
    <div className="mt-3 flex w-fit max-w-full flex-wrap items-center gap-2 rounded-full border border-hairline bg-panel py-1 pl-1 pr-3">
      <button
        type="button"
        onClick={() => void copy()}
        disabled={streaming}
        className={`flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] transition-colors ${
          copied
            ? 'text-ok'
            : 'text-fg-2 hover:bg-sunken hover:text-fg-1 disabled:cursor-not-allowed disabled:text-fg-3 disabled:hover:bg-transparent'
        }`}
        title={streaming ? '生成中，完成后再复制' : '复制这条回复'}
      >
        {copied ? <IconCheck /> : <IconCopy />}
        {copied ? '已复制' : '复制'}
      </button>
      {/*
        「已中止」—— 这一轮用户中途停掉了，正文是半截的。
        不放进正文（那会打断这句话本身的阅读，而且半截的话末尾补任何标点
        都是替用户改写），放在这一行的附注位置上。
        虚线框而不是实线：它是个提醒，不是状态徽章。
      */}
      {summary.aborted && (
        <span className="flex flex-none items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-hairline-strong px-2 py-0.5 text-[10.5px] text-fg-2">
          <span className="h-1.5 w-1.5 rounded-[1px] bg-fg-3" aria-hidden="true" />
          已中止
        </span>
      )}
      <Stats summary={summary} streaming={streaming} />
    </div>
  )
}

/** 胶囊右边那行字：生成中是走过的耗时，结束后是 out · cache · 耗时 */
function Stats({ summary, streaming }: { summary: TurnSummary; streaming: boolean }) {
  const stats = summary.stats
  // 没有计量数据（老会话没存 usage）—— 胶囊里只留复制
  if (!stats) return null

  // 耗时还没到 —— 这一轮还在跑，只看走过的秒
  if (stats.durationMs === undefined && streaming) return <Elapsed stats={stats} />

  const parts: string[] = []
  // 输出 token 与缓存命中分两栏（缓存单独标，不并进消耗）
  if (stats.output > 0) parts.push(`${formatTokens(stats.output)} out`)
  if (stats.cacheRead > 0) parts.push(`${formatTokens(stats.cacheRead)} cache`)
  if (stats.durationMs !== undefined) parts.push(formatDuration(stats.durationMs))
  // 什么数都没有 —— 胶囊里只留复制按钮
  if (parts.length === 0) return null

  return (
    <>
      <span className="h-3 w-px flex-none bg-hairline-strong" />
      <span className="min-w-0 break-words font-mono text-[11.5px] text-fg-3">{parts.join(' · ')}</span>
    </>
  )
}

/** 生成中的耗时：按秒走，不按毫秒跳 */
function Elapsed({
  stats,
  startedAt,
  showDot = true
}: {
  stats?: NonNullable<TurnSummary['stats']>
  startedAt?: number
  showDot?: boolean
}) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const start = stats?.startedAt ?? startedAt
  const elapsed = start === undefined ? 0 : Math.max(0, now - start)
  return (
    <span className="flex flex-none items-center gap-1.5">
      {showDot && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />}
      <span className="font-mono text-[11.5px] text-fg-3">{formatDuration(elapsed)}</span>
    </span>
  )
}
