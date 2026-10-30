import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { host } from './host'
import { Inspector } from './shell/Inspector'
import { MainArea } from './shell/MainArea'
import { ModelPicker } from './shell/ModelPicker'
import { PaneResizer } from './shell/PaneResizer'
import { Rail } from './shell/Rail'
import { Sidebar } from './shell/Sidebar'
import { TitleBar } from './shell/TitleBar'
import {
  INSPECTOR_DEFAULT,
  INSPECTOR_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  clampInspector,
  clampSidebar,
  inspectorCeiling,
  loadInspectorWidth,
  loadSidebarWidth,
  saveInspectorWidth,
  saveSidebarWidth,
  sidebarCeiling
} from './shell/paneSizes'
import { useStore } from './store'

export function App() {
  const setSnapshot = useStore((s) => s.setSnapshot)
  const applySessionEvents = useStore((s) => s.applySessionEvents)
  const setItems = useStore((s) => s.setItems)
  const theme = useStore((s) => s.theme)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const pickerAnchor = useStore((s) => s.modelPickerAnchor)
  const models = useStore((s) => s.models)
  const selectModel = useStore((s) => s.selectModel)
  const closeModelPicker = useStore((s) => s.closeModelPicker)
  const currentModel = useStore((s) => s.snapshot.session.model)

  const shellRef = useRef<HTMLDivElement>(null)
  const [sideWidth, setSideWidth] = useState(loadSidebarWidth)
  const [inspWidth, setInspWidth] = useState(loadInspectorWidth)
  // 拖拽时宽度只写 DOM、不动 state，所以窗口 resize 的回调要从这里读最新值
  const layoutRef = useRef({
    side: sideWidth,
    insp: inspWidth,
    sideOpen: sidebarOpen,
    inspOpen: inspectorOpen
  })

  useEffect(() => {
    // macOS 的红绿灯压在导航轨顶上，躲开它
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

  /**
   * 切标签就换内容流（R1 R5）：持久态在 Pi 的会话文件里，宿主不另存一份。
   *
   * **每个标签一份**（PLAN.md D4 修订）：内容流按标签 id 存在 store 里，
   * 切回来读内存里那一份 —— 磁盘上的 entries 落后于实时事件，
   * 拿磁盘覆盖回放会丢消息或重排。
   *
   * 只有这个标签还没加载过时才去读盘（懒加载的标签第一次点开才建 runtime）。
   */
  useEffect(() => {
    if (!activeTabId) return
    if (useStore.getState().items[activeTabId]) return
    let cancelled = false
    void host.getTabEntries(activeTabId).then((items) => {
      if (!cancelled) setItems(activeTabId, items)
    })
    return () => {
      cancelled = true
    }
  }, [activeTabId, setItems])

  // 宽度写在 shell 的 CSS 变量上，标题栏和下方三列共用同一份（见 .shell）
  useLayoutEffect(() => {
    layoutRef.current = { side: sideWidth, insp: inspWidth, sideOpen: sidebarOpen, inspOpen: inspectorOpen }
    const el = shellRef.current
    if (!el) return
    el.style.setProperty('--side-w', `${sideWidth}px`)
    el.style.setProperty('--insp-w', `${inspWidth}px`)
  }, [sideWidth, inspWidth, sidebarOpen, inspectorOpen])

  // ⌘B / Ctrl+B：跟编辑器一致，侧栏收放的快捷键
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      toggleSidebar()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  // 窗口变窄：把两栏收回上限之内，别把主区挤没（收起的那一栏不占宽度）
  useEffect(() => {
    function fitToWindow(): void {
      const { side, insp, sideOpen, inspOpen } = layoutRef.current
      const width = window.innerWidth
      const nextInsp = clampInspector(insp, sideOpen ? side : 0, width)
      const nextSide = clampSidebar(side, inspOpen ? nextInsp : 0, width)
      if (nextInsp !== insp) setInspWidth(nextInsp)
      if (nextSide !== side) setSideWidth(nextSide)
    }
    window.addEventListener('resize', fitToWindow)
    // 首屏也收一次：上次可能是在更大的窗口里拖的
    fitToWindow()
    return () => window.removeEventListener('resize', fitToWindow)
  }, [])

  const shellClass = [
    'shell',
    inspectorOpen ? '' : 'is-insp-hidden',
    sidebarOpen ? '' : 'is-side-hidden'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={shellRef} className={shellClass}>
      <TitleBar />
      <Rail />
      <div className="shell-deck">
        <Sidebar />
        <MainArea />
        <Inspector />
      </div>

      <PaneResizer
        edge="left"
        label="调整侧栏宽度"
        width={sideWidth}
        min={SIDEBAR_MIN}
        defaultWidth={SIDEBAR_DEFAULT}
        ceiling={() => {
          const { insp, inspOpen } = layoutRef.current
          return sidebarCeiling(inspOpen ? insp : 0, window.innerWidth)
        }}
        onDrag={(next) => shellRef.current?.style.setProperty('--side-w', `${next}px`)}
        onCommit={(next) => {
          setSideWidth(next)
          saveSidebarWidth(next)
        }}
      />

      <PaneResizer
        edge="right"
        label="调整右侧面板宽度"
        width={inspWidth}
        min={INSPECTOR_MIN}
        defaultWidth={INSPECTOR_DEFAULT}
        ceiling={() => {
          const { side, sideOpen } = layoutRef.current
          return inspectorCeiling(sideOpen ? side : 0, window.innerWidth)
        }}
        onDrag={(next) => shellRef.current?.style.setProperty('--insp-w', `${next}px`)}
        onCommit={(next) => {
          setInspWidth(next)
          saveInspectorWidth(next)
        }}
      />

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
              if (activeTabId) await selectModel(activeTabId, model.provider, model.id, persist)
            }}
            onClose={closeModelPicker}
          />
        </div>
      )}
    </div>
  )
}
