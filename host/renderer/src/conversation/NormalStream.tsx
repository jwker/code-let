import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StreamItem } from '@contract/index'
import { useStore } from '../store'
import { AnsiText } from './AnsiText'
import { groupBody } from './groupBody'
import { Markdown } from './Markdown'
import { ReplyMeta } from './ReplyMeta'
import { summarizeTurn, type TurnSummary } from './turnMeta'
import { useToolOutputs } from './useToolOutputs'
import { formatDuration } from './usageFormat'

/**
 * 普通模式 · 聊天流。
 *
 * 读的是内容流那个数组，跟终端模式读的是同一份（R3）——
 * 这里只决定怎么画：用户消息右气泡，助手消息直接铺在内容列上，
 * 工具收成一条灰线（名 + 状态 + 命令）。
 *
 * 一轮里的主次（docs/design/turn-emphasis.html）：
 * - **过程**（中间叙述 + 工具行）默认收成一行「过程 · 4 步 · 12.4s」，点开才展开；
 *   展开后缩进并压一条左侧细线，字号降一级、颜色暗一档
 * - **最终答案**顶格、正文原样，不加任何装饰
 * - 元信息行（复制 / token / 用时）挂在轮末，视觉上归属答案
 *
 * 工具输出默认收起来，点那一行才展开 —— 输出往往很长，全铺开会把对话区撑爆。
 */

type MessageItem = Extract<StreamItem, { kind: 'message' }>
type ToolItem = Extract<StreamItem, { kind: 'tool' }>

const TOOL_LOOK: Record<ToolItem['status'], { icon: string; color: string }> = {
  running: { icon: '◐', color: 'var(--fg-3)' },
  ok: { icon: '✓', color: 'var(--fg-3)' },
  error: { icon: '✗', color: 'var(--danger)' }
}

/** 一轮对话：一条用户消息 + 它后面跟着的全部内容 */
interface Turn {
  key: string
  user: MessageItem | null
  body: StreamItem[]
}

/** 按用户消息切轮 —— 用户消息是唯一的分轮依据 */
function splitTurns(items: readonly StreamItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (item.kind === 'message' && item.role === 'user') {
      current = { key: `turn-${i}`, user: item, body: [] }
      turns.push(current)
      continue
    }
    if (!current) {
      // 会话开头没有用户消息（扩展注入之类）—— 自己起一轮
      current = { key: `turn-${i}`, user: null, body: [] }
      turns.push(current)
    }
    current.body.push(item)
  }

  return turns
}

export function NormalStream({ items, streaming }: { items: StreamItem[]; streaming: boolean }) {
  const { outputs, isExpanded } = useToolOutputs(items)
  const setToolExpanded = useStore((s) => s.setToolExpanded)

  // 有主的输出归工具行 —— 这里只留没主的（理论上不会有）
  const toolIds = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      if (item.kind === 'tool') set.add(item.callId)
    }
    return set
  }, [items])

  const turns = useMemo(() => splitTurns(items), [items])

  return (
    <div className="conv-stream mx-auto flex flex-col gap-7 py-12">
      {turns.map((turn, index) => (
        <TurnRow
          key={turn.key}
          turn={turn}
          outputs={outputs}
          isExpanded={isExpanded}
          onToggle={(callId, expanded) => setToolExpanded(callId, expanded)}
          toolIds={toolIds}
          streaming={streaming && index === turns.length - 1}
        />
      ))}
    </div>
  )
}

/** 一轮：用户气泡 → 过程（可折起）→ 最终答案 → 元信息行 */
function TurnRow({
  turn,
  outputs,
  isExpanded,
  onToggle,
  toolIds,
  streaming
}: {
  turn: Turn
  outputs: Map<string, string>
  isExpanded: (callId: string, running: boolean) => boolean
  onToggle: (callId: string, expanded: boolean) => void
  toolIds: Set<string>
  streaming: boolean
}) {
  const summary = useMemo(() => summarizeTurn(turn.body), [turn.body])

  // 认不出答案（这一轮没有助手正文）—— 原样铺开，不做主次分层
  if (!summary) {
    return (
      <div className="flex flex-col gap-2">
        <UserBubble item={turn.user} />
        <Body
          items={turn.body}
          outputs={outputs}
          isExpanded={isExpanded}
          onToggle={onToggle}
          toolIds={toolIds}
          variant="process"
          streaming={streaming}
        />
      </div>
    )
  }

  const processItems = turn.body.slice(0, summary.answerIndex)
  const answerItem = turn.body[summary.answerIndex]
  const restItems = turn.body.slice(summary.answerIndex + 1)

  return (
    <div className="flex flex-col gap-2">
      <UserBubble item={turn.user} />

      {processItems.length > 0 && (
        <ProcessBlock
          summary={summary}
          items={processItems}
          outputs={outputs}
          isExpanded={isExpanded}
          onToggle={onToggle}
          toolIds={toolIds}
          streaming={streaming}
        />
      )}

      <div className="min-w-0">
        {answerItem.kind === 'message' && (
          <div className="text-[14.5px] leading-[1.9] text-fg-1">
            <Markdown text={answerItem.text} variant="normal" />
            {streaming && restItems.length === 0 && <span className="cursor" />}
          </div>
        )}

        {restItems.length > 0 && (
          <Body
            items={restItems}
            outputs={outputs}
            isExpanded={isExpanded}
            onToggle={onToggle}
            toolIds={toolIds}
            variant="process"
            streaming={streaming}
          />
        )}

        <ReplyMeta summary={summary} streaming={streaming} />
      </div>
    </div>
  )
}

/** 用户气泡（反相深底）—— 没有用户消息时什么也不画 */
function UserBubble({ item }: { item: MessageItem | null }) {
  if (!item) return null
  return (
    <div className="flex flex-col items-start">
      <div className="md-bubble is-inverse max-w-[70%] rounded-[14px] bg-bubble px-3.5 py-2.5 text-[14.5px] leading-[1.65] text-bubble-fg">
        <Markdown text={item.text} variant="normal" />
      </div>
    </div>
  )
}

/**
 * 过程：默认收成一行，点开才展开。
 *
 * 生成中默认展开 —— 实时工具输出要看得见（R4）；一轮结束后自动收起，
 * 让答案落到顶格位置。用户点过就听用户的，不再自动收。
 */
function ProcessBlock({
  summary,
  items,
  outputs,
  isExpanded,
  onToggle,
  toolIds,
  streaming
}: {
  summary: TurnSummary
  items: StreamItem[]
  outputs: Map<string, string>
  isExpanded: (callId: string, running: boolean) => boolean
  onToggle: (callId: string, expanded: boolean) => void
  toolIds: Set<string>
  streaming: boolean
}) {
  const [open, setOpen] = useState(streaming)
  const touched = useRef(false)

  // 生成结束 → 自动收起（用户手动点过就不插手）
  useEffect(() => {
    if (!streaming && !touched.current) setOpen(false)
  }, [streaming])

  function toggle(): void {
    touched.current = true
    setOpen((value) => !value)
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex h-7 w-fit max-w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-sunken"
        title={open ? '收起过程' : '展开过程'}
      >
        {streaming ? (
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-info" />
        ) : (
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-fg-3 opacity-50" />
        )}
        <span className="flex-none text-[11.5px] font-medium text-fg-2">过程</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-fg-3">{describe(summary)}</span>
        {/* 折叠指示放在行尾：整条的重心在左边的「过程」上，箭头在末尾读起来像「末尾还有内容」 */}
        <span className="flex-none text-[12px] leading-none text-fg-3">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-1 border-l-2 border-hairline-strong pl-3">
          <Body
            items={items}
            outputs={outputs}
            isExpanded={isExpanded}
            onToggle={onToggle}
            toolIds={toolIds}
            variant="process"
            streaming={streaming}
          />
        </div>
      )}
    </div>
  )
}

/** 摘要行右边的字：工具次数 · 叙述段数 · 耗时 */
function describe(summary: TurnSummary): string {
  const parts: string[] = []
  if (summary.toolCalls > 0) parts.push(`${summary.toolCalls} 次工具`)
  if (summary.segments > 0) parts.push(`${summary.segments} 段`)
  if (summary.processDurationMs !== undefined) {
    parts.push(formatDuration(summary.processDurationMs))
  }
  return parts.join(' · ')
}

/**
 * 一段内容的画法。
 *
 * variant 决定叙述的排版：`process` 是缩进块里的小一号灰字，
 * `answer` 是正文原样。工具行两处一样。
 */
function Body({
  items,
  outputs,
  isExpanded,
  onToggle,
  toolIds,
  variant,
  streaming
}: {
  items: StreamItem[]
  outputs: Map<string, string>
  isExpanded: (callId: string, running: boolean) => boolean
  onToggle: (callId: string, expanded: boolean) => void
  toolIds: Set<string>
  variant: 'process' | 'answer'
  streaming: boolean
}) {
  const rows: ReactNode[] = []
  const groups = groupBody(items, toolIds)

  for (const [i, row] of groups.entries()) {
    const isLastRow = i === groups.length - 1
    if (row.kind === 'output') {
      rows.push(<ToolOutput key={`out-${i}`} text={row.text} />)
      continue
    }

    if (row.kind === 'tools') {
      rows.push(
        <div key={`tools-${i}`} className="mb-3 last:mb-0 flex flex-col gap-1">
          <ToolList tools={row.tools} outputs={outputs} isExpanded={isExpanded} onToggle={onToggle} />
        </div>
      )
      continue
    }

    const last = isLastRow
    rows.push(
      <div key={`msg-${i}`} className={variant === 'process' ? 'mb-3 last:mb-0' : 'min-w-0'}>
        <div className={variant === 'process' ? 'md-process' : 'text-[14.5px] leading-[1.9] text-fg-1'}>
          <Markdown text={row.item.text} variant="normal" />
          {streaming && last && <span className="cursor" />}
        </div>
        {row.tools.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1">
            <ToolList tools={row.tools} outputs={outputs} isExpanded={isExpanded} onToggle={onToggle} />
          </div>
        )}
      </div>
    )
  }

  return <>{rows}</>
}

function ToolList({
  tools,
  outputs,
  isExpanded,
  onToggle
}: {
  tools: ToolItem[]
  outputs: Map<string, string>
  isExpanded: (callId: string, running: boolean) => boolean
  onToggle: (callId: string, expanded: boolean) => void
}) {
  const [open, setOpen] = useState(false)

  // 单个工具就按原样铺开；多个工具先收成一条摘要，点开再看每一项。
  if (tools.length === 1) {
    const tool = tools[0]
    return (
      <ToolRow
        tool={tool}
        output={outputs.get(tool.callId)}
        expanded={isExpanded(tool.callId, tool.status === 'running')}
        onToggle={(expanded) => onToggle(tool.callId, expanded)}
      />
    )
  }

  const running = tools.some((tool) => tool.status === 'running')
  const hasError = tools.some((tool) => tool.status === 'error')
  const showRows = open || running
  const icon = hasError ? '✗' : running ? '◐' : '✓'
  const color = hasError ? 'var(--danger)' : 'var(--fg-3)'
  const summary = tools
    .map((tool) => (tool.label ? `${tool.name} ${tool.label}` : tool.name))
    .join(' · ')

  return (
    <>
      {(!running || open) && (
        <button
          type="button"
          aria-expanded={showRows}
          onClick={() => setOpen((value) => !value)}
          title={summary}
          className="group flex h-7 w-fit max-w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-sunken"
        >
          <span
            className="grid h-4 w-4 flex-none place-items-center rounded-full border border-hairline text-[9px]"
            style={{ color }}
          >
            {icon}
          </span>
          <span className="min-w-0 max-w-[70%] truncate text-[11.5px] text-fg-2">{summary}</span>
          <span className="flex-none text-[9px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">
            {showRows ? '▾' : '▸'}
          </span>
        </button>
      )}

      {showRows &&
        tools.map((tool) => (
          <div key={tool.callId || tool.name} className="ml-5">
            <ToolRow
              tool={tool}
              output={outputs.get(tool.callId)}
              expanded={isExpanded(tool.callId, tool.status === 'running')}
              onToggle={(expanded) => onToggle(tool.callId, expanded)}
            />
          </div>
        ))}
    </>
  )
}

/** 工具一行：名 + 状态 + 命令。点它展开 / 收起输出。 */
function ToolRow({
  tool,
  output,
  expanded,
  onToggle
}: {
  tool: ToolItem
  output: string | undefined
  expanded: boolean
  onToggle: (expanded: boolean) => void
}) {
  const look = TOOL_LOOK[tool.status]
  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onToggle(!expanded)}
        title={tool.label}
        className="group flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-sunken"
      >
        <span
          className="grid h-4 w-4 flex-none place-items-center rounded-full border border-hairline text-[9px]"
          style={{ color: look.color }}
        >
          {look.icon}
        </span>
        <span className="flex-none text-[11.5px] font-medium text-fg-2">{tool.name}</span>
        <span className="min-w-0 max-w-[60%] truncate font-mono text-[11px] text-fg-3">
          {tool.label}
        </span>
        <span className="ml-auto flex-none text-[9px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && output !== undefined && (
        <div className="mb-1 ml-6 border-l border-hairline pl-3 font-mono text-[11.5px] leading-relaxed text-fg-3">
          <div className="whitespace-pre-wrap break-words">
            <AnsiText text={output} />
          </div>
        </div>
      )}
    </div>
  )
}

function ToolOutput({ text }: { text: string }) {
  return (
    <div className="border-l border-hairline pl-3 font-mono text-[11.5px] leading-relaxed text-fg-3">
      <div className="whitespace-pre-wrap break-words">
        <AnsiText text={text} />
      </div>
    </div>
  )
}
