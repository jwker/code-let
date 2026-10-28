import { useMemo, type ReactNode } from 'react'
import type { StreamItem } from '@contract/index'
import { useStore } from '../store'
import { AnsiText } from './AnsiText'
import { Markdown } from './Markdown'
import { useToolOutputs } from './useToolOutputs'

/**
 * 普通模式 · 气泡消息流。
 *
 * 读的是内容流那个数组，跟终端模式读的是同一份（R3）——
 * 这里只决定怎么画：气泡、头像，工具收成一行（名 + 状态 + 命令）。
 *
 * 工具输出默认收起来，点那一行才展开 —— 输出往往很长，全铺开会把对话区撑爆。
 */

type MessageItem = Extract<StreamItem, { kind: 'message' }>
type ToolItem = Extract<StreamItem, { kind: 'tool' }>

const TOOL_LOOK: Record<ToolItem['status'], { icon: string; bg: string; fg: string; line: string }> = {
  running: { icon: '◐', bg: 'var(--accent-wash)', fg: 'var(--accent)', line: 'var(--accent-line)' },
  ok: { icon: '✓', bg: 'var(--ok-wash)', fg: 'var(--ok)', line: 'var(--ok-line)' },
  error: { icon: '✗', bg: 'var(--danger-wash)', fg: 'var(--danger)', line: 'var(--danger-line)' }
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

    // 工具项跟在消息后面 —— 归到那条消息的气泡里
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
      <MessageBubble
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

  return <div className="flex flex-col gap-4 px-5 py-5">{rows}</div>
}

function MessageBubble({
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
  const isUser = item.role === 'user'
  return (
    <div className="flex gap-2.5">
      <span
        className="mt-0.5 grid h-[22px] w-[22px] flex-none place-items-center rounded-full border text-[9.5px] font-bold"
        style={{
          background: isUser ? 'var(--sunken)' : 'var(--accent-wash)',
          borderColor: isUser ? 'var(--hairline)' : 'var(--accent-line)',
          color: isUser ? 'var(--fg-2)' : 'var(--accent)'
        }}
      >
        {isUser ? 'ME' : 'π'}
      </span>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11.5px] font-semibold text-fg-1">
          {isUser ? '你' : 'pi'}
        </div>
        <div className="rounded-md border border-hairline bg-surface px-3 py-2.5">
          <Markdown text={item.text} variant="normal" />
          {streaming && <span className="cursor" />}
          {tools.length > 0 && (
            <div className="mt-2 flex flex-col gap-0.5">
              {tools.map((tool) => (
                <ToolRow
                  key={tool.callId || tool.name}
                  tool={tool}
                  output={outputs.get(tool.callId)}
                  expanded={isExpanded(tool.callId, tool.status === 'running')}
                  onToggle={(expanded) => onToggle(tool.callId, expanded)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
        className="flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-left hover:bg-sunken"
      >
        <span
          className="inline-flex flex-none items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[10.5px]"
          style={{ background: look.bg, borderColor: look.line, color: look.fg }}
        >
          <span>{look.icon}</span>
          <span className="font-semibold">{tool.name}</span>
        </span>
        <span
          className="min-w-0 max-w-[70%] truncate font-mono text-[11px]"
          style={{ color: 'var(--fg-3)' }}
        >
          {tool.label}
        </span>
        <span className="flex-none text-[10px]" style={{ color: 'var(--fg-3)' }}>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {expanded && output !== undefined && (
        <div
          className="mt-1 ml-2 whitespace-pre-wrap break-words border-l-2 pl-2.5 font-mono text-[11px] leading-relaxed"
          style={{ borderColor: 'var(--hairline)', color: 'var(--fg-3)' }}
        >
          <AnsiText text={output} />
        </div>
      )}
    </div>
  )
}

function ToolOutput({ text }: { text: string }) {
  return (
    <div
      className="ml-[30px] whitespace-pre-wrap break-words border-l-2 pl-2.5 font-mono text-[11px] leading-relaxed"
      style={{ borderColor: 'var(--hairline)', color: 'var(--fg-3)' }}
    >
      <AnsiText text={text} />
    </div>
  )
}
