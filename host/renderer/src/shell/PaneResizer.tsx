import { useRef } from 'react'

interface PaneResizerProps {
  /** 缝在哪一侧：left = 左栏右缘，right = 右栏左缘 */
  edge: 'left' | 'right'
  label: string
  /** 当前宽度（px）。拖拽过程中的实时值不走 React，见 onDrag */
  width: number
  min: number
  /** 双击回到这个宽度 */
  defaultWidth: number
  /** 当前窗口下能拖到的最宽 —— 每次按下时现算，窗口变过也不会用到旧上限 */
  ceiling: () => number
  /** 拖拽中每帧调用：只改 DOM 上的宽度变量，不触发渲染 */
  onDrag: (width: number) => void
  /** 松手 / 键盘微调后提交：触发一次渲染并落盘 */
  onCommit: (width: number) => void
}

const STEP = 8
const STEP_LARGE = 32

/**
 * 可拖拽的分隔条：压在栏与栏之间那条 1px 细线上，命中区 9px。
 *
 * 拖拽时直接写宽度变量（App 负责），React 只在这一轮结束时提交一次 ——
 * 逐帧 setState 会让整棵树（含内容流里的 markdown）每帧重渲染。
 */
export function PaneResizer({
  edge,
  label,
  width,
  min,
  defaultWidth,
  ceiling,
  onDrag,
  onCommit
}: PaneResizerProps) {
  const drag = useRef<{
    startX: number
    startWidth: number
    /** 往右拖是变宽还是变窄 */
    sign: 1 | -1
    max: number
    current: number
    shell: Element | null
  } | null>(null)

  function limit(): number {
    return Math.max(min, Math.round(ceiling()))
  }

  function finish(): void {
    const state = drag.current
    if (!state) return
    drag.current = null
    state.shell?.classList.remove('is-resizing')
    document.body.classList.remove('is-pane-resizing')
    onCommit(state.current)
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || drag.current) return
    const max = limit()
    const start = Math.min(Math.max(width, min), max)
    drag.current = {
      startX: event.clientX,
      startWidth: start,
      sign: edge === 'left' ? 1 : -1,
      max,
      current: start,
      shell: event.currentTarget.closest('.shell')
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current.shell?.classList.add('is-resizing')
    document.body.classList.add('is-pane-resizing')
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const state = drag.current
    if (!state) return
    // 左栏越往右越宽，右栏反过来
    const raw = state.startWidth + (event.clientX - state.startX) * state.sign
    const next = Math.min(Math.max(Math.round(raw), min), state.max)
    if (next === state.current) return
    state.current = next
    onDrag(next)
  }

  /** 松手和 pointercancel 都要落一次盘，不然拖到一半丢焦点就卡住了 */
  function onPointerUp(): void {
    finish()
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const back = event.key === 'ArrowLeft'
    const forward = event.key === 'ArrowRight'
    if (!back && !forward) return
    event.preventDefault()
    // 左栏：→ 变宽；右栏：← 变宽
    const grow = edge === 'left' ? 1 : -1
    const step = (back ? -1 : 1) * grow * (event.shiftKey ? STEP_LARGE : STEP)
    const next = Math.min(Math.max(width + step, min), limit())
    if (next !== width) onCommit(next)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={limit()}
      aria-valuenow={width}
      tabIndex={0}
      title={`${label}（双击复位）`}
      className={`shell-grip shell-grip-${edge}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={() => onCommit(Math.min(defaultWidth, limit()))}
      onKeyDown={onKeyDown}
    />
  )
}
