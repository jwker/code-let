import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { AgentInfo, ProjectPane } from '@contract/index'
import { typeDefOf, useStore } from '../store'
import { host } from '../host'
import { AgentAvatar } from './AgentAvatar'
import { AppMark } from './AppMark'
import { AgentContextMenu, RenameAgentDialog, type AgentMenuAnchor } from './AgentContextMenu'
import { IconBrowser, IconCode, IconDoc, IconPlus, IconSettings } from './icons'
import { coversBrowser } from './overlay'

/**
 * 窄导航轨（PLAN.md D51）。
 *
 * 三段：
 * 1. 项目功能（代码 / 文档 / 浏览器）
 * 2. agent 列表 —— **只有这一段滚动**
 * 3. 项目设置（钉底）
 *
 * 加号在滚动区**外面**：agent 再多，「新建」也不会被滚走。
 *
 * 只有图标和头像，所以每一项都必须有 `title` —— 悬停才看得见名字（R5）。
 */

const FUNCTIONS: Array<{ key: ProjectPane; label: string; icon: () => ReactElement }> = [
  { key: 'code', label: '代码', icon: IconCode },
  { key: 'docs', label: 'AI 文档', icon: IconDoc },
  { key: 'browser', label: '浏览器', icon: IconBrowser }
]

export function Rail() {
  /** 右键菜单的锚点（null = 关着） */
  const [menu, setMenu] = useState<AgentMenuAnchor | null>(null)
  /** 正在改名的 agent（null = 没开对话框） */
  const [renaming, setRenaming] = useState<AgentInfo | null>(null)
  const [busy, setBusy] = useState(false)
  /** 悬停的 agent —— 气泡要用 fixed 定位，因为窄轨卡片是 overflow: hidden */
  const [tip, setTip] = useState<{ agent: AgentInfo; top: number; left: number } | null>(null)
  const tipTimer = useRef<number | null>(null)
  const pushOverlay = useStore((s) => s.pushOverlay)
  const popOverlay = useStore((s) => s.popOverlay)

  /*
   * 气泡如果会盖住右边的原生浏览器视图，就把它收起来 —— 不然气泡被吃一半。
   *
   * 但只在这个气泡真的压到浏览器上时（区域 5 很窄、或者收起）才收：
   * 气泡最宽 260px，从窄轨右边 64px 起，区域 5 正常宽度时离浏览器还远。
   * 以前不看几何就收，鼠标扫过头像右边的页面会整片消失。
   *
   * 延迟 180ms 才出气泡：鼠标扫过一排头像时不该一路弹气泡。
   */
  const browserSpan = useStore((s) => s.browserSpan)
  const tipOpen = tip !== null
  // `.rail-tip` 的 max-width；按最宽算，宁可在边界上多收一次，也不让气泡被盖住
  const tipCoversBrowser = tip !== null && coversBrowser({ left: tip.left, width: 260 }, browserSpan)
  useEffect(() => {
    if (!tipOpen) return
    pushOverlay(tipCoversBrowser)
    return () => popOverlay(tipCoversBrowser)
  }, [tipOpen, tipCoversBrowser, pushOverlay, popOverlay])

  useEffect(
    () => () => {
      if (tipTimer.current !== null) window.clearTimeout(tipTimer.current)
    },
    []
  )

  /** 排一个气泡：位置现在就量好，出现时不再读布局 */
  function scheduleTip(agent: AgentInfo, element: HTMLElement): void {
    if (tipTimer.current !== null) window.clearTimeout(tipTimer.current)
    const rect = element.getBoundingClientRect()
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null
      setTip({ agent, top: rect.top, left: rect.right + 8 })
    }, 180)
  }

  function hideTip(): void {
    if (tipTimer.current !== null) {
      window.clearTimeout(tipTimer.current)
      tipTimer.current = null
    }
    setTip(null)
  }
  const pane = useStore((s) => s.pane)
  const setPane = useStore((s) => s.setPane)
  const agents = useStore((s) => s.snapshot.agents)
  const agentTypes = useStore((s) => s.agentTypes)
  const activeAgentId = useStore((s) => s.snapshot.activeAgentId)
  const projectTabs = useStore((s) => s.snapshot.projectTabs)
  const activeProjectTabId = useStore((s) => s.snapshot.activeProjectTabId)

  /** 当前标签对应的项目 —— 窄轨是项目级的，下面所有东西都围着它 */
  const activeProjectTab = projectTabs.find((tab) => tab.id === activeProjectTabId) ?? projectTabs[0] ?? null
  const cwd = activeProjectTab?.cwd ?? ''

  /*
   * **只列当前项目的 agent**（D51：标签是项目，窄轨是项目级导航）。
   *
   * 不按 cwd 过滤的话，几个项目一开就会混在一起 —— 点一个别的项目的头像，
   * 还会把那个项目的标签顶成活动，看起来像「跳项目」。
   * 归档的同样不列，从设置里恢复（D53）。
   */
  const visible = agents.filter((agent) => agent.archivedAt === null && agent.cwd === cwd)

  /**
   * 点项目级入口。
   *
   * 两处都要写：渲染层的 `pane`（现在看什么）和项目标签上的 `pane`（下次切回来还看这个）。
   * 只写前者的话，切到别的项目再切回来就回默认入口了（R34）。
   */
  function pickFunction(key: ProjectPane): void {
    setPane(key)
    if (activeProjectTab) void host.setPane(activeProjectTab.id, key)
  }

  async function pickAgent(agentId: string): Promise<void> {
    setPane('agent')
    await host.activateAgent(agentId)
  }

  /**
   * 新建 agent：打开对话框，不直接建。
   *
   * 以前这里是「直接建一个通用 agent」—— 三个入口（这里、`/new`、项目设置）
   * 三种行为。现在统一走 `requestNewConversation`，由 App 渲染同一个对话框。
   */
  function newAgent(): void {
    if (!cwd) return
    useStore.getState().requestNewConversation(cwd)
  }

  return (
    <nav className="shell-card rail" aria-label="项目导航">
      {/*
        logo 在功能区上面。32px 的标记配 12px 的左右内边距（56 - 32）/ 2，
        跟窄轨自己 12px 的上下内边距一致 —— 左、右、上三边的间距相同。
      */}
      <div className="rail-brand">
        <AppMark size={32} />
      </div>

      <div className="rail-zone">
        {FUNCTIONS.map((entry) => {
          const IconComponent = entry.icon
          const active = pane === entry.key
          return (
            <button
              key={entry.key}
              type="button"
              title={entry.label}
              aria-label={entry.label}
              aria-current={active}
              onClick={() => pickFunction(entry.key)}
              className="rail-icon"
            >
              <IconComponent />
            </button>
          )
        })}
      </div>

      <div className="rail-sep" />

      <div className="rail-zone rail-agents">
        {visible.map((agent) => {
          const active = pane === 'agent' && agent.id === activeAgentId
          return (
            <button
              key={agent.id}
              type="button"
              aria-label={agent.name}
              aria-current={active}
              onMouseEnter={(event) => scheduleTip(agent, event.currentTarget)}
              onMouseLeave={hideTip}
              onFocus={(event) => scheduleTip(agent, event.currentTarget)}
              onBlur={hideTip}
              onClick={() => void pickAgent(agent.id)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu({ agent, x: event.clientX, y: event.clientY })
              }}
              onKeyDown={(event) => {
                // 键盘也能开菜单：ContextMenu 键，或者 Shift+F10（Windows 的惯例）
                if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                event.preventDefault()
                const rect = event.currentTarget.getBoundingClientRect()
                setMenu({ agent, x: rect.right + 4, y: rect.top })
              }}
              className={['rail-agent', agent.streaming ? 'is-running' : ''].join(' ')}
            >
              <AgentAvatar def={typeDefOf(agentTypes, agent.type)} />
              {/* 同类型的第 2 个起才显示角标 —— 第 1 个不用标 */}
              {agent.instance > 1 && <span className="rail-badge">{agent.instance}</span>}
            </button>
          )
        })}
      </div>

      <div className="rail-zone">
        <button
          type="button"
          title={cwd ? '新建 agent' : '先打开一个项目'}
          aria-label="新建 agent"
          disabled={!cwd}
          onClick={() => void newAgent()}
          className="rail-add"
        >
          <IconPlus />
        </button>
      </div>

      <div className="rail-sep" />

      <div className="rail-zone rail-bottom">
        <button
          type="button"
          title="项目设置"
          aria-label="项目设置"
          aria-current={pane === 'settings'}
          onClick={() => pickFunction('settings')}
          className="rail-icon"
        >
          <IconSettings />
        </button>
      </div>

      {/*
        悬停气泡：第一行 agent 名，第二行小字给会话名。
        两个名字**分开维护**（agent 名是窄轨的，会话名是 Pi 会话文件的），
        不一样的时候这里能一眼看出差别。
      */}
      {tip && (
        <div className="rail-tip" style={{ top: tip.top, left: tip.left }} role="tooltip">
          <div className="rail-tip-name">{tip.agent.name}</div>
          <div className="rail-tip-sub">
            {tip.agent.sessionTitle ? `会话名：${tip.agent.sessionTitle}` : '还没有会话内容'}
          </div>
          {tip.agent.streaming && <div className="rail-tip-state">正在跑</div>}
        </div>
      )}

      {menu && (
        <AgentContextMenu
          anchor={menu}
          onClose={() => setMenu(null)}
          onNewInstance={() => {
            setBusy(true)
            void host
              .newAgentFrom(menu.agent.id)
              .then(() => setPane('agent'))
              .finally(() => setBusy(false))
          }}
          onRename={() => setRenaming(menu.agent)}
          onArchive={() => {
            void host.archiveAgent(menu.agent.id)
          }}
          onDelete={() => {
            void host.deleteAgent(menu.agent.id)
          }}
        />
      )}

      {renaming && (
        <RenameAgentDialog
          agent={renaming}
          busy={busy}
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            setBusy(true)
            void host
              .renameAgent(renaming.id, name)
              .finally(() => {
                setBusy(false)
                setRenaming(null)
              })
          }}
        />
      )}
    </nav>
  )
}
