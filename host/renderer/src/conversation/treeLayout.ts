import type { SessionTree, SessionTreeNode } from '@contract/index'
import type { TreeRow } from './treeRows'

/**
 * 树弹窗的图形排版：一行一轮，左边一条主干，别的支线拐进右边的窄缝。
 *
 * 几何按 `.scratch/conversation-tree/spec.md` 的「渲染层：树弹窗」：
 * 主干固定在图形区最左，别的支线每条占 18px 一条竖缝，正文不跟着缩进。
 *
 * 纯函数：给定树和行，输出每一行落在哪条 lane、属于哪条支线。
 */

export const ROW_HEIGHT = 52
export const LANE_WIDTH = 18
export const LANE_LEFT = 13
/** 图形区最小宽度（三条支线的位置）：状态变化时正文不横向跳动 */
export const GUTTER_MIN = 80

/** 图形区宽度：窄缝多了才变宽，但不少于最小宽 */
export function gutterWidth(laneCount: number): number {
  return Math.max(GUTTER_MIN, LANE_LEFT + Math.max(0, laneCount - 1) * LANE_WIDTH + LANE_LEFT)
}

/** 第几条 lane 的竖线在图形区里的 x */
export function laneX(lane: number): number {
  return LANE_LEFT + lane * LANE_WIDTH
}

export interface TreeRowLayout {
  row: TreeRow
  /** 在 rows 里的下标；y 坐标按它算 */
  index: number
  /** 0 = 活动支线（主干）；1 起是别的支线的 lane */
  lane: number
  /** 0 = 活动支线；1 起是支线编号（决定颜色） */
  branch: number
  onPath: boolean
  /** 当前叶在这一行 */
  isLeaf: boolean
  /** lane > 0 时，这条线从哪一行拐出来 */
  forkFrom: number | null
  /** 拐出来的那一行显示的「支线 N」 */
  forkLabel?: string
}

export interface TreeLayout {
  rows: TreeRowLayout[]
  laneCount: number
  /** 活动支线之外的支线条数（角标与标题里的计数） */
  otherBranches: number
}

/**
 * 排一遍整棵树。
 *
 * 规则（与 spec 一致，跟「第一个孩子」无关）：
 * - 活动支线上的那一行，沿活动路径往下走的孩子接着主干；其余孩子拐出去。
 * - 当前叶那一行没有「延续」—— 它的孩子全部拐出去，各算一条支线（叶之后的尾巴）。
 * - 不在活动支线上的行，第一个孩子接着这条支线的线走，其余孩子再拐出去。
 * - 一条 lane 要等它的线结束（子树最后一行）之后才能借给新支线，否则两条线会画在同一个 x 上。
 */
export function layoutTree(tree: SessionTree, rows: readonly TreeRow[]): TreeLayout {
  const rowOfEntry = new Map<string, number>()
  rows.forEach((row, index) => row.entryIds.forEach((id) => rowOfEntry.set(id, index)))

  const leafIndex = tree.leafId ? (rowOfEntry.get(tree.leafId) ?? -1) : -1

  // 每一行的父行：提问条目的父条目落在哪一行
  const parentRows: Array<number | null> = rows.map(() => null)
  const collect = (node: SessionTreeNode, parentEntryId: string | null): void => {
    const rowIndex = rowOfEntry.get(node.id)
    if (rowIndex !== undefined && rows[rowIndex].userId === node.id) {
      parentRows[rowIndex] = parentEntryId ? (rowOfEntry.get(parentEntryId) ?? null) : null
    }
    for (const child of node.children) collect(child, node.id)
  }
  for (const root of tree.roots) collect(root, null)

  const childrenOf: number[][] = rows.map(() => [])
  parentRows.forEach((parent, index) => {
    if (parent !== null && parent < rows.length) childrenOf[parent].push(index)
  })

  // 子树最后一行：lane 什么时候能借出去看它
  const subtreeEnd: number[] = rows.map((_, index) => index)
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    for (const child of childrenOf[index]) subtreeEnd[index] = Math.max(subtreeEnd[index], subtreeEnd[child])
  }

  // 支线编号：整棵树加载时算一次，跟当前叶无关 ——
  // 每个分叉点第一个孩子是延续，后面的孩子依次拿号
  const stableNumber = new Map<number, number>()
  let number = 0
  const numberChildren = (parent: number): void => {
    // 先把同一个分叉点上的兄弟编完，再往下一层走 —— 编号才是「整棵树的顺序」
    childrenOf[parent].forEach((child, position) => {
      if (position > 0) stableNumber.set(child, (number += 1))
    })
    childrenOf[parent].forEach((child) => numberChildren(child))
  }
  rows.forEach((_, index) => {
    if (parentRows[index] === null) numberChildren(index)
  })

  const placed = new Map<number, Omit<TreeRowLayout, 'row' | 'index' | 'onPath' | 'isLeaf'>>()
  const laneEnd: number[] = [Number.POSITIVE_INFINITY]

  const takeLane = (fromRow: number): number => {
    for (let lane = 1; lane < laneEnd.length; lane += 1) {
      if (laneEnd[lane] < fromRow) {
        laneEnd[lane] = Number.POSITIVE_INFINITY
        return lane
      }
    }
    laneEnd.push(Number.POSITIVE_INFINITY)
    return laneEnd.length - 1
  }

  const place = (index: number, lane: number, branch: number, forkFrom: number | null, forkLabel?: string): void => {
    placed.set(index, { lane, branch, forkFrom, ...(forkLabel ? { forkLabel } : {}) })
    const kids = childrenOf[index]
    const onPath = rows[index].turn !== undefined
    // 活动支线上的行只认活动路径上的孩子；不在活动支线上的行认第一个孩子
    const continuation = onPath ? kids.find((kid) => rows[kid].turn !== undefined) : kids[0]

    for (const kid of kids) {
      if (kid === continuation) {
        place(kid, lane, branch, null)
        continue
      }
      const branchNumber = stableNumber.get(kid) ?? (number += 1)
      const kidLane = takeLane(index)
      place(kid, kidLane, branchNumber, index, `支线 ${branchNumber}`)
      laneEnd[kidLane] = subtreeEnd[kid]
    }
  }

  const roots = rows.map((_, index) => index).filter((index) => parentRows[index] === null)
  for (const root of roots) place(root, 0, 0, null)

  const branches = new Set<number>()
  const layoutRows = rows.map((row, index): TreeRowLayout => {
    const spot = placed.get(index) ?? { lane: 0, branch: 0, forkFrom: null }
    const onPath = row.turn !== undefined
    if (!onPath && spot.branch > 0) branches.add(spot.branch)
    return {
      row,
      index,
      lane: spot.lane,
      branch: spot.branch,
      onPath,
      isLeaf: index === leafIndex,
      forkFrom: spot.forkFrom,
      ...(spot.forkLabel ? { forkLabel: spot.forkLabel } : {})
    }
  })

  return {
    rows: layoutRows,
    laneCount: layoutRows.reduce((max, row) => Math.max(max, row.lane + 1), 1),
    otherBranches: branches.size
  }
}
