import { describe, expect, it } from 'vitest'
import { entriesToTree } from '@contract/tree'
import { brief, treeToRows } from '../host/renderer/src/conversation/treeRows'
import { gutterWidth, laneX, layoutTree } from '../host/renderer/src/conversation/treeLayout'

/**
 * 一行一轮的合并，以及树弹窗的 lane 排版。
 *
 * 这两步是纯函数：契约给条目级的树，弹窗里一行是一轮、每条支线占一条窄缝。
 * 规则见 .scratch/conversation-tree/spec.md 的「合并规则」与「渲染层：树弹窗」。
 */

let seq = 0
function user(parentId: string | null, text: string): Record<string, unknown> {
  seq += 1
  return {
    type: 'message',
    id: `u${seq}`,
    parentId,
    timestamp: '2026-11-20T10:00:00.000Z',
    message: { role: 'user', content: text }
  }
}

function assistant(parentId: string | null, text: string): Record<string, unknown> {
  seq += 1
  return {
    type: 'message',
    id: `a${seq}`,
    parentId,
    timestamp: '2026-11-20T10:01:00.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text }] }
  }
}

function other(type: string, parentId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1
  return { type, id: `x${seq}`, parentId, timestamp: '2026-11-20T10:02:00.000Z', ...extra }
}

describe('brief', () => {
  it('最多 20 字，超了截断加省略号', () => {
    expect(brief('短回答')).toBe('短回答')
    expect([...brief('一'.repeat(20))]).toHaveLength(20)
    expect([...brief('一'.repeat(21))]).toHaveLength(20)
    expect(brief('一'.repeat(21)).endsWith('…')).toBe(true)
  })
})

describe('treeToRows', () => {
  it('用户条目 + 紧跟的助手条目合成一行', () => {
    const u = user(null, '第一轮的问题')
    const a = assistant(u.id as string, '第一轮的回答')
    const rows = treeToRows(entriesToTree([u, a], a.id as string))

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: u.id, text: '第一轮的问题', answer: '第一轮的回答' })
    expect(rows[0].leafTargetId).toBe(a.id)
  })

  it('同一轮里有多条助手消息时，摘要取最后一条（用户看到的是最终答案）', () => {
    const u = user(null, '问题')
    const a1 = assistant(u.id as string, '先说一句')
    const a2 = assistant(a1.id as string, '最后说完的答案')
    const rows = treeToRows(entriesToTree([u, a1, a2], a2.id as string))

    expect(rows[0].answer).toBe('最后说完的答案')
    expect(rows[0].leafTargetId).toBe(a2.id)
  })

  it('上一条还没回答就又提问：两条用户条目就是两行', () => {
    const u1 = user(null, '第一条')
    const u2 = user(u1.id as string, '第二条')
    const rows = treeToRows(entriesToTree([u1, u2], u2.id as string))

    expect(rows.map((row) => row.text)).toEqual(['第一条', '第二条'])
    expect(rows.map((row) => row.answer)).toEqual(['', ''])
  })

  it('工具结果、支线摘要、压缩、标签都不单独成行，跟着它所在的那一行', () => {
    const u = user(null, '问题')
    const a = assistant(u.id as string, '回答')
    const tool = other('message', a.id as string, {
      message: { role: 'toolResult', toolName: 'bash', toolCallId: 'c1', content: [] }
    })
    const summary = other('branch_summary', tool.id as string, { fromId: tool.id, summary: '另一条支线的总结' })
    const compaction = other('compaction', summary.id as string, { summary: '压缩', firstKeptEntryId: u.id, tokensBefore: 1 })
    const label = other('label', compaction.id as string, { targetId: u.id, label: '书签' })

    const rows = treeToRows(entriesToTree([u, a, tool, summary, compaction, label], label.id as string))

    expect(rows).toHaveLength(1)
    expect(rows[0].entryIds).toEqual([u.id, a.id, tool.id, summary.id, compaction.id, label.id])
    // 「切到这里」落在这串条目的最后一个上：上下文包含这一轮的结尾
    expect(rows[0].leafTargetId).toBe(label.id)
    expect(rows[0].answer).toBe('回答')
  })

  it('标签贴在行上：提问没有就取这一行里别的条目的', () => {
    const u = user(null, '问题')
    const a = assistant(u.id as string, '回答')
    const labelled = entriesToTree([u, a], a.id as string, (id) => (id === a.id ? '解析边界' : undefined))

    expect(treeToRows(labelled)[0].label).toBe('解析边界')
  })

  it('分叉：各自一行，只有活动支线上的那条带轮次号', () => {
    const root = user(null, '起点')
    const first = assistant(root.id as string, '回答')
    const onPath = user(first.id as string, '留下的问法')
    const offPath = user(first.id as string, '走掉的问法')

    const rows = treeToRows(entriesToTree([root, first, onPath, offPath], onPath.id as string))

    expect(rows.map((row) => row.text)).toEqual(['起点', '留下的问法', '走掉的问法'])
    expect(rows.map((row) => row.turn)).toEqual([1, 2, undefined])
  })

  it('没有用户条目的树不出行', () => {
    expect(treeToRows({ roots: [], leafId: null })).toEqual([])
  })
})

describe('layoutTree', () => {
  /**
   * r ─ a ─ a1 ─ a1c（默认叶在 a1）
   *      └ a2
   *     └ b ─ b1
   *         └ b2
   *
   * 编号按整棵树的先序算：b = 支线 1、a2 = 支线 2、b2 = 支线 3。
   */
  function build(leaf?: 'a1' | 'a2' | 'b') {
    const r = user(null, '起点')
    const a = user(r.id as string, 'A')
    const a1 = user(a.id as string, 'A1')
    const a2 = user(a.id as string, 'A2')
    const a1c = user(a1.id as string, 'A1 之后')
    const b = user(r.id as string, 'B')
    const b1 = user(b.id as string, 'B1')
    const b2 = user(b.id as string, 'B2')
    const entries = [r, a, a1, a2, a1c, b, b1, b2]
    const leafId = leaf === 'a2' ? (a2.id as string) : leaf === 'b' ? (b.id as string) : (a1.id as string)
    return { entries, leafId }
  }

  function layoutOf(leaf?: 'a1' | 'a2' | 'b') {
    const { entries, leafId } = build(leaf)
    const tree = entriesToTree(entries, leafId)
    return layoutTree(tree, treeToRows(tree))
  }

  it('活动路径上的孩子不是第一个孩子时，主干仍然在 lane 0（切支线后主干跟着走）', () => {
    // 叶在 b 这条支线上；b 是根节点的第二个孩子
    const layout = layoutOf('b')
    const active = layout.rows.filter((row) => row.onPath)

    expect(active.map((row) => row.row.text)).toEqual(['起点', 'B'])
    expect(active.every((row) => row.lane === 0)).toBe(true)
    // 主干的最后一截就是当前叶，不是被弃掉的那条路
    expect(active[active.length - 1].isLeaf).toBe(true)
    // 被弃掉的那条（起点 → A）成了别的支线
    const a = layout.rows.find((row) => row.row.text === 'A')
    expect(a?.onPath).toBe(false)
    expect(a?.lane).toBeGreaterThan(0)
  })

  it('当前叶之后的孩子全部拐出去，各算一条支线', () => {
    const layout = layoutOf('a1')
    const after = layout.rows.filter((row) => row.row.text === 'A1 之后')

    expect(after).toHaveLength(1)
    expect(after[0].onPath).toBe(false)
    expect(after[0].lane).toBeGreaterThan(0)
    // 叶之后的尾巴编号接在已有支线后面（已经排到 3）
    expect(after[0].forkLabel).toBe('支线 4')
  })

  it('支线编号跟当前叶无关：A2 一直是支线 2，切过去之后才不叫支线', () => {
    const before = layoutOf('a1').rows.find((row) => row.row.text === 'A2')
    expect(before?.forkLabel).toBe('支线 2')

    // 把叶挪到 A2 上：它成了活动支线，A1 那条变成别的支线
    const moved = layoutOf('a2')
    const a2Row = moved.rows.find((row) => row.row.text === 'A2')
    const a1Row = moved.rows.find((row) => row.row.text === 'A1')

    expect(a2Row?.onPath).toBe(true)
    expect(a2Row?.lane).toBe(0)
    expect(a2Row?.forkLabel).toBeUndefined()
    expect(a1Row?.onPath).toBe(false)
    // A1 原本是「延续」，成了别的支线之后接在后面编号
    expect(a1Row?.branch).toBe(4)
  })

  it('一条 lane 在它的线结束之后可以借给新支线', () => {
    const layout = layoutOf('a1')
    const a2 = layout.rows.find((row) => row.row.text === 'A2')
    const b2 = layout.rows.find((row) => row.row.text === 'B2')

    // A2 那条支线在 B2 分叉之前就结束了，同一列可以再用一次
    expect(a2?.lane).toBe(2)
    expect(b2?.lane).toBe(1)
    expect(a2?.branch).not.toBe(b2?.branch)
  })

  it('图形区宽度随 lane 数变，但有最小宽 —— 状态变化时正文不横跳', () => {
    expect(gutterWidth(1)).toBe(80)
    expect(gutterWidth(3)).toBe(80)
    expect(gutterWidth(5)).toBe(13 + 4 * 18 + 13)
    expect(laneX(0)).toBe(13)
    expect(laneX(2)).toBe(49)
  })

  it('支线计数只数活动支线之外的', () => {
    const layout = layoutOf('a1')
    const offBranches = new Set(layout.rows.filter((row) => !row.onPath).map((row) => row.branch))

    expect(layout.otherBranches).toBe(offBranches.size)
    // A2、B、B2、A1 之后：四条别的支线
    expect(layout.otherBranches).toBe(4)
  })
})
