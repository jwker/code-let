import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AgentInfo } from '@contract/index'
import { UNKNOWN_AGENT_TYPE_LABEL } from '@contract/index'
import { typeDefOf, useStore } from '../store'
import { AgentAvatar } from './AgentAvatar'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'
import { agentMenuState } from './agentMenuItems'
import { useOverlay } from './useOverlay'
import { clampOverlayBox, coversBrowser, leftColumnBounds } from './overlay'

/**
 * agent 头像的右键菜单（PLAN.md D53）。
 *
 * 28px 的头像装不下详细信息，这里是**唯一**能看全「名字 / 类型 / 轮数 / 状态」
 * 又能动手的地方。四项：以此 agent 新建实例、重命名、归档、删除。
 *
 * 归档与删除是两个动作，不合并 —— 归档只改状态、会话文件原地不动，
 * 删除才移到系统废纸篓。运行中不许归档（它显然还有活动），项置灰并说明原因。
 */

/** 菜单打开的锚点 */
export interface AgentMenuAnchor {
  agent: AgentInfo
  /** 视口坐标：菜单贴在按下点右下 */
  x: number
  y: number
}

export function AgentContextMenu({
  anchor,
  onClose,
  onNewInstance,
  onRename,
  onArchive,
  onDelete
}: {
  anchor: AgentMenuAnchor
  onClose: () => void
  onNewInstance: () => void
  onRename: () => void
  onArchive: () => void
  onDelete: () => void
}) {
  const { agent } = anchor
  const agentTypes = useStore((s) => s.agentTypes)
  const agentDef = typeDefOf(agentTypes, agent.type)
  const state = agentMenuState({ streaming: agent.streaming, typeKnown: agentDef !== null })
  const ref = useRef<HTMLDivElement>(null)
  const [pendingDelete, setPendingDelete] = useState(false)

  // 贴边翻转：按在右下角时别把菜单顶出窗口
  const [position, setPosition] = useState({ left: anchor.x, top: anchor.y })

  /*
   * 菜单跟气泡一样贴在窄轨右边，整个落在左列里 —— 只有真的压到
   * 原生浏览器视图时才把它收起来（`.agent-menu` 宽 198px）。
   */
  const browserSpan = useStore((s) => s.browserSpan)
  useOverlay(coversBrowser({ left: position.left, width: 198 }, browserSpan))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 边界是左列，不是窗口 —— 贴着左列右缘弹的菜单不能伸进右栏
    setPosition(clampOverlayBox({ left: anchor.x, top: anchor.y }, rect, leftColumnBounds()))
  }, [anchor.x, anchor.y])

  // 点外面 / Esc 关掉；方向键在项之间移动
  useEffect(() => {
    function onDown(event: MouseEvent): void {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose()
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      // 菜单写着 ⌘D —— 那就得真能用
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        const newInstance = ref.current?.querySelector<HTMLButtonElement>('[data-menu-item]')
        if (newInstance && !newInstance.disabled) {
          onClose()
          onNewInstance()
        }
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? [])
      if (items.length === 0) return
      event.preventDefault()
      const index = items.indexOf(document.activeElement as HTMLButtonElement)
      const next =
        event.key === 'ArrowDown'
          ? items[(index + 1 + items.length) % items.length]
          : items[(index - 1 + items.length) % items.length]
      next?.focus()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose, onNewInstance])

  // 打开就聚焦第一项 —— 键盘能一路走完
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[data-menu-item]')?.focus()
  }, [])

  function run(action: () => void): void {
    onClose()
    action()
  }

  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={`${agent.name} 的菜单`}
        className="agent-menu"
        style={{ left: position.left, top: position.top }}
      >
        <div className="agent-menu-head">
          <span className="agent-menu-avatar">
            <AgentAvatar def={agentDef} size={22} />
          </span>
          <div className="agent-menu-id">
            <div className="agent-menu-name" title={agent.name}>
              {agent.name}
            </div>
            <div className="agent-menu-meta">
              {agentDef?.name ?? UNKNOWN_AGENT_TYPE_LABEL} · {agent.turns} 轮 ·{' '}
              {agent.streaming ? '正在跑' : agent.archivedAt ? '已归档' : '空闲'}
            </div>
          </div>
        </div>

        <MenuItem
          label="以此 agent 新建实例"
          hint="⌘D"
          enabled={state.newInstance.enabled}
          onPick={() => run(onNewInstance)}
        />
        <MenuItem label="重命名" enabled={state.rename.enabled} onPick={() => run(onRename)} />
        <MenuItem
          label="归档"
          enabled={state.archive.enabled}
          reason={state.archive.reason}
          onPick={() => run(onArchive)}
        />
        <div className="agent-menu-sep" />
        <MenuItem
          label="删除（移到废纸篓）"
          danger
          enabled={state.remove.enabled}
          reason={state.remove.reason}
          onPick={() => {
            onClose()
            setPendingDelete(true)
          }}
        />
      </div>

      {pendingDelete && (
        <ConfirmDialog
          title={`删除「${agent.name}」？`}
          body="会话文件会被移到系统废纸篓（可以还原），这个名字和它记的上下文都会从窄轨里消失。"
          warning="要归档（留着以后找回）就选归档，不要选删除"
          confirmText="删除"
          danger
          onCancel={() => setPendingDelete(false)}
          onConfirm={() => {
            setPendingDelete(false)
            onDelete()
          }}
        />
      )}
    </>
  )
}

function MenuItem({
  label,
  hint,
  danger,
  enabled,
  reason,
  onPick
}: {
  label: string
  hint?: string
  danger?: boolean
  enabled: boolean
  reason?: string
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-item
      disabled={!enabled}
      title={reason}
      aria-description={reason}
      onClick={onPick}
      className={['agent-menu-item', danger ? 'is-danger' : ''].join(' ')}
    >
      <span className="agent-menu-label">{label}</span>
      {hint && <span className="agent-menu-hint">{hint}</span>}
      {reason && <span className="agent-menu-reason">{reason}</span>}
    </button>
  )
}

/** 重命名 agent 的对话框 —— 右键菜单和归档列表共用 */
export function RenameAgentDialog({
  agent,
  busy,
  onCancel,
  onConfirm
}: {
  agent: AgentInfo
  busy?: boolean
  onCancel: () => void
  onConfirm: (name: string) => void
}) {
  const agentTypes = useStore((s) => s.agentTypes)
  const agentDef = typeDefOf(agentTypes, agent.type)
  return (
    <PromptDialog
      title="重命名 agent"
      subtitle={[
        `${agentDef?.name ?? UNKNOWN_AGENT_TYPE_LABEL} agent · 只改窄轨里显示的名字`,
        agent.sessionTitle ? `会话名是「${agent.sessionTitle}」` : ''
      ]
        .filter(Boolean)
        .join(' · ')}
      label="名字"
      initialValue={agent.name}
      maxLength={80}
      hint="回车保存，Esc 取消"
      busy={busy}
      validate={(value) => (value ? null : '名字不能为空')}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
