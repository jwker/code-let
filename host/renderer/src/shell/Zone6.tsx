import { useEffect } from 'react'
import { ConversationArea } from '../conversation/ConversationArea'

import { agentBrowserHost, PROJECT_BROWSER } from '@contract/browser'
import { typeDefOf, useStore } from '../store'
import { host } from '../host'
import { BrowserPane } from './BrowserPane'
import { ExtensionErrorBanner } from './ExtensionErrorBanner'
import { FilePreview } from './FilePreview'
import { DocView } from './DocView'
import { SettingsBody } from './ProjectSettings'
import { GitDiffView } from './GitDiffView'
import { hasZone5 } from './Zone5'

/**
 * 区域 6 —— 永远在的那一块（PLAN.md D52）。
 *
 * 装什么由窄轨的入口决定：代码是文件预览、文档是文档、浏览器是浏览器、
 * agent 是对话、设置是设置内容。**它不是固定的对话区。**
 */
export function Zone6() {
  const pane = useStore((s) => s.pane)
  const agents = useStore((s) => s.snapshot.agents)
  const activeAgentId = useStore((s) => s.snapshot.activeAgentId)
  const files = useStore((s) => s.snapshot.files)
  const activeFileId = useStore((s) => s.snapshot.activeFileId)
  const change = useStore((s) => s.git.selected)
  const closeChange = useStore((s) => s.closeChange)
  const loadFile = useStore((s) => s.loadFile)
  const activeFile = files.find((file) => file.id === activeFileId) ?? null
  const projectTabs = useStore((s) => s.snapshot.projectTabs)
  const activeProjectTabId = useStore((s) => s.snapshot.activeProjectTabId)
  const cwd = projectTabs.find((tab) => tab.id === activeProjectTabId)?.cwd ?? ''

  const agentTypes = useStore((s) => s.agentTypes)
  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? null
  const agentDef = typeDefOf(agentTypes, activeAgent?.type)
  const zone5 = hasZone5(pane, agentDef)

  /*
   * 活动文件变了就去读它的内容。
   *
   * 这段原来在右侧检视器的 `FilePane` 里，S6 删那个组件时漏搬了 ——
   * 结果文件预览永远停在「加载中」（`FileViewer` 只看 `fileContents` 缓存）。
   * 不能只靠「打开文件」那一步：重启恢复出来的文件没走过 `openFile`，缓存是空的。
   * `loadFile` 自己有缓存判断，重复调无妨。
   */
  useEffect(() => {
    if (!activeFile) return
    void loadFile(activeFile.path, activeFile.cwd)
  }, [activeFile?.path, activeFile?.cwd, loadFile])

  // 选中一个改动时 Esc 回到文件预览 —— 跟原来 Git 面板的手感一致
  useEffect(() => {
    if (!change) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeChange()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [change, closeChange])

  if (pane === 'code') {
    return (
      <main className="shell-card zone6">
        {change ? (
          <GitDiffView />
        ) : (
          <FilePreview
            files={files}
            activeFileId={activeFileId}
            onActivate={(id) => void host.activateFile(id)}
            onClose={(id) => void host.closeFile(id)}
          />
        )}
      </main>
    )
  }

  if (pane === 'browser') {
    return (
      <main className="shell-card zone6">
        {/* 窄轨的浏览器入口 = 项目级宿主 */}
        <BrowserPane host={PROJECT_BROWSER} />
      </main>
    )
  }

  if (pane === 'docs') {
    return (
      <main className="shell-card zone6">
        <DocView cwd={cwd} />
      </main>
    )
  }

  if (pane === 'settings') {
    return (
      <main className="shell-card zone6">
        <SettingsBody />
      </main>
    )
  }

  // pane === 'agent'
  if (agentDef?.id === 'product' && agentDef.builtin && activeAgent) {
    /*
     * 产品 agent：区域 6 是**它自己的**预览宿主（D57）。
     * 项目级浏览器那一套标签跟它没关系 —— agent 的工具也只碰这一套。
     */
    return (
      <main className="shell-card zone6">
        <BrowserPane host={agentBrowserHost(activeAgent.id)} />
      </main>
    )
  }

  return (
    <main className={zone5 ? 'shell-card zone6' : 'shell-card zone6 zone6-wide'}>
      <div className="shell-main">
        <ExtensionErrorBanner />
        <ConversationArea />
      </div>
    </main>
  )
}
