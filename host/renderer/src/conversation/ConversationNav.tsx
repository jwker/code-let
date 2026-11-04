import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { StreamItem } from '@contract/index'
import { navTurnSummary, userTurnsOf } from './conversationTurns'

/**
 * 对话区左侧的圆点导航（PLAN.md D36）。
 *
 * 圆点只对用户输入；间距固定，不随轮次数量变化。轨道放不下时只滚动圆点列表，
 * 展开卡片是列表的兄弟节点，避免被滚动容器裁切。
 */
export function ConversationNav({
  items,
  mode,
  scrollRef,
  onSelectTurn
}: {
  items: StreamItem[]
  mode: 'normal' | 'terminal' | 'html'
  scrollRef: RefObject<HTMLDivElement | null>
  /** 点击圆点：轮次从 1 开始；用来让右侧上下文看这一轮最后两次请求 */
  onSelectTurn?: (turn: number) => void
}) {
  const turns = useMemo(() => userTurnsOf(items), [items])
  // assistant 的增量会不停改变 items；轮次没变时别反复重挂滚动监听
  const turnsKey = turns.map((turn) => `${turn.index}:${turn.text}:${turn.files.join(',')}`).join('\u0000')
  const [active, setActive] = useState<number | null>(null)
  const [hovered, setHovered] = useState<{ index: number; y: number } | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [edges, setEdges] = useState({ top: true, bottom: true })
  const navRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dotRefs = useRef<Array<HTMLButtonElement | null>>([])

  // 滚动时找「已经进入视口上部的最后一条用户消息」
  useEffect(() => {
    const node = scrollRef.current
    if (!node || turns.length < 2 || mode === 'html') return

    function update(): void {
      if (!node) return
      const nodeTop = node.getBoundingClientRect().top
      let current = turns[0]?.index ?? null
      for (const turn of turns) {
        const element = node.querySelector<HTMLElement>(`[data-user-index="${turn.index}"]`)
        if (!element) continue
        const top = element.getBoundingClientRect().top - nodeTop + node.scrollTop
        if (top <= node.scrollTop + 80) current = turn.index
      }
      setActive((previous) => (previous === current ? previous : current))
    }

    node.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(node)
    if (node.firstElementChild) observer.observe(node.firstElementChild)
    update()
    return () => {
      node.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [mode, scrollRef, turnsKey])

  // 轮次多到轨道放不下时，让当前圆点自动滚进轨道可视区
  useEffect(() => {
    if (active === null) return
    const list = listRef.current
    const ordinal = turns.findIndex((turn) => turn.index === active)
    const button = dotRefs.current[ordinal]
    if (!list || !button) return

    const listRect = list.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    const buttonTop = buttonRect.top - listRect.top + list.scrollTop
    const buttonBottom = buttonTop + buttonRect.height
    const viewTop = list.scrollTop
    const viewBottom = viewTop + list.clientHeight
    if (buttonTop < viewTop + 2) {
      list.scrollTop = Math.max(0, buttonTop - 2)
    } else if (buttonBottom > viewBottom - 2) {
      list.scrollTop = buttonBottom - list.clientHeight + 2
    }
  }, [active, turnsKey])

  // 溢出时给上下边缘一点渐隐，并记录是否滚到顶/底（滚动条本身隐藏）
  useEffect(() => {
    const list = listRef.current
    if (!list) return

    function update(): void {
      if (!list) return
      setOverflowing(list.scrollHeight > list.clientHeight + 1)
      setEdges({
        top: list.scrollTop <= 1,
        bottom: list.scrollTop + list.clientHeight >= list.scrollHeight - 1
      })
    }

    list.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(list)
    update()
    return () => {
      list.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [turnsKey])

  if (mode === 'html' || turns.length < 2) return null

  function jump(index: number): void {
    const node = scrollRef.current
    if (!node) return
    const element = node.querySelector<HTMLElement>(`[data-user-index="${index}"]`)
    if (!element) return

    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const top = element.getBoundingClientRect().top - node.getBoundingClientRect().top + node.scrollTop
    node.scrollTo({ top: Math.max(0, top - 20), behavior: calm ? 'auto' : 'smooth' })
    setActive(index)
    setHovered(null)

    if (!calm) {
      element.classList.remove('conv-nav-flash')
      void element.offsetWidth
      element.classList.add('conv-nav-flash')
      window.setTimeout(() => element.classList.remove('conv-nav-flash'), 1000)
    }
  }

  function showCard(index: number, element: HTMLElement): void {
    const nav = navRef.current
    if (!nav) return
    const rect = element.getBoundingClientRect()
    const navRect = nav.getBoundingClientRect()
    setHovered({ index, y: rect.top + rect.height / 2 - navRect.top })
  }

  function onDotKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, ordinal: number): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = event.key === 'ArrowDown' ? ordinal + 1 : ordinal - 1
      dotRefs.current[Math.max(0, Math.min(next, turns.length - 1))]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setHovered(null)
      event.currentTarget.blur()
    }
  }

  const hoveredTurn = hovered ? turns.find((turn) => turn.index === hovered.index) : null
  const hoveredOrdinal = hoveredTurn ? turns.indexOf(hoveredTurn) + 1 : 0

  return (
    <nav
      ref={navRef}
      className="conv-nav"
      aria-label={`对话导航，共 ${turns.length} 轮`}
      onMouseLeave={() => setHovered(null)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHovered(null)
      }}
    >
      {overflowing && (
        <span
          className={`conv-nav-end conv-nav-end-top${edges.top ? ' is-end' : ''}`}
          aria-hidden="true"
        >
          ▲
        </span>
      )}

      <div ref={listRef} className={`conv-nav-list${overflowing ? ' is-overflowing' : ''}`}>
        {turns.map((turn, ordinal) => (
          <div className="conv-nav-item" key={turn.index}>
            <button
              ref={(node) => {
                dotRefs.current[ordinal] = node
              }}
              type="button"
              className="conv-nav-hit"
              aria-label={navTurnSummary(turn, ordinal + 1)}
              aria-current={active === turn.index ? 'true' : undefined}
              onClick={() => {
                jump(turn.index)
                onSelectTurn?.(ordinal + 1)
              }}
              onMouseEnter={(event) => showCard(turn.index, event.currentTarget)}
              onFocus={(event) => showCard(turn.index, event.currentTarget)}
              onKeyDown={(event) => onDotKeyDown(event, ordinal)}
            >
              <span className="conv-nav-dot" />
            </button>
          </div>
        ))}
      </div>

      {overflowing && (
        <span
          className={`conv-nav-end conv-nav-end-bottom${edges.bottom ? ' is-end' : ''}`}
          aria-hidden="true"
        >
          ▼
        </span>
      )}

      {hoveredTurn && hovered && (
        <div
          className="conv-nav-card"
          role="tooltip"
          style={{ '--nav-y': `${hovered.y}px` } as CSSProperties}
        >
          <div className="conv-nav-card-head">
            <span className="conv-nav-num">第 {hoveredOrdinal} 轮</span>
          </div>
          <div className="conv-nav-text">
            {hoveredTurn.text || (hoveredTurn.files.length > 0 ? '（无文字，含附件）' : '（空消息）')}
          </div>
          {hoveredTurn.files.length > 0 && (
            <div className="conv-nav-files" title={hoveredTurn.files.join('\n')}>
              {hoveredTurn.files.length} 个附件
              <span>{hoveredTurn.files[0]}</span>
            </div>
          )}
          <div className="conv-nav-card-foot">
            点击跳转 <kbd>↵</kbd>
          </div>
        </div>
      )}
    </nav>
  )
}
