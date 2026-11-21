import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { host } from './host'
import { ModelPicker } from './shell/ModelPicker'
import { Rail } from './shell/Rail'
import { RightPanel } from './shell/RightPanel'
import { StatusBar } from './shell/StatusBar'
import { TemporaryChat } from './shell/TemporaryChat'
import { TitleBar } from './shell/TitleBar'
import { createBrowserFocusController } from './shell/browserFocus'
import { NewAgentDialog } from './shell/NewAgentDialog'
import { ExtensionErrorBanner } from './shell/ExtensionErrorBanner'
import { SettingsBody, SettingsList } from './shell/ProjectSettings'
import { ConversationArea } from './conversation/ConversationArea'
import {
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  clampRightPanelWidth,
  defaultRightPanelWidth
} from './shell/panelWidth'
import { paneOf, rightPanelOf, useStore } from './store'

/** 窗口变窄 / 变宽 —— 只在用户没拖过右栏时用来重算「窗口的一半」 */
function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    function onResize(): void {
      setWidth(window.innerWidth)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return width
}

/**
 * 应用外壳。
 *
 * ```
 * ┌──────────────────────────┬──────────────┐
 * │ 标题栏                    │ 右栏顶栏      │
 * │ 窄轨 │ 左列（对话 / 设置） │ 功能区        │
 * │ 状态栏                    │              │
 * └──────────────────────────┴──────────────┘
 * ```
 *
 * 左边是应用本身，右边是一条从顶边贯到底边的右栏。右栏收起时左列吃满窗口；
 * 它装什么由项目标签上的 `rightPanel` 决定（切项目再切回来还是原样）。
 */
export function App() {
  const setSnapshot = useStore((s) => s.setSnapshot)
  const applySessionEvents = useStore((s) => s.applySessionEvents)
  const setItems = useStore((s) => s.setItems)
  const theme = useStore((s) => s.theme)
  const snapshot = useStore((s) => s.snapshot)
  const activeAgentId = useStore((s) => s.snapshot.activeAgentId)
  const sessionReady = useStore((s) => s.snapshot.session.ready)
  const agents = useStore((s) => s.snapshot.agents)
  const storedRightWidth = useStore((s) => s.rightPanelWidth)
  const setRightPanelWidth = useStore((s) => s.setRightPanelWidth)
  const pickerAnchor = useStore((s) => s.modelPickerAnchor)
  const models = useStore((s) => s.models)
  const selectModel = useStore((s) => s.selectModel)
  const closeModelPicker = useStore((s) => s.closeModelPicker)
  const currentModel = useStore((s) => s.snapshot.session.model)
  const newConversationRequest = useStore((s) => s.newConversationRequest)
  const consumeNewConversationRequest = useStore((s) => s.consumeNewConversationRequest)
  const [creating, setCreating] = useState(false)

  const shellRef = useRef<HTMLDivElement>(null)
  const windowWidth = useWindowWidth()

  const pane = paneOf(snapshot)
  const rightPanel = rightPanelOf(snapshot)
  // 没拖过就跟窗口一半走；拖过之后固定用拖出来的像素值，窗口缩放不再重算
  const rightWidth = clampRightPanelWidth(
    storedRightWidth ?? defaultRightPanelWidth(windowWidth)
  )

  useEffect(() => {
    // macOS 的红绿灯压在标题栏顶上，躲开它
    document.documentElement.dataset.platform = host.platform
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    // 首屏拉一次快照，之后只收主进程推的
    void host.getSnapshot().then(setSnapshot)
    // 类型定义不在快照里 —— 单独拉一次，改的时候主进程整份推过来
    const { loadAgentTypes, setAgentTypes } = useStore.getState()
    void loadAgentTypes()
    const offTypes = host.onAgentTypesChanged(setAgentTypes)

    const offSnapshot = host.onSnapshot(setSnapshot)
    const offEvents = host.onSessionEvent(applySessionEvents)

    return () => {
      offSnapshot()
      offEvents()
      offTypes()
    }
  }, [setSnapshot, applySessionEvents])

  /*
   * agent 操作浏览器时把右栏开成浏览器。
   *
   * 判定在 browserFocus.ts 里：主进程每次 agent 调浏览器工具就换一份新的活动记录，
   * 渲染进程认出「换了一份」就切过去。用户自己点不触发 —— 那条路不写活动记录。
   */
  useEffect(() => {
    const controller = createBrowserFocusController(() => {
      useStore.getState().focusBrowser()
    })
    const off = host.onBrowserState((state) => controller.handle(state))
    return () => off()
  }, [])

  /**
   * 切 agent 就换内容流（R1 R5）：持久态在 Pi 的会话文件里，宿主不另存一份。
   *
   * **每个 agent 一份**（PLAN.md D58）：内容流按 agent id 存在 store 里，
   * 切回来读内存里那一份 —— 磁盘上的 entries 落后于实时事件，
   * 拿磁盘覆盖回放会丢消息或重排。
   *
   * 只有这个 agent 还没加载过时才去读盘（懒加载的 agener 第一次点开才建 runtime）。
   */
  useEffect(() => {
    if (!activeAgentId) return
    /*
     * runtime 还没建好时 readEntries() 会返回空数组。
     * 等 session.ready 再读，否则空数组会被当成「这个对话没说过话」缓存下来，
     * 之后再也不会重读。
     */
    if (!sessionReady) return
    if (useStore.getState().items[activeAgentId]) return
    let cancelled = false
    void host.getAgentEntries(activeAgentId).then((items) => {
      if (!cancelled) setItems(activeAgentId, items)
    })
    return () => {
      cancelled = true
    }
  }, [activeAgentId, sessionReady, setItems])

  // 宽度写在 shell 的 CSS 变量上，右栏和拖动条共用同一份
  useLayoutEffect(() => {
    const el = shellRef.current
    if (!el) return
    el.style.setProperty('--right-w', `${rightWidth}px`)
  }, [rightWidth])

  const shellClass = ['shell', rightPanel.open ? 'has-right' : ''].filter(Boolean).join(' ')

  return (
    <div ref={shellRef} className={shellClass}>
      <div className="shell-left">
        <TitleBar />
        <div className="shell-deck">
          <Rail />
          <main className="shell-card main">
            {pane === 'settings' ? (
              <div className="settings-pane">
                <div className="settings-nav">
                  <SettingsList />
                </div>
                <div className="settings-content">
                  <SettingsBody />
                </div>
              </div>
            ) : (
              <div className="shell-main">
                <ExtensionErrorBanner />
                <ConversationArea />
              </div>
            )}
          </main>
        </div>
        <StatusBar />
      </div>

      {rightPanel.open && (
        <RightPanel
          panel={rightPanel}
          width={rightWidth}
          minWidth={RIGHT_PANEL_MIN}
          maxWidth={RIGHT_PANEL_MAX}
          defaultWidth={defaultRightPanelWidth(windowWidth)}
          onDrag={(next) => shellRef.current?.style.setProperty('--right-w', `${next}px`)}
          onCommit={(next) => setRightPanelWidth(next)}
        />
      )}

      {/*
        模型选择器：两个入口（状态栏、输入框胶囊）共用这一个浮层。
        锚点是触发控件的视口坐标，统一贴在它上方 —— 两个入口都靠窗口底部。
      */}
      {pickerAnchor && (
        <div
          className="fixed z-[60]"
          style={{
            left: Math.max(8, Math.min(pickerAnchor.left, window.innerWidth - 436)),
            bottom: pickerAnchor.bottom
          }}
        >
          <ModelPicker
            models={models}
            current={currentModel}
            onPick={async (model, persist) => {
              if (activeAgentId) await selectModel(activeAgentId, model.provider, model.id, persist)
            }}
            onClose={closeModelPicker}
          />
        </div>
      )}

      <TemporaryChat />

      {/* 新建对话：先起名，再建 */}
      {newConversationRequest && (
        <NewAgentDialog
          project={newConversationRequest.cwd}
          agents={agents.filter((agent) => agent.cwd === newConversationRequest.cwd)}
          busy={creating}
          onCancel={consumeNewConversationRequest}
          onCreate={({ type, name }) => {
            setCreating(true)
            void host
              .newConversation(newConversationRequest.cwd, name, type)
              .then(() => {
                consumeNewConversationRequest()
              })
              .catch((error) => {
                console.error('新建对话失败:', error)
              })
              .finally(() => setCreating(false))
          }}
        />
      )}
    </div>
  )
}
