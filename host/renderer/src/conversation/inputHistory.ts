/**
 * 输入历史的翻页状态（GLOSSARY「输入历史」）。
 *
 * 纯函数：不依赖 React，也不依赖消息数据 —— 历史由调用方从已加载的消息里挑出来。
 * 界面只需要判断「这一次按键归不归历史」，然后把返回的文本写回输入框。
 *
 * 约定：
 * - 历史按时间序排，越早越靠前；
 * - `pointer === null` 表示在最底下（没在翻历史），输入框里是草稿槽的内容；
 * - 草稿槽一开始是空串，翻页前输入框里写了一半的话由调用方的 `edit` 意图写进来。
 */

/** 翻页状态：翻到第几条，以及草稿槽里是什么 */
export interface HistoryState {
  /** 历史下标；null = 在最底下（看草稿槽） */
  pointer: number | null
  /** 翻历史之前的草稿，或在历史条目上改过的文本 */
  draft: string
}

/** 一次按键（或编辑）的意图 */
export type HistoryIntent =
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'edit'; text: string }
  /** 回到最底下。`text` 是复位之后输入框里的内容 */
  | { type: 'reset'; text: string }

/** 纯函数的结果：新状态 + 该显示在输入框里的文本 */
export interface HistoryStep extends HistoryState {
  text: string
}

/** 初始状态：在最底下，草稿槽为空 */
export function initialHistoryState(): HistoryState {
  return { pointer: null, draft: '' }
}

/**
 * 走一步。
 *
 * 历史在翻页期间可能变短（切支线、重新加载）——指针越界时收回最新，
 * 不抛错、不返回空文本。
 */
export function stepHistory(
  history: readonly string[],
  state: HistoryState,
  intent: HistoryIntent
): HistoryStep {
  const latest = history.length - 1

  if (intent.type === 'edit') {
    return { pointer: state.pointer, draft: intent.text, text: intent.text }
  }

  if (intent.type === 'reset') {
    return { pointer: null, draft: intent.text, text: intent.text }
  }

  if (history.length === 0) {
    return { pointer: null, draft: state.draft, text: state.draft }
  }

  if (intent.type === 'up') {
    const from = state.pointer === null || state.pointer > latest ? latest + 1 : state.pointer
    const next = Math.max(from - 1, 0)
    return { pointer: next, draft: state.draft, text: history[next] }
  }

  // down
  if (state.pointer === null || state.pointer >= latest) {
    return { pointer: null, draft: state.draft, text: state.draft }
  }
  const next = state.pointer + 1
  return { pointer: next, draft: state.draft, text: history[next] }
}

/** 判断一次 keydown 该不该归历史（不归就交给 textarea 自己） */
export interface HistoryKeyInput {
  key: string
  composing: boolean
  menuOpen: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** 有没有选中一段文本；有选中就让 textarea 处理 */
  selectionCollapsed: boolean
  /** 光标之前还有没有换行（上箭头） */
  newlineBeforeCaret: boolean
  /** 光标之后还有没有换行（下箭头） */
  newlineAfterCaret: boolean
}

/**
 * 按键归属是一条优先级链：输入法 → 下拉菜单 → 修饰键 → 光标边界 → 历史。
 *
 * 前四条命中就立即退出，不往下走。顺序不能换：输入法选字时菜单可能开着，
 * 但真正该拿走按键的是输入法。
 */
export function historyKeyOf(input: HistoryKeyInput): 'up' | 'down' | null {
  if (input.composing) return null
  if (input.menuOpen) return null
  if (input.shiftKey || input.ctrlKey || input.metaKey || input.altKey) return null
  if (!input.selectionCollapsed) return null
  if (input.key === 'ArrowUp') return input.newlineBeforeCaret ? null : 'up'
  if (input.key === 'ArrowDown') return input.newlineAfterCaret ? null : 'down'
  return null
}
