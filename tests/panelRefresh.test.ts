import { describe, expect, it } from 'vitest'
import { planPanelRefresh } from '../host/renderer/src/shell/panelRefresh'

/**
 * 刷新时清哪些缓存。
 *
 * 只清当前项目里打开过的：已展开目录各一层 + 当前文件正文；别的项目不动。
 * 根目录不在这里算 —— 刷新动作每次都会重读它。
 */
describe('刷新要失效的缓存键', () => {
  const cwd = '/work/project-a'

  it('展开两层：清这两层目录 + 当前文件', () => {
    const plan = planPanelRefresh({
      cwd,
      expandedDirs: ['src', 'src/main'],
      activeFilePath: '/work/project-a/src/main/index.ts'
    })
    expect(plan.treeKeys).toEqual([`${cwd}\u0001src`, `${cwd}\u0001src/main`])
    expect(plan.filePaths).toEqual(['/work/project-a/src/main/index.ts'])
  })

  it('没展开任何目录：只清当前文件（根目录由动作无条件重读）', () => {
    const plan = planPanelRefresh({
      cwd,
      expandedDirs: [],
      activeFilePath: '/work/project-a/README.md'
    })
    expect(plan.treeKeys).toEqual([])
    expect(plan.filePaths).toEqual(['/work/project-a/README.md'])
  })

  it('没有选中文件：不清正文', () => {
    const plan = planPanelRefresh({
      cwd,
      expandedDirs: ['src'],
      activeFilePath: null
    })
    expect(plan.treeKeys).toEqual([`${cwd}\u0001src`])
    expect(plan.filePaths).toEqual([])
  })

  it('只影响当前项目：键里只出现当前 cwd', () => {
    const plan = planPanelRefresh({
      cwd,
      expandedDirs: ['src'],
      activeFilePath: '/work/project-a/src/a.ts'
    })
    for (const key of plan.treeKeys) expect(key.startsWith(`${cwd}\u0001`)).toBe(true)
    expect(plan.filePaths.every((path) => path.startsWith(`${cwd}/`))).toBe(true)
    expect(plan.treeKeys.some((key) => key.includes('/work/project-b'))).toBe(false)
  })

  it('重复的展开项去重，根目录不算展开项', () => {
    const plan = planPanelRefresh({
      cwd,
      expandedDirs: ['src', 'src', ''],
      activeFilePath: null
    })
    expect(plan.treeKeys).toEqual([`${cwd}\u0001src`])
  })

  it('没有当前项目：什么都不清', () => {
    expect(planPanelRefresh({ cwd: '', expandedDirs: ['src'], activeFilePath: '/x' })).toEqual({
      treeKeys: [],
      filePaths: []
    })
  })
})
