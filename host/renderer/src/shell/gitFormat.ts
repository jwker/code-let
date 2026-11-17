import type { GitDiffScope, GitStatus } from '@contract/index'

/**
 * 「改动」tab 用到的纯函数。
 *
 * 单独一个文件是为了能在 node 环境里直接测 —— 组件文件会 import store，
 * 而 store 在模块加载时就碰 `localStorage`。
 */

/** 状态字母的色调：新增绿、删除红、改名蓝、其余警告色 */
export function statusTone(status: string): string {
  if (status === 'A' || status === '?') return 'text-ok bg-ok-wash'
  if (status === 'D' || status === 'U') return 'text-danger bg-danger-wash'
  if (status === 'R' || status === 'C') return 'text-info bg-info-wash'
  return 'text-warn bg-warn-wash'
}

/** 把路径拆成「目录前缀 + 文件名」—— 列表里目录降一档灰 */
export function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/')
  return index < 0 ? { dir: '', name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

/** 改动总数 —— 区域 5 的 tab 上要显示它 */
export function changeCount(status: GitStatus | null): number {
  if (!status?.repo) return 0
  return status.staged.length + status.unstaged.length + status.untracked.length + status.conflicts.length
}

/** diff 头部的范围说明 */
export function scopeLabel(scope: GitDiffScope): string {
  if (scope === 'staged') return '相对 HEAD'
  if (scope === 'unstaged') return '相对 index'
  if (scope === 'conflicts') return '冲突'
  return '新文件'
}

/** patch 里加了几行、删了几行 */
export function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return { added, removed }
}
