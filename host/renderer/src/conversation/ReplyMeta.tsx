import { useEffect, useRef, useState } from 'react'
import { host } from '../host'
import { IconCheck, IconCopy } from '../shell/icons'
import type { TurnSummary } from './turnMeta'
import { formatDuration, formatTokens } from './usageFormat'

/** 复制成功后回到「复制」的间隔 */
const COPIED_MS = 1500

/**
 * 一轮对话下方的元信息行（方案 B）。
 *
 * 一个胶囊：左边复制，右边这一轮的 token 与耗时。复制按钮常显。
 *
 * 复制的是**这一轮的最终答案**，过程里的叙述不进去 —— 用户要的是
 * 「AI 最后说了什么」，不是「它一路念叨了什么」。
 */
export function ReplyMeta({ summary, streaming }: { summary: TurnSummary; streaming: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

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
function Elapsed({ stats }: { stats: NonNullable<TurnSummary['stats']> }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const elapsed = stats.startedAt === undefined ? 0 : Math.max(0, now - stats.startedAt)
  return (
    <span className="flex flex-none items-center gap-1.5">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" />
      <span className="font-mono text-[11.5px] text-fg-3">{formatDuration(elapsed)}</span>
    </span>
  )
}
