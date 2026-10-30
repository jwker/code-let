import { useMemo } from 'react'
import type { StreamItem } from '@contract/index'
import { useStore } from '../store'
import { AnsiText } from './AnsiText'
import { Markdown } from './Markdown'
import { useToolOutputs } from './useToolOutputs'

/**
 * 终端模式 · 等宽执行流。
 *
 * 跟普通模式读的是同一个数组（R3），这里只是另一种画法：
 * 不分气泡、不分头像，一行一件事。
 *
 * 工具输出默认收起来，点工具行才展开 —— 输出往往很长，全铺开会把对话区撑爆。
 */

const TOOL_MARK = {
  running: { icon: '◐', color: 'var(--fg-3)' },
  ok: { icon: '✓', color: 'var(--fg-3)' },
  error: { icon: '✗', color: 'var(--danger)' }
} as const

export function TerminalStream({
  items,
  streaming,
  tabId
}: {
  items: StreamItem[]
  streaming: boolean
  tabId: string | null
}) {
  const { outputs, isExpanded } = useToolOutputs(items, tabId)
  const setToolExpanded = useStore((s) => s.setToolExpanded)

  // 有主的输出归工具行 —— 这里只留没主的（理论上不会有）
  const toolIds = useMemo(() => {
    const set = new Set<string>()
    for (const item of items) {
      if (item.kind === 'tool') set.add(item.callId)
    }
    return set
  }, [items])

  return (
    <div className="mx-auto flex w-full max-w-[var(--content-max)] flex-col gap-2 py-10 font-mono text-[12.5px] leading-[1.75]">
      {items.map((item, index) => {
        const last = index === items.length - 1
        switch (item.kind) {
          case 'message': {
            if (item.role === 'user') {
              return (
                <div key={index} className="flex gap-2">
                  <span style={{ color: 'var(--fg-3)' }}>›</span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg-1">
                    {item.text}
                  </span>
                </div>
              )
            }
            if (item.role === 'toolResult') {
              // 输出归它的工具行 —— 没有主的才单列
              if (item.callId && toolIds.has(item.callId)) return null
              return (
                <div key={index} className="flex gap-2">
                  <span style={{ color: 'var(--fg-3)' }}>·</span>
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg-3">
                    <AnsiText text={item.text} />
                  </pre>
                </div>
              )
            }
            return (
              <div key={index} className="flex gap-2">
                <span style={{ color: 'var(--fg-3)' }}>·</span>
                <div className="min-w-0 flex-1">
                  <Markdown text={item.text} variant="terminal" />
                  {streaming && last && <span className="cursor" />}
                </div>
              </div>
            )
          }
          case 'tool': {
            const mark = TOOL_MARK[item.status]
            const expanded = isExpanded(item.callId, item.status === 'running')
            const output = outputs.get(item.callId)
            return (
              <div key={index}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  title={item.label}
                  onClick={() => {
                    if (tabId) setToolExpanded(tabId, item.callId, !expanded)
                  }}
                  className="flex w-full gap-2 rounded-md px-1.5 py-0.5 text-left transition-colors hover:bg-sunken"
                >
                  <span style={{ color: mark.color }}>{mark.icon}</span>
                  <span className="min-w-0 flex-none break-words text-fg-2">{item.name}</span>
                  <span className="min-w-0 max-w-[70%] truncate text-fg-3">{item.label}</span>
                  <span className="flex-none text-fg-3">{expanded ? '▾' : '▸'}</span>
                </button>

                {expanded && output !== undefined && (
                  <div className="flex gap-2 px-1">
                    <span style={{ color: 'var(--fg-3)' }}>·</span>
                    <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg-3">
                      <AnsiText text={output} />
                    </pre>
                  </div>
                )}
              </div>
            )
          }
        }
      })}
    </div>
  )
}
