import { useState } from 'react'
import { AGENT_TYPE_LABEL, type AgentInfo, type ConversationInfo } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { AgentAvatar } from './AgentAvatar'
import { RenameAgentDialog } from './AgentContextMenu'
import { ConfirmDialog } from './ConfirmDialog'
import { PromptDialog } from './PromptDialog'

/**
 * 项目设置（PLAN.md D52）。
 *
 * 区域 5 是分类，区域 6 是内容。这里的项分两种来源：
 * - **应用级**：归档天数、打开控制台窗口 —— 所有项目共用，跟 Git 那种项目级的东西不一样；
 * - **项目级 / 本项目的 agent**：项目路径、移除项目、归档列表。
 *
 * 混在一起会让人以为「归档天数是不是只对这个项目生效」，所以每个分类的标题上
 * 都标了它管到哪儿。
 */

export type SettingsCategory = 'agents' | 'conversations' | 'project'

interface CategoryEntry {
  id: SettingsCategory
  title: string
}

/**
 * 项目设置的分类。
 *
 * **这里只放本项目的设置** —— 应用级的东西（归档天数、控制台入口）在全局设置窗口里。
 * 所以分类行不再需要「本项目 / 所有项目」的注脚：全都是本项目。
 */
export const SETTINGS_PANES: CategoryEntry[] = [
  { id: 'agents', title: '归档的 agent' },
  { id: 'conversations', title: '会话管理' },
  { id: 'project', title: '项目' }
]

/** 区域 5：分类列表 */
export function SettingsList() {
  const category = useStore((s) => s.settingsCategory)
  const setCategory = useStore((s) => s.setSettingsCategory)
  const agents = useStore((s) => s.snapshot.agents)
  const conversations = useStore((s) => s.snapshot.conversations)
  const projectTabs = useStore((s) => s.snapshot.projectTabs)
  const activeProjectTabId = useStore((s) => s.snapshot.activeProjectTabId)
  const cwd = projectTabs.find((tab) => tab.id === activeProjectTabId)?.cwd ?? ''

  const archived = agents.filter((agent) => agent.archivedAt !== null && agent.cwd === cwd)

  // 会话管理那个分类上直接显示「这个项目有多少条会话」
  const conversationCount = conversations.filter((item) => item.cwd === cwd).length

  return (
    <div className="settings-list">
      {SETTINGS_PANES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-current={category === entry.id}
          onClick={() => setCategory(entry.id)}
          className={['settings-list-row', category === entry.id ? 'is-active' : ''].join(' ')}
          title={entry.title}
        >
          <span className="settings-list-title">{entry.title}</span>
          {entry.id === 'agents' && archived.length > 0 && (
            <span className="settings-list-count">{archived.length}</span>
          )}
          {/* 这个项目一共多少条会话 */}
          {entry.id === 'conversations' && conversationCount > 0 && (
            <span className="settings-list-count">{conversationCount}</span>
          )}
        </button>
      ))}
    </div>
  )
}

/** 区域 6：内容 */
export function SettingsBody() {
  const category = useStore((s) => s.settingsCategory)
  const agents = useStore((s) => s.snapshot.agents)
  const projectTabs = useStore((s) => s.snapshot.projectTabs)
  const activeProjectTabId = useStore((s) => s.snapshot.activeProjectTabId)
  const tab = projectTabs.find((item) => item.id === activeProjectTabId) ?? null
  const cwd = tab?.cwd ?? ''

  if (category === 'agents') return <ArchiveList agents={agents.filter((agent) => agent.cwd === cwd)} />
  if (category === 'conversations') return <ConversationList cwd={cwd} />
  return <ProjectPanel cwd={cwd} title={tab?.title ?? ''} />
}

/** 本项目归档的 agent */
function ArchiveList({ agents }: { agents: ReturnType<typeof useStore.getState>['snapshot']['agents'] }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  /** 正在改名的那个 —— 归档的 agent 不在窄轨里，右键不到，所以这里要有入口 */
  const [renaming, setRenaming] = useState<AgentInfo | null>(null)
  const archived = agents.filter((agent) => agent.archivedAt !== null)
  const target = archived.find((agent) => agent.id === pendingDelete) ?? null

  if (archived.length === 0) {
    return (
      <div className="zone6-empty">
        这个项目里没有归档的 agent。
        <br />
        窄轨头像右键 → 归档，那个 agent 会出现在这里 —— 会话文件不动，随时能恢复。
      </div>
    )
  }

  return (
    <div className="settings-body">
      <div className="settings-note">
        归档<strong>只改状态</strong>，会话文件原地不动。恢复就是把它挂回窄轨；删除才移到系统废纸篓。
      </div>

      {archived.map((agent) => (
        <div key={agent.id} className="archive-row">
          <AgentAvatar type={agent.type} size={26} />
          <div className="archive-row-text">
            <div className="archive-row-name">{agent.name}</div>
            <div className="archive-row-meta">
              {AGENT_TYPE_LABEL[agent.type]} · {agent.turns} 轮 ·{' '}
              {agent.archivedAt ? `归档于 ${formatDate(agent.archivedAt)}` : '已归档'}
            </div>
          </div>
          <div className="archive-row-actions">
            <button
              type="button"
              disabled={busy === agent.id}
              title="改这个 agent 的名字"
              onClick={() => setRenaming(agent)}
              className="settings-btn"
            >
              重命名
            </button>
            <button
              type="button"
              disabled={busy === agent.id}
              onClick={() => {
                setBusy(agent.id)
                void host.restoreAgent(agent.id).finally(() => setBusy(null))
              }}
              className="settings-btn is-primary"
            >
              {busy === agent.id ? '恢复中…' : '恢复'}
            </button>
            <button
              type="button"
              disabled={busy === agent.id}
              onClick={() => setPendingDelete(agent.id)}
              className="settings-btn is-danger"
            >
              删除
            </button>
          </div>
        </div>
      ))}

      {renaming && (
        <RenameAgentDialog
          agent={renaming}
          busy={busy === renaming.id}
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            setBusy(renaming.id)
            void host
              .renameAgent(renaming.id, name)
              .finally(() => {
                setBusy(null)
                setRenaming(null)
              })
          }}
        />
      )}

      {target && (
        <ConfirmDialog
          title={`删除「${target.name}」？`}
          body="会话文件会被移到系统废纸篓（可以还原）。要留着以后找回就选恢复。"
          confirmText="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            setPendingDelete(null)
            setBusy(target.id)
            void host.deleteAgent(target.id).finally(() => setBusy(null))
          }}
        />
      )}
    </div>
  )
}

/**
 * 会话管理（PLAN.md D59）。
 *
 * 列这个项目的**全部**会话 —— 不管有没有被 agent 管着。三种操作：
 * - 没有 agent 的给「导入」：给它建一个通用 agent，会话文件不动；
 * - 「改名」：改的是**会话名**（写进会话文件，裸 pi 也看得到），不是窄轨里的 agent 名；
 * - 「删除」：会话文件移到系统废纸篓（可还原）。管着它的 agent 一起消失。
 *
 * 是否已导入是**算出来的**（有没有 agent 的 sessionPath 指向它），
 * 没有单独的一份「已导入」标记 —— 两处各记一次迟早不一致。
 */
function ConversationList({ cwd }: { cwd: string }) {
  const conversations = useStore((s) => s.snapshot.conversations)
  const agents = useStore((s) => s.snapshot.agents)
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<ConversationInfo | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ConversationInfo | null>(null)

  const owned = new Set(
    agents.map((agent) => agent.sessionPath).filter((path): path is string => Boolean(path))
  )
  const items = conversations
    .filter((item) => item.cwd === cwd)
    .sort((a, b) => b.modified.localeCompare(a.modified))

  if (!cwd) return <div className="zone6-empty">没有打开的项目</div>
  if (items.length === 0) {
    return (
      <div className="zone6-empty">
        这个项目里还没有会话。
        <br />
        在终端里用裸 pi 聊出来的会话也会出现在这里（标着「未导入」）。
      </div>
    )
  }

  return (
    <div className="settings-body">
      <div className="settings-note">
        「导入」只是给它建一个通用 agent（会话文件不动）；「改名」改的是<strong>会话名</strong>，
        写进会话文件，裸 pi 也看得到 —— 跟窄轨里那个 agent 名是两回事。
      </div>

      {items.map((item) => (
        <div key={item.path} className="archive-row">
          <div className="archive-row-text">
            <div className="archive-row-name">
              {item.title}
              {!owned.has(item.path) && <span className="conv-tag">未导入</span>}
            </div>
            <div className="archive-row-meta">
              {item.messageCount} 条消息 · {formatDateTime(item.modified)}
            </div>
          </div>
          <div className="archive-row-actions">
            {!owned.has(item.path) && (
              <button
                type="button"
                disabled={busy === item.path}
                onClick={() => {
                  setBusy(item.path)
                  void host.importConversation(item.path).finally(() => setBusy(null))
                }}
                className="settings-btn is-primary"
              >
                {busy === item.path ? '导入中…' : '导入'}
              </button>
            )}
            <button
              type="button"
              disabled={busy === item.path}
              title="改会话名（写进会话文件）"
              onClick={() => setRenaming(item)}
              className="settings-btn"
            >
              改名
            </button>
            <button
              type="button"
              disabled={busy === item.path}
              onClick={() => setPendingDelete(item)}
              className="settings-btn is-danger"
            >
              删除
            </button>
          </div>
        </div>
      ))}

      {renaming && (
        <PromptDialog
          title="重命名会话"
          subtitle="这个名字写进会话文件 —— 裸 pi 和这里看到的都是它。窄轨里的 agent 名不受影响。"
          label="会话名"
          initialValue={renaming.name ?? renaming.title}
          maxLength={80}
          hint="留空会退回首条消息当标题"
          busy={busy === renaming.path}
          onCancel={() => setRenaming(null)}
          onConfirm={(name) => {
            setBusy(renaming.path)
            void host
              .renameConversation(renaming.path, name)
              .finally(() => {
                setBusy(null)
                setRenaming(null)
              })
          }}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title={`删除「${pendingDelete.title}」？`}
          body="会话文件会被移到系统废纸篓（可以还原）。管着它的 agent 也会从窄轨里消失。"
          confirmText="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            setPendingDelete(null)
            setBusy(pendingDelete.path)
            void host
              .deleteConversations([pendingDelete.path])
              .finally(() => setBusy(null))
          }}
        />
      )}
    </div>
  )
}

/** 本项目 *//** 本项目 */
function ProjectPanel({ cwd, title }: { cwd: string; title: string }) {
  const [pendingRemove, setPendingRemove] = useState(false)

  if (!cwd) return <div className="zone6-empty">没有打开的项目</div>

  return (
    <div className="settings-body">
      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-label">{title || cwd.split('/').pop()}</div>
          <div className="settings-row-desc selectable">{cwd}</div>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-text">
          <div className="settings-row-label">从清单里移除</div>
          <div className="settings-row-desc">
            只是这个目录不再出现在 Codelet 的项目清单里。**会话文件一个字节都不动**，
            重新「打开项目」指到同一个目录就回来了。
          </div>
        </div>
        <button type="button" className="settings-btn is-danger" onClick={() => setPendingRemove(true)}>
          移除项目
        </button>
      </div>

      {pendingRemove && (
        <ConfirmDialog
          title="移除这个项目？"
          body="只从清单里去掉，磁盘上的会话文件不受影响。窄轨里这个项目的标签会被关掉。"
          confirmText="移除"
          danger
          onCancel={() => setPendingRemove(false)}
          onConfirm={() => {
            setPendingRemove(false)
            void host.removeProject(cwd)
          }}
        />
      )}
    </div>
  )
}

function formatDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDate(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
