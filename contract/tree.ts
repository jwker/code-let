/**
 * 会话树的映射 —— Pi 的条目数组 → 界面用的树（GLOSSARY.md「对话结构」）。
 *
 * 这一层保持**条目级**：一行一轮的合并是渲染层的事（`treeToRows`）。
 * 放在这里是因为它只按结构认字段，跟 `./stream.ts` 一个路子 ——
 * pi 的类型只在主进程那边，传进来的是普通 JSON。
 *
 * 纯函数，不 import 任何运行时依赖。
 */

/** 会话树上的节点是哪一种 */
export type SessionNodeKind =
  | 'user' // 用户消息
  | 'assistant' // 助手回复
  | 'branch-summary' // 支线摘要
  | 'compaction' // 上下文压缩
  | 'label' // 标签条目本身
  | 'other' // 工具结果、模型切换等

export interface SessionTreeNode {
  id: string
  parentId: string | null
  kind: SessionNodeKind
  /** 一行摘要，上限 `TREE_PREVIEW_LIMIT` 字 */
  preview: string
  /** ISO 时间串 */
  timestamp: string
  /** 用户给的标签；没有就是 undefined */
  label?: string
  /** 在活动支线上的用户消息：这是第几轮（1 起）；其他节点是 undefined */
  turn?: number
  children: SessionTreeNode[]
}

export interface SessionTree {
  roots: SessionTreeNode[]
  /** 当前叶；会话还没说过话时是 null */
  leafId: string | null
}

/** 切支线的结果（Pi 的 `navigateTree()`） */
export interface TreeNavigateResult {
  /** 用户中途取消，或者 Pi 那边没动 */
  cancelled: boolean
  /** 支线摘要生成到一半被中止 */
  aborted?: boolean
  /** 目标是用户消息时，这条消息的原文 —— 渲染层把它放进输入框 */
  editorText?: string
}

/**
 * 摘要上限（字符）。宿主侧只控制 IPC 体积；树弹窗里回答还要再截到 20 字。
 */
export const TREE_PREVIEW_LIMIT = 120

interface RawBlock {
  type?: string
  text?: string
  name?: string
}

interface RawMessage {
  role?: string
  content?: unknown
  /** 工具结果所属的工具名 */
  toolName?: string
}

interface RawEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  message?: RawMessage
  /** branch_summary / compaction 的摘要 */
  summary?: string
  /** label 条目：标签文字 */
  label?: string
}

/** 条目里的纯文本（content 可能是字符串，也可能是内容块数组） */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content as RawBlock[]) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** 助手消息没有正文时（纯工具调用），用工具名凑一句摘要 */
function toolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const names: string[] = []
  for (const block of content as RawBlock[]) {
    if (block?.type === 'toolCall' && typeof block.name === 'string' && block.name) names.push(block.name)
  }
  return names
}

/** 一行摘要：开头 + 省略号 */
function clip(text: string): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > TREE_PREVIEW_LIMIT ? `${chars.slice(0, TREE_PREVIEW_LIMIT - 1).join('')}…` : chars.join('')
}

/** 条目属于哪一种节点 */
export function nodeKindOf(entry: RawEntry): SessionNodeKind {
  if (entry.type === 'branch_summary') return 'branch-summary'
  if (entry.type === 'compaction') return 'compaction'
  if (entry.type === 'label') return 'label'
  if (entry.type !== 'message') return 'other'
  const role = entry.message?.role
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'other'
}

/** 节点的摘要：用户/助手取正文开头，摘要条目取摘要开头，工具条目取工具名 */
export function previewOf(entry: RawEntry): string {
  const kind = nodeKindOf(entry)
  if (kind === 'user' || kind === 'assistant') {
    const text = textOf(entry.message?.content)
    if (text.trim()) return clip(text)
    const calls = toolCallNames(entry.message?.content)
    return calls.length > 0 ? clip(`调用 ${calls.join('、')}`) : ''
  }
  if (kind === 'branch-summary' || kind === 'compaction') return clip(entry.summary ?? '')
  if (kind === 'label') return clip(entry.label ?? '')
  if (entry.type === 'message' && entry.message?.role === 'toolResult') return clip(entry.message.toolName ?? '')
  return clip(entry.type ?? '')
}

/**
 * 条目数组 → 会话树。
 *
 * - 按 `parentId` 连树；父链断掉的条目当根（Pi 的 `getTree()` 也是这么做的）。
 * - `turn` 只编活动支线上的用户消息：从 `leafId` 沿父链走到根，按根→叶的顺序从 1 起。
 * - 标签由调用方查（`labelOf`）—— 标签是 Pi 的独立条目，最后一次改动才算数，
 *   这条规则在 session manager 里，这里不重复实现。
 */
export function entriesToTree(
  entries: readonly unknown[],
  leafId: string | null,
  labelOf?: (id: string) => string | undefined
): SessionTree {
  const nodes = new Map<string, SessionTreeNode>()
  const parentOf = new Map<string, string | null>()

  for (const raw of entries) {
    const entry = raw as RawEntry | null
    if (!entry || typeof entry.id !== 'string' || !entry.id) continue
    const label = labelOf?.(entry.id)
    nodes.set(entry.id, {
      id: entry.id,
      parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
      kind: nodeKindOf(entry),
      preview: previewOf(entry),
      timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
      ...(label ? { label } : {}),
      children: []
    })
    parentOf.set(entry.id, typeof entry.parentId === 'string' ? entry.parentId : null)
  }

  const roots: SessionTreeNode[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  // 活动支线上这几条用户消息是第几轮
  let turn = 0
  const path: string[] = []
  for (let id = leafId; id && nodes.has(id) && !path.includes(id); id = parentOf.get(id) ?? null) {
    path.push(id)
  }
  for (const id of path.reverse()) {
    const node = nodes.get(id)
    if (node && node.kind === 'user') node.turn = ++turn
  }

  return { roots, leafId: nodes.has(leafId ?? '') ? leafId : null }
}
