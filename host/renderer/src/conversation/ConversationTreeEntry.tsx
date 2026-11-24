import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SessionTree } from '@contract/index'
import { host } from '../host'
import { useStore } from '../store'
import { IconBranch } from '../shell/icons'
import { ConversationTree, reasonOf } from './ConversationTree'
import { layoutTree } from './treeLayout'
import { treeToRows } from './treeRows'

/**
 * 会话树的入口：一个 26×26 的按钮 + 角标，点开弹窗。
 *
 * 常驻在对话区左上角，有 agent 就在（零轮、一轮、各种排版都在）。
 *
 * **弹窗一定给反馈**：树还没拉回来时显示正在读取，拉失败了显示原因和重试。
 * 早先只有「树到手」才渲染弹窗，于是拉取一失败（或者还没回来）点按钮就是
 * 「按钮变实心、什么都没发生」—— 用户以为按钮坏了。
 */
export function ConversationTreeEntry() {
  const agentId = useStore((s) => s.snapshot.activeAgentId)
  const cwd = useStore((s) => s.snapshot.session.cwd ?? '')
  const streaming = useStore((s) =>
    s.snapshot.activeAgentId ? (s.streaming[s.snapshot.activeAgentId] ?? false) : false
  )
  const requestComposerText = useStore((s) => s.requestComposerText)
  const setTreeBranches = useStore((s) => s.setTreeBranches)

  const [tree, setTree] = useState<SessionTree | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  /*
   * 读树。失败要记下原因 —— 以前失败是静默的（只 `.then`），
   * 弹窗就永远打不开，界面上一点线索都没有。
   *
   * 已经有树时不显示 loading：一轮结束刷新一次，树不该闪成「正在读取」。
   */
  const loadTree = useCallback(() => {
    if (!agentId) {
      setTree(null)
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    void host
      .getAgentTree(agentId)
      .then((next) => {
        setTree(next)
        setLoading(false)
      })
      .catch((caught: unknown) => {
        setError(reasonOf(caught))
        setLoading(false)
      })
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

  /*
   * 条数写进 store：圆点轨的显示条件要用。
   *
   * **只有树真的加载回来才写** —— 切 agent 的那一瞬 tree 还是空的（或者旧的），
   * 拿它去写会把上一个会话的条数记到新 agent 头上，角标就串了。
   */
  useEffect(() => {
    if (!agentId || !tree) return
    setTreeBranches(agentId, otherBranches)
  }, [agentId, tree, otherBranches, setTreeBranches])

  if (!agentId) return null

  function toggle(): void {
    const next = !open
    setOpen(next)
    // 没树又不在读（首次还没回来，或者上一次失败了）—— 打开时补一次
    if (next && !tree && !loading) loadTree()
  }

  return (
    <div className="conv-tree-entry">
      <button
        type="button"
        className={`conv-tree-entry-hit${open ? ' is-open' : ''}`}
        title="对话结构"
        aria-label={otherBranches > 0 ? `对话结构，另有 ${otherBranches} 条支线` : '对话结构'}
        aria-expanded={open}
        onClick={toggle}
      >
        <IconBranch size={15} />
        {otherBranches > 0 && <span className="conv-tree-entry-badge">{otherBranches}</span>}
      </button>

      {open &&
        (tree ? (
          <ConversationTree
            agentId={agentId}
            cwd={cwd}
            tree={tree}
            streaming={streaming}
            onClose={() => setOpen(false)}
            onTreeChanged={loadTree}
            onComposerText={(text) => requestComposerText(agentId, text)}
          />
        ) : (
          <TreePending
            loading={loading}
            error={error}
            onRetry={loadTree}
            onClose={() => setOpen(false)}
          />
        ))}
    </div>
  )
}

/**
 * 树还没到手时的弹窗 —— 正在读取，或者读失败了带原因和重试。
 *
 * 跟真弹窗共用遮罩、外壳和位置，所以看起来是同一个窗口的两个状态，
 * 不是「有时候弹、有时候不弹」。
 */
function TreePending({
  loading,
  error,
  onRetry,
  onClose
}: {
  loading: boolean
  error: string | null
  onRetry: () => void
  onClose: () => void
}) {
  return (
    <>
      <div className="conv-tree-backdrop left-scope" onClick={onClose} />
      <div className="conv-tree-pop">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="对话结构"
          aria-busy={loading}
          className="conv-tree-panel"
        >
          <div className="conv-tree-head">
            <div className="conv-tree-title">对话结构</div>
            <button type="button" className="conv-tree-close" aria-label="关闭" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="conv-tree-body">
            <div className="conv-tree-empty">
              {loading ? '正在读取会话树…' : `读不到会话树：${error ?? '未知原因'}`}
            </div>
          </div>
          {!loading && error && (
            <div className="conv-tree-foot">
              <button type="button" className="conv-tree-btn is-primary" onClick={onRetry}>
                重试
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
