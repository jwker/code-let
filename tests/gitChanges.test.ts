import { describe, expect, it } from 'vitest'
import type { GitStatus } from '@contract/index'
import { changeCount, countPatchLines, scopeLabel, splitPath, statusTone } from '../host/renderer/src/shell/gitFormat'

/**
 * 区域 5 的「改动」tab 用的两个纯函数（PLAN.md D52 / R37）。
 *
 * 只测「算得对不对」：组列表和 diff 的渲染要真 git 仓库，走端到端。
 */

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    repo: true,
    root: '/repo',
    branch: 'main',
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    clean: true,
    truncated: false,
    error: null,
    ...overrides
  }
}

describe('改动总数', () => {
  it('四组都算进去', () => {
    const value = status({
      staged: [{ path: 'a.ts', status: 'M' }],
      unstaged: [{ path: 'b.ts', status: 'M' }, { path: 'c.ts', status: 'D' }],
      untracked: [{ path: 'd.ts', status: '?' }],
      conflicts: [{ path: 'e.ts', status: 'U' }],
      clean: false
    })
    expect(changeCount(value)).toBe(5)
  })

  it('不是仓库、或者是干净的时候是 0', () => {
    expect(changeCount(null)).toBe(0)
    expect(changeCount(status({ repo: false }))).toBe(0)
    expect(changeCount(status())).toBe(0)
  })
})

describe('状态字母的色调', () => {
  it('新增绿、删除红、改名蓝、其余警告色', () => {
    expect(statusTone('A')).toContain('ok')
    expect(statusTone('?')).toContain('ok')
    expect(statusTone('D')).toContain('danger')
    expect(statusTone('U')).toContain('danger')
    expect(statusTone('R')).toContain('info')
    expect(statusTone('C')).toContain('info')
    expect(statusTone('M')).toContain('warn')
  })

  it('diff 头部的范围说明与增删计数', () => {
    expect(scopeLabel('staged')).toBe('相对 HEAD')
    expect(scopeLabel('untracked')).toBe('新文件')
    const counts = countPatchLines('--- a\n+++ b\n+一\n+二\n-三\n 上下文')
    // 文件头的 +++ / --- 不算进增删
    expect(counts).toEqual({ added: 2, removed: 1 })
  })

  it('路径拆成目录与文件名', () => {
    expect(splitPath('src/main/state.ts')).toEqual({ dir: 'src/main/', name: 'state.ts' })
    expect(splitPath('README.md')).toEqual({ dir: '', name: 'README.md' })
  })
})
