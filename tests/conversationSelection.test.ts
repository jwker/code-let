import { describe, expect, it } from 'vitest'
import {
  allSelected,
  clearSelection,
  exitSelection,
  extendSelection,
  groupCheck,
  pruneSelection,
  selectAll,
  setGroupSelection,
  startSelection,
  toggleSelection
} from '../host/renderer/src/shell/conversationSelection'

/**
 * 批量选择（PLAN.md D23）。
 *
 * 选择状态是纯界面状态：勾选、范围、整组、全选、刷新后剔除。
 */

const ORDER = ['a', 'b', 'c', 'd']

describe('选择模式', () => {
  it('进入是空选择，退出清空', () => {
    const started = startSelection()
    expect(started.active).toBe(true)
    expect(started.paths.size).toBe(0)

    const picked = toggleSelection(started, 'a')
    expect(picked.paths.has('a')).toBe(true)

    const exited = exitSelection()
    expect(exited.active).toBe(false)
    expect(exited.paths.size).toBe(0)
  })

  it('勾选与取消，锚点跟着最近一次点击走', () => {
    const first = toggleSelection(startSelection(), 'b')
    expect(first.anchor).toBe('b')
    const second = toggleSelection(first, 'b')
    expect(second.paths.has('b')).toBe(false)
    expect(second.anchor).toBe('b')
  })

  it('范围选择包含两端，不反转已有勾选', () => {
    let selection = toggleSelection(startSelection(), 'a')
    selection = toggleSelection(selection, 'd')
    selection = clearSelection(selection)
    selection = toggleSelection(selection, 'b')

    const ranged = extendSelection(selection, 'd', ORDER)
    expect([...ranged.paths].sort()).toEqual(['b', 'c', 'd'])
    expect(ranged.anchor).toBe('b')
  })

  it('锚点不在可见顺序里 —— 退化成普通勾选', () => {
    // 先选了 c，然后把 c 所在的分组折叠掉 —— 可见顺序里没有 c
    let selection = toggleSelection(startSelection(), 'c')
    selection = clearSelection(selection)
    selection = toggleSelection(selection, 'c')

    const ranged = extendSelection(selection, 'a', ['a', 'b'])
    expect(ranged.paths.has('a')).toBe(true)
    // 退化成普通勾选 —— 锚点跟着新点击的行走
    expect(ranged.anchor).toBe('a')
  })

  it('整组选中 / 取消，折叠组也能整组选中', () => {
    const selected = setGroupSelection(startSelection(), ['a', 'b'], true)
    expect([...selected.paths].sort()).toEqual(['a', 'b'])

    const cleared = setGroupSelection(selected, ['a'], false)
    expect([...cleared.paths]).toEqual(['b'])
  })

  it('全选与清空', () => {
    const all = selectAll(startSelection(), ORDER)
    expect(all.paths.size).toBe(4)
    expect(allSelected(all.paths, ORDER)).toBe(true)

    const none = clearSelection(all)
    expect(none.paths.size).toBe(0)
    expect(none.anchor).toBeNull()
  })

  it('分组勾选状态：none / some / all', () => {
    expect(groupCheck(new Set(), ['a', 'b'])).toBe('none')
    expect(groupCheck(new Set(['a']), ['a', 'b'])).toBe('some')
    expect(groupCheck(new Set(['a', 'b']), ['a', 'b'])).toBe('all')
    expect(groupCheck(new Set(), [])).toBe('none')
  })

  it('刷新后剔除已经不存在的路径，锚点没了置 null', () => {
    const selection = setGroupSelection(startSelection(), ['a', 'b'], true)
    const pruned = pruneSelection(selection, new Set(['b', 'c']))
    expect([...pruned.paths]).toEqual(['b'])
    expect(pruned.anchor).toBeNull()

    // 没有变化时返回原对象 —— React effect 靠这个避免无意义的重渲染
    const stable = pruneSelection(pruned, new Set(['b']))
    expect(stable).toBe(pruned)
  })
})
