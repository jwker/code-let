import { describe, expect, it } from 'vitest'
import {
  collapseAll,
  expandAll,
  showExpandAll
} from '../host/renderer/src/shell/sidebarCollapse'

const project = (path: string) => ({ path, name: path.split('/').pop() ?? path })

const A = project('/p/a')
const B = project('/p/b')
const C = project('/p/c')

describe('侧栏项目分组的收放', () => {
  it('全部收起 = 清单里每个项目都在收着的集合里', () => {
    expect(collapseAll([A, B, C])).toEqual(new Set(['/p/a', '/p/b', '/p/c']))
  })

  it('全部展开 = 清空集合', () => {
    expect(expandAll().size).toBe(0)
  })

  it('一个都没收着 → 该显示「收起全部项目」', () => {
    expect(showExpandAll([A, B], new Set())).toBe(false)
  })

  it('有一组收着 → 该显示「展开全部项目」（约定一）', () => {
    // 中间态也算「有组收着」：按钮显示的是点下去会做什么
    expect(showExpandAll([A, B], new Set(['/p/a']))).toBe(true)
  })

  it('全都收着 → 还是显示「展开全部项目」', () => {
    expect(showExpandAll([A, B], new Set(['/p/a', '/p/b']))).toBe(true)
  })

  it('清单里没有的项目不算数（已经从清单里移走了）', () => {
    // 收着集合里留着一条已经移走的项目，不影响现在的状态
    expect(showExpandAll([A], new Set(['/p/zzz']))).toBe(false)
  })

  it('一个项目都没有时，不显示收放那一项', () => {
    expect(showExpandAll([], new Set())).toBe(false)
  })
})
