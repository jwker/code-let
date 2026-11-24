import { describe, expect, it } from 'vitest'
import type { SessionTree, SessionTreeNode } from '@contract/index'
import { entriesToTree, nestTree, previewOf, TREE_PREVIEW_LIMIT, treeFromEntries } from '@contract/tree'

/**
 * 会话树是后面所有树操作的基础数据（.scratch/conversation-tree/spec.md）。
 * 这一层保持条目级：一行一轮的合并在渲染层，这里只管形状。
 */

let seq = 0
function entry(type: string, parentId: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1
  return { type, id: `e${seq}`, parentId, timestamp: '2026-11-20T00:00:00.000Z', ...extra }
}

function user(parentId: string | null, text: string): Record<string, unknown> {
  return entry('message', parentId, { message: { role: 'user', content: text } })
}

function assistant(parentId: string | null, text: string): Record<string, unknown> {
  return entry('message', parentId, { message: { role: 'assistant', content: [{ type: 'text', text }] } })
}

/** 把树摊平，方便断言顺序和层级 */
function flat(tree: SessionTree): Array<{ id: string; depth: number; kind: string; turn?: number }> {
  const out: Array<{ id: string; depth: number; kind: string; turn?: number }> = []
  const walk = (node: SessionTreeNode, depth: number): void => {
    out.push({ id: node.id, depth, kind: node.kind, ...(node.turn ? { turn: node.turn } : {}) })
    node.children.forEach((child) => walk(child, depth + 1))
  }
  tree.roots.forEach((root) => walk(root, 0))
  return out
}

describe('entriesToTree', () => {
  it('单条直线：按 parentId 连成一串，用户消息从 1 起编号', () => {
    const u1 = user(null, '第一轮')
    const a1 = assistant(u1.id as string, '回答一')
    const u2 = user(a1.id as string, '第二轮')
    const a2 = assistant(u2.id as string, '回答二')

    const tree = entriesToTree([u1, a1, u2, a2], a2.id as string)

    expect(tree.roots).toHaveLength(1)
    expect(flat(tree)).toEqual([
      { id: u1.id, depth: 0, kind: 'user', turn: 1 },
      { id: a1.id, depth: 1, kind: 'assistant' },
      { id: u2.id, depth: 2, kind: 'user', turn: 2 },
      { id: a2.id, depth: 3, kind: 'assistant' }
    ])
    expect(tree.leafId).toBe(a2.id)
  })

  it('一个分叉：两条用户消息同父，只有活动支线上的那条有轮次号', () => {
    const u1 = user(null, '起点')
    const a1 = assistant(u1.id as string, '回答')
    const onPath = user(a1.id as string, '留下来的问法')
    const offPath = user(a1.id as string, '走掉的问法')

    const tree = entriesToTree([u1, a1, onPath, offPath], onPath.id as string)

    const branch = tree.roots[0].children[0]
    expect(branch.children.map((child) => child.id)).toEqual([onPath.id, offPath.id])
    expect(branch.children[0].turn).toBe(2)
    expect(branch.children[1].turn).toBeUndefined()
  })

  it('两层分叉：支线自己还能再分叉', () => {
    const u1 = user(null, '第一轮')
    const a1 = assistant(u1.id as string, '回答一')
    const b1 = user(a1.id as string, '支线 1')
    const b1a = assistant(b1.id as string, '支线 1 的回答')
    const b2 = user(b1a.id as string, '支线 1 又分出来的')
    const b3 = user(a1.id as string, '支线 2')

    const tree = entriesToTree([u1, a1, b1, b1a, b2, b3], b2.id as string)

    expect(flat(tree)).toEqual([
      { id: u1.id, depth: 0, kind: 'user', turn: 1 },
      { id: a1.id, depth: 1, kind: 'assistant' },
      { id: b1.id, depth: 2, kind: 'user', turn: 2 },
      { id: b1a.id, depth: 3, kind: 'assistant' },
      { id: b2.id, depth: 4, kind: 'user', turn: 3 },
      { id: b3.id, depth: 2, kind: 'user' }
    ])
  })

  it('支线摘要单独是一个节点，摘要进 preview', () => {
    const u1 = user(null, '第一轮')
    const a1 = assistant(u1.id as string, '回答一')
    const summary = entry('branch_summary', a1.id as string, {
      fromId: a1.id,
      summary: '这条支线聊到了解析器的边界情况'
    })
    const next = user(summary.id as string, '接着问')

    const tree = entriesToTree([u1, a1, summary, next], next.id as string)
    const node = tree.roots[0].children[0].children[0]

    expect(node.kind).toBe('branch-summary')
    expect(node.preview).toBe('这条支线聊到了解析器的边界情况')
    // 摘要和压缩条目不是用户消息，不占轮次号
    expect(node.turn).toBeUndefined()
  })

  it('标签由调用方查：labelOf 给什么就贴什么，没有就不带这个字段', () => {
    const u1 = user(null, '被加了书签的一轮')
    const u2 = user(u1.id as string, '没加书签')

    const tree = entriesToTree([u1, u2], u2.id as string, (id) => (id === u1.id ? '解析边界' : undefined))

    expect(tree.roots[0].label).toBe('解析边界')
    expect(tree.roots[0].children[0].label).toBeUndefined()
    expect('label' in tree.roots[0].children[0]).toBe(false)
  })

  it('父链断掉的孤儿条目当根，不丢', () => {
    const u1 = user(null, '第一个根')
    const orphan = user('missing-parent', '父链断了')

    const tree = entriesToTree([u1, orphan], u1.id as string)

    expect(tree.roots.map((root) => root.id)).toEqual([u1.id, orphan.id])
  })

  it('压缩条目不算轮次号，但仍然是树上的节点', () => {
    const u1 = user(null, '压缩前')
    const a1 = assistant(u1.id as string, '回答')
    const compaction = entry('compaction', a1.id as string, {
      summary: '前面的对话被压缩了',
      firstKeptEntryId: u1.id,
      tokensBefore: 1234
    })
    const u2 = user(compaction.id as string, '压缩后')

    const tree = entriesToTree([u1, a1, compaction, u2], u2.id as string)

    expect(flat(tree)).toEqual([
      { id: u1.id, depth: 0, kind: 'user', turn: 1 },
      { id: a1.id, depth: 1, kind: 'assistant' },
      { id: compaction.id, depth: 2, kind: 'compaction' },
      { id: u2.id, depth: 3, kind: 'user', turn: 2 }
    ])
  })

  it('叶指向不存在的条目时，leafId 归零、所有用户消息都没有轮次号', () => {
    const u1 = user(null, '第一轮')

    const tree = entriesToTree([u1], 'nope')

    expect(tree.leafId).toBeNull()
    expect(tree.roots[0].turn).toBeUndefined()
  })

  it('空会话：没有根，也没有叶', () => {
    expect(entriesToTree([], null)).toEqual({ roots: [], leafId: null })
  })

  it('跳过没有 id 的条目，不让它把后面的连接带歪', () => {
    const u1 = user(null, '第一轮')
    const broken = { type: 'message', parentId: u1.id, message: { role: 'assistant', content: '没有 id' } }
    const a1 = assistant(u1.id as string, '有 id 的回答')

    const tree = entriesToTree([u1, broken, a1], a1.id as string)

    expect(flat(tree).map((row) => row.id)).toEqual([u1.id, a1.id])
  })
})

describe('previewOf', () => {
  it('用户消息取正文开头，空白压成一行', () => {
    expect(previewOf({ type: 'message', message: { role: 'user', content: '  第一行\n\n第二行  ' } })).toBe(
      '第一行 第二行'
    )
  })

  it('助手消息只取正文，跳过 thinking 和工具调用', () => {
    expect(
      previewOf({
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: '想一想' },
            { type: 'toolCall', name: 'read' },
            { type: 'text', text: '真正的回答' }
          ]
        }
      })
    ).toBe('真正的回答')
  })

  it('纯工具调用的助手消息用工具名凑一句', () => {
    expect(
      previewOf({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'toolCall', name: 'read' }, { type: 'toolCall', name: 'edit' }] }
      })
    ).toBe('调用 read、edit')
  })

  it('工具结果取工具名', () => {
    expect(
      previewOf({ type: 'message', message: { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: '输出' }] } })
    ).toBe('bash')
  })

  it('超过上限截断加省略号', () => {
    const long = '一'.repeat(TREE_PREVIEW_LIMIT + 10)
    const preview = previewOf({ type: 'message', message: { role: 'user', content: long } })

    expect([...preview]).toHaveLength(TREE_PREVIEW_LIMIT)
    expect(preview.endsWith('…')).toBe(true)
  })
})

describe('跨进程的那份树是扁平的', () => {
  /*
   * Electron 的 contextBridge 不传超过 1000 层的嵌套对象
   * （`recursion depth exceeded`）。一条几千条的会话，父链就有几千层 ——
   * 所以主进程只给节点表，渲染进程自己连。这条用例钉住这个约束。
   */
  it('一条 3000 条的会话：扁平形状没有嵌套，连成树之后层级回来', () => {
    const entries: Array<Record<string, unknown>> = []
    let parentId: string | null = null
    for (let index = 0; index < 3000; index += 1) {
      const id = `e${index}`
      entries.push({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: `第 ${index} 条` } })
      parentId = id
    }

    const flat = treeFromEntries(entries, 'e2999')
    expect(flat.nodes).toHaveLength(3000)
    // 扁平：节点上只有标量字段，没有 children
    expect(flat.nodes.every((node) => !('children' in node))).toBe(true)

    const tree = nestTree(flat)
    let depth = 0
    let node = tree.roots[0]
    while (node) {
      depth += 1
      node = node.children[0]
    }
    expect(tree.roots).toHaveLength(1)
    expect(depth).toBe(3000)
    // 轮次仍然只给活动支线上的用户消息编
    expect(tree.roots[0].turn).toBe(1)
  })

  it('扁平形状能原样还原成一棵树（跟一次到位的 entriesToTree 一致）', () => {
    const user = entry('message', null, { message: { role: 'user', content: '问题' } })
    const answer = entry('message', user.id as string, { message: { role: 'assistant', content: '回答' } })

    const direct = entriesToTree([user, answer], answer.id as string)
    const viaFlat = nestTree(treeFromEntries([user, answer], answer.id as string))

    expect(JSON.stringify(viaFlat)).toBe(JSON.stringify(direct))
  })
})
