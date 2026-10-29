import { useMemo, useState, type ReactNode } from 'react'
import type { StreamItem } from '@contract/index'
import { useStore } from '../store'
import { AnsiText } from './AnsiText'
import { Markdown } from './Markdown'
import { useToolOutputs } from './useToolOutputs'

/**
 * 普通模式 · 聊天流。
 *
 * 读的是内容流那个数组，跟终端模式读的是同一份（R3）——
 * 这里只决定怎么画：用户消息右气泡，助手消息直接铺在内容列上，
 * 工具收成一条灰线（名 + 状态 + 命令）。
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

  const rows: ReactNode[] = []
  let index = 0

  while (index < items.length) {
    const item = items[index]

    // 工具项跟在消息后面 —— 归到那条消息下面
    if (item.kind === 'tool') {
      index += 1
      continue
    }

    // 工具输出：归它的工具行
    if (item.role === 'toolResult') {
      if (!item.callId || !toolIds.has(item.callId)) {
        rows.push(<ToolOutput key={`out-${index}`} text={item.text} />)
      }
      index += 1
      continue
    }

    const tools: ToolItem[] = []
    let look = index + 1
    while (look < items.length && items[look].kind === 'tool') {
      tools.push(items[look] as ToolItem)
      look += 1
    }

    rows.push(
      <MessageRow
        key={`msg-${index}`}
        item={item}
        tools={tools}
        outputs={outputs}
        isExpanded={isExpanded}
        onToggle={(callId, expanded) => setToolExpanded(callId, expanded)}
        streaming={streaming && look >= items.length}
      />
    )
    index = look
  }

  return (
    <div className="conv-stream mx-auto flex flex-col gap-7 py-12">
      {rows}
    </div>
  )
}

function MessageRow({
  item,
  tools,
  outputs,
  isExpanded,
  onToggle,
  streaming
}: {
  item: MessageItem
  tools: ToolItem[]
  outputs: Map<string, string>
  isExpanded: (callId: string, running: boolean) => boolean
  onToggle: (callId: string, expanded: boolean) => void
  streaming: boolean
}) {
  if (item.role === 'user') {
    return (
      <div className="flex flex-col items-start gap-2">
        <div className="md-bubble is-inverse max-w-[70%] rounded-[14px] bg-bubble px-3.5 py-2.5 text-[14.5px] leading-[1.65] text-bubble-fg">
          <Markdown text={item.text} variant="normal" />
        </div>
        {tools.length > 0 && (
          <div className="flex w-full flex-col gap-1">
            <ToolList
              tools={tools}
              outputs={outputs}
              isExpanded={isExpanded}
              onToggle={onToggle}
            />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <div className="text-[14.5px] leading-[1.9] text-fg-1">
        <Markdown text={item.text} variant="normal" />
        {streaming && <span className="cursor" />}
      </div>
      {tools.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          <ToolList tools={tools} outputs={outputs} isExpanded={isExpanded} onToggle={onToggle} />
        </div>
      )}
    </div>
  )
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
