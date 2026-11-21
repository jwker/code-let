import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionTree } from '@contract/index'
import { host } from '../host'
import { useStore } from '../store'
import { IconBranch } from '../shell/icons'
import { ConversationTree } from './ConversationTree'
import { layoutTree } from './treeLayout'
import { treeToRows } from './treeRows'

/**
 * 会话树的入口：一个 26×26 的按钮 + 角标，点开弹窗。
 *
 * 两个位置：
 * - `rail` —— 主区对话左侧圆点轨的顶部（通用 / 开发 agent，对话在区域 6）；
 * - `head` —— 产品 agent 窄栏对话的标题栏（对话在区域 5）。
 *
 * 窄栏里圆点轨整列被藏掉（32–560px 放不下），所以树入口不能长在轨里 ——
 * 那会让产品 agent 连有分叉都打不开弹窗。
 */
export function ConversationTreeEntry({ placement }: { placement: 'rail' | 'head' }) {
  const agentId = useStore((s) => s.snapshot.activeAgentId)
  const cwd = useStore((s) => s.snapshot.session.cwd ?? '')
  const streaming = useStore((s) => (s.snapshot.activeAgentId ? (s.streaming[s.snapshot.activeAgentId] ?? false) : false))
  const requestComposerText = useStore((s) => s.requestComposerText)
  const setTreeBranches = useStore((s) => s.setTreeBranches)

  const [tree, setTree] = useState<SessionTree | null>(null)
  const [open, setOpen] = useState(false)

  const loadTree = useCallback(() => {
    if (!agentId) {
      setTree(null)
      return
    }
    void host.getAgentTree(agentId).then((next) => setTree(next))
  }, [agentId])

  /*
   * 树的刷新时机：换 agent、一轮开始 / 结束（发消息与答复落盘都在两端），
   * 以及切支线 / 加标签之后（弹窗自己回调 `onTreeChanged`）。
   * 流式过程中不拉 —— 每来一个 delta 拉一次会把主进程打爆。
   */
  useEffect(() => {
    loadTree()
  }, [loadTree, streaming])

  const otherBranches = useMemo(
    () => (tree ? layoutTree(tree, treeToRows(tree)).otherBranches : 0),
    [tree]
  )

  // 条数写进 store：圆点轨的显示条件、正文的左槽都要用
  useEffect(() => {
    if (agentId) setTreeBranches(agentId, otherBranches)
  }, [agentId, otherBranches, setTreeBranches])

  if (!agentId) return null

  return (
    <div className={`conv-tree-entry is-${placement}`}>
      <button
        type="button"
        className={`conv-tree-entry-hit${open ? ' is-open' : ''}`}
        title="对话结构"
        aria-label={otherBranches > 0 ? `对话结构，另有 ${otherBranches} 条支线` : '对话结构'}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconBranch size={15} />
        {otherBranches > 0 && <span className="conv-tree-entry-badge">{otherBranches}</span>}
      </button>

      {open && tree && (
        <ConversationTree
          agentId={agentId}
          cwd={cwd}
          tree={tree}
          streaming={streaming}
          onClose={() => setOpen(false)}
          onTreeChanged={loadTree}
          onComposerText={(text) => requestComposerText(agentId, text)}
        />
      )}
    </div>
  )
}
