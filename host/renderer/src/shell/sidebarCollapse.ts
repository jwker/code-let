import type { ProjectInfo } from '@contract/index'

/**
 * 侧栏项目分组的收放状态 —— 纯逻辑，React 那边只管调用。
 *
 * 存的是**项目路径**（`collapsed` 集合），不是一个布尔：
 * 每个项目各收各的，组头的三角要能单独动。
 */

/** 全部收起：当前清单里的每个项目都进「收着」集合 */
export function collapseAll(projects: readonly ProjectInfo[]): Set<string> {
  return new Set(projects.map((project) => project.path))
}

/** 全部展开：清空集合 */
export function expandAll(): Set<string> {
  return new Set()
}

/**
 * 该显示「展开全部项目」还是「收起全部项目」。
 *
 * **约定一**：有任何一个组收着 → 显示「全部展开」；全都展开着 → 显示「全部收起」。
 * 按钮显示的是点下去会做什么，所以中间态（有的收有的展）算「有组收着」。
 *
 * 一个项目都没有时返回 false —— 那种情况下没有可收放的东西，
 * 那一项干脆不显示（见 Sidebar 里的渲染条件）。
 */
export function showExpandAll(
  projects: readonly ProjectInfo[],
  collapsed: ReadonlySet<string>
): boolean {
  return projects.some((project) => collapsed.has(project.path))
}
