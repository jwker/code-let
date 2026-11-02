/**
 * 侧栏的批量选择状态（纯逻辑，好测）。
 *
 * 选择状态是纯界面状态：不进宿主快照、不落盘。组件只管画，
 * 「勾了哪些、范围怎么算、刷新后还剩哪些」全在这里定。
 *
 * 路径是会话文件的绝对路径 —— 侧栏里一条对话的身份。
 */

export interface ConversationSelection {
  /** 是不是在选择模式里 */
  active: boolean
  /** 已选中的会话文件路径 */
  paths: ReadonlySet<string>
  /** 范围选择的锚点 —— 上一次普通点击的行 */
  anchor: string | null
}

export type GroupCheck = 'none' | 'some' | 'all'

/** 进入选择模式 */
export function startSelection(): ConversationSelection {
  return { active: true, paths: new Set(), anchor: null }
}

/** 退出选择模式并清空 */
export function exitSelection(): ConversationSelection {
  return { active: false, paths: new Set(), anchor: null }
}

/** 勾选 / 取消一条 */
export function toggleSelection(state: ConversationSelection, path: string): ConversationSelection {
  if (!state.active) return state
  const paths = new Set(state.paths)
  if (paths.has(path)) paths.delete(path)
  else paths.add(path)
  return { active: true, paths, anchor: path }
}

/**
 * Shift + 点击：从锚点到目标，按可见顺序整段设成选中。
 *
 * 范围包含两端，不反转。锚点不在可见顺序里（比如它所在的分组刚被折叠）
 * 就退化成普通勾选。
 */
export function extendSelection(
  state: ConversationSelection,
  path: string,
  visibleOrder: readonly string[]
): ConversationSelection {
  if (!state.active) return state
  const from = state.anchor ? visibleOrder.indexOf(state.anchor) : -1
  const to = visibleOrder.indexOf(path)
  if (from < 0 || to < 0) return toggleSelection(state, path)

  const start = Math.min(from, to)
  const end = Math.max(from, to)
  const paths = new Set(state.paths)
  for (let i = start; i <= end; i += 1) paths.add(visibleOrder[i])
  return { active: true, paths, anchor: state.anchor }
}

/** 整组选中 / 取消（折叠组也算） */
export function setGroupSelection(
  state: ConversationSelection,
  groupPaths: readonly string[],
  selected: boolean
): ConversationSelection {
  if (!state.active) return state
  const paths = new Set(state.paths)
  for (const path of groupPaths) {
    if (selected) paths.add(path)
    else paths.delete(path)
  }
  return { active: true, paths, anchor: state.anchor }
}

/** 全选当前列表 */
export function selectAll(state: ConversationSelection, allPaths: readonly string[]): ConversationSelection {
  if (!state.active) return state
  return { active: true, paths: new Set(allPaths), anchor: state.anchor }
}

/** 清空勾选，留在选择模式 */
export function clearSelection(state: ConversationSelection): ConversationSelection {
  if (!state.active) return state
  return { active: true, paths: new Set(), anchor: null }
}

/** 勾选是否已经覆盖全部会话 —— 工具条靠它决定显示「全选」还是「清空」 */
export function allSelected(selected: ReadonlySet<string>, allPaths: readonly string[]): boolean {
  return allPaths.length > 0 && allPaths.every((path) => selected.has(path))
}

/** 一个项目分组的勾选状态 —— 半选用 'some' */
export function groupCheck(selected: ReadonlySet<string>, groupPaths: readonly string[]): GroupCheck {
  if (groupPaths.length === 0) return 'none'
  let count = 0
  for (const path of groupPaths) {
    if (selected.has(path)) count += 1
  }
  if (count === 0) return 'none'
  if (count === groupPaths.length) return 'all'
  return 'some'
}

/**
 * 快照刷新后剔掉已经不存在的路径。
 *
 * 没有变化就返回原对象 —— 调用方在 React effect 里用它，返回新对象会触发重渲染。
 */
export function pruneSelection(
  state: ConversationSelection,
  existing: ReadonlySet<string>
): ConversationSelection {
  if (!state.active) return state
  let changed = false
  const paths = new Set<string>()
  for (const path of state.paths) {
    if (existing.has(path)) paths.add(path)
    else changed = true
  }
  const anchor = state.anchor && existing.has(state.anchor) ? state.anchor : null
  if (!changed && anchor === state.anchor) return state
  return { active: true, paths, anchor }
}
