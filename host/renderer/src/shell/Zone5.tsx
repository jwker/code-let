import { PANE_LAYOUT, paneLayoutFor } from '@contract/index'
import type { AgentType, ProjectPane } from '@contract/index'
import { useEffect } from 'react'
import { ConversationArea } from '../conversation/ConversationArea'
import { useStore } from '../store'
import { FileTree } from './FileTree'
import { DocsList } from './DocsList'
import { SettingsList } from './ProjectSettings'
import { GitChanges } from './GitChanges'
import { changeCount } from './gitFormat'

/**
 * 区域 5 —— 可选的那一列（PLAN.md D52）。
 *
 * 有没有、多宽由 `PANE_LAYOUT` 决定：代码/文档/设置 268，产品 agent 380，其余没有。
 * **没有区域 5 时这个组件直接不渲染**（由 App 判断），不留一条空列。
 */
/**
 * 代码区的两个 tab：文件 / 改动（PLAN.md D52）。
 *
 * 改动那个带上未提交的数量 —— 不用点进去就知道有没有东西要看。
 */
function CodeTabs() {
  const mode = useStore((s) => s.codeMode)
  const setMode = useStore((s) => s.setCodeMode)
  const status = useStore((s) => s.git.status)
  const count = changeCount(status)

  const tabs: Array<{ key: 'files' | 'changes'; label: string; badge?: number }> = [
    { key: 'files', label: '文件' },
    { key: 'changes', label: '改动', badge: count }
  ]

  return (
    <div className="zone5-seg" role="tablist" aria-label="代码视图">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={mode === tab.key}
          onClick={() => setMode(tab.key)}
          className={['zone5-seg-item', mode === tab.key ? 'is-active' : ''].join(' ')}
        >
          {tab.label}
          {tab.badge ? <span className="zone5-seg-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function Zone5() {
  const pane = useStore((s) => s.pane)
  const mode = useStore((s) => s.codeMode)
  const agents = useStore((s) => s.snapshot.agents)
  const activeAgentId = useStore((s) => s.snapshot.activeAgentId)
  const projectTabs = useStore((s) => s.snapshot.projectTabs)
  const activeProjectTabId = useStore((s) => s.snapshot.activeProjectTabId)

  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? null
  const agentType: AgentType | null = activeAgent?.type ?? null
  // 目录取自**活动项目标签**，不要拿活动 agent 去推 —— 那个可能属于别的项目
  const cwd = projectTabs.find((tab) => tab.id === activeProjectTabId)?.cwd ?? ''

  /*
   * 进「代码」就把 Git 状态读一次 —— 不是等点开「改动」tab 才读。
   *
   * 那个 tab 上要显示未提交的数量；不读的话它是空的，用户不知道有没有东西可看。
   * 列表组件自己也会按 gitRevision 刷新，这里只负责「进来先看一眼」。
   */
  useEffect(() => {
    if (pane !== 'code' || !cwd) return
    void useStore.getState().loadGitStatus(cwd)
  }, [pane, cwd])

  if (pane === 'code') {
    return (
      <aside className="shell-card zone5">
        <div className="zone5-head">
          <span className="zone5-title">代码</span>
          <span className="zone5-meta">{cwd ? cwd.split('/').pop() : '没有项目'}</span>
        </div>
        <CodeTabs />
        <div className="zone5-body">
          {mode === 'changes' ? (
            <GitChanges cwd={cwd} />
          ) : cwd ? (
            <FileTree cwd={cwd} />
          ) : (
            <div className="zone5-empty">先打开一个项目</div>
          )}
        </div>
      </aside>
    )
  }

  if (pane === 'docs') {
    return (
      <aside className="shell-card zone5">
        <div className="zone5-head">
          <span className="zone5-title">AI 文档</span>
          <span className="zone5-meta">{cwd ? cwd.split('/').pop() : '没有项目'}</span>
        </div>
        <div className="zone5-body">
          <DocsList cwd={cwd} />
        </div>
      </aside>
    )
  }

  if (pane === 'settings') {
    return (
      <aside className="shell-card zone5">
        <div className="zone5-head">
          <span className="zone5-title">项目设置</span>
          <span className="zone5-meta">{cwd ? cwd.split('/').pop() : '没有项目'}</span>
        </div>
        <div className="zone5-body">
          <SettingsList />
        </div>
      </aside>
    )
  }

  if (pane === 'agent' && agentType === 'product') {
    /*
     * 产品 agent：区域 5 是**对话**、区域 6 是它自己的预览（D52）。
     *
     * 对话放进 320–560 的窄栏里 —— `shell-main` 本来就是容器查询的容器，
     * 所以 composer 的快捷键说明、模型名这些会自动按宽度收（见 global.css 的 @container）。
     * 另外要收掉左侧那列对话导航点：它要 52px，在窄栏里占掉六分之一。
     */
    return (
      <aside className="shell-card zone5">
        <div className="zone5-head">
          <span className="zone5-title">对话</span>
          <span className="zone5-meta">{activeAgent?.name}</span>
        </div>
        <div className="zone5-body zone5-chat">
          <div className="shell-main">
            <ConversationArea />
          </div>
        </div>
      </aside>
    )
  }

  return null
}

/** 这个入口有没有区域 5 —— App 用它决定要不要渲染整列 */
export function hasZone5(pane: ReturnType<typeof useStore.getState>['pane'], agentType: AgentType | null): boolean {
  return paneLayoutFor(pane, agentType).zone5 !== null
}

/** 这个入口的区域 5 默认宽度 */
export function zone5Default(pane: ProjectPane | 'agent', agentType: AgentType | null): number {
  return paneLayoutFor(pane, agentType).zone5 ?? PANE_LAYOUT.code.zone5 ?? 268
}
