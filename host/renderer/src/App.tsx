import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { host } from './host'
import { ModelPicker } from './shell/ModelPicker'
import { PaneResizer } from './shell/PaneResizer'
import { Rail } from './shell/Rail'
import { StatusBar } from './shell/StatusBar'
import { TemporaryChat } from './shell/TemporaryChat'
import { TitleBar } from './shell/TitleBar'
import { Zone5 } from './shell/Zone5'
import { Zone6 } from './shell/Zone6'
import { createBrowserFocusController } from './shell/browserFocus'
import { NewAgentDialog } from './shell/NewAgentDialog'
import { ZONE5_MAX, ZONE5_MIN, paneLayoutFor } from '@contract/index'
import { useStore } from './store'

/**
 * 应用外壳（PLAN.md D51）。
 *
 * ```
 * 标题栏
 * 窄轨(56) │ 区域 5(可选) │ 区域 6
 * 状态栏
 * ```
 *
 * 右侧检视器已经退场：它原来的东西分别进了区域 5/6（代码、文档）和独立窗口（控制台）。
 * 左侧栏也退场了（D63）：维护单位是 agent，窄轨的头像就是列表，剩下的入口各归各处。
 */
export function App() {
  const setSnapshot = useStore((s) => s.setSnapshot)
  const applySessionEvents = useStore((s) => s.applySessionEvents)
  const setItems = useStore((s) => s.setItems)
  const theme = useStore((s) => s.theme)
  const activeAgentId = useStore((s) => s.snapshot.activeAgentId)
  const sessionReady = useStore((s) => s.snapshot.session.ready)
  const pane = useStore((s) => s.pane)
  const agents = useStore((s) => s.snapshot.agents)
  const zone5Widths = useStore((s) => s.zone5Widths)
  const setZone5Width = useStore((s) => s.setZone5Width)
  const pickerAnchor = useStore((s) => s.modelPickerAnchor)
  const models = useStore((s) => s.models)
  const selectModel = useStore((s) => s.selectModel)
  const closeModelPicker = useStore((s) => s.closeModelPicker)
  const currentModel = useStore((s) => s.snapshot.session.model)
  const newConversationRequest = useStore((s) => s.newConversationRequest)
  const consumeNewConversationRequest = useStore((s) => s.consumeNewConversationRequest)
  const [creating, setCreating] = useState(false)

  const shellRef = useRef<HTMLDivElement>(null)

  // 区域 5 的宽度按入口各记一份，没记过就用分派表的默认值
  const activeAgent = agents.find((agent) => agent.id === activeAgentId) ?? null
  const layout = paneLayoutFor(pane, activeAgent?.type ?? null)
  const zone5 = layout.zone5 !== null
  const zone5Width = zone5Widths[pane] ?? layout.zone5 ?? ZONE5_MIN
  const zone5Min = layout.zone5Min ?? ZONE5_MIN


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

    const offSnapshot = host.onSnapshot(setSnapshot)
    const offEvents = host.onSessionEvent(applySessionEvents)

    return () => {
      offSnapshot()
      offEvents()
    }
  }, [setSnapshot, applySessionEvents])

  /*
   * agent 操作浏览器时把窄轨切到浏览器入口。
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

  // 宽度写在 shell 的 CSS 变量上，标题栏和下方几列共用同一份（见 .shell）
  useLayoutEffect(() => {
    const el = shellRef.current
    if (!el) return
    el.style.setProperty('--zone5-w', `${zone5Width}px`)
  }, [zone5Width, zone5])

  const shellClass = ['shell', zone5 ? '' : 'is-zone5-hidden'].filter(Boolean).join(' ')

  return (
    <div ref={shellRef} className={shellClass}>
      <TitleBar />
      <div className="shell-deck">
        <Rail />
        {zone5 && <Zone5 />}
        <Zone6 />
      </div>
      <StatusBar />

      {/*
        区域 5 的拖动条。位置跟着「窄轨 + 区域 5 宽度」走 —— 用 CSS 变量算，不在这里量 DOM。
      */}
      {zone5 && (
        <PaneResizer
          variant="zone5"
          label="调整区域 5 宽度"
          width={zone5Width}
          min={zone5Min}
          defaultWidth={layout.zone5 ?? zone5Min}
          ceiling={() => Math.min(ZONE5_MAX, window.innerWidth - 320)}
          onDrag={(next) => shellRef.current?.style.setProperty('--zone5-w', `${next}px`)}
          onCommit={(next) => setZone5Width(pane, next)}
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
