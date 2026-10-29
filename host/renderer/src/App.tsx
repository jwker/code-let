import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { host } from './host'
import { Inspector } from './shell/Inspector'
import { MainArea } from './shell/MainArea'
import { PaneResizer } from './shell/PaneResizer'
import { Rail } from './shell/Rail'
import { Sidebar } from './shell/Sidebar'
import { StatusBar } from './shell/StatusBar'
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
  const sessionId = useStore((s) => s.snapshot.session.sessionId)
  const inspectorOpen = useStore((s) => s.inspectorOpen)

  const shellRef = useRef<HTMLDivElement>(null)
  const [sideWidth, setSideWidth] = useState(loadSidebarWidth)
  const [inspWidth, setInspWidth] = useState(loadInspectorWidth)
  // 拖拽时宽度只写 DOM、不动 state，所以窗口 resize 的回调要从这里读最新值
  const layoutRef = useRef({ side: sideWidth, insp: inspWidth, open: inspectorOpen })

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

  useEffect(() => {
    // 换会话就重建内容流（R1 R5）：持久态在 Pi 的会话文件里，宿主不另存一份
    let cancelled = false
    setItems([])
    void host.getSessionEntries().then((items) => {
      if (!cancelled) setItems(items)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, setItems])

  // 宽度写在 shell 的 CSS 变量上，标题栏和下方三列共用同一份（见 .shell）
  useLayoutEffect(() => {
    layoutRef.current = { side: sideWidth, insp: inspWidth, open: inspectorOpen }
    const el = shellRef.current
    if (!el) return
    el.style.setProperty('--side-w', `${sideWidth}px`)
    el.style.setProperty('--insp-w', `${inspWidth}px`)
  }, [sideWidth, inspWidth, inspectorOpen])

  // 窗口变窄：把两栏收回上限之内，别把主区挤没
  useEffect(() => {
    function fitToWindow(): void {
      const { side, insp, open } = layoutRef.current
      const width = window.innerWidth
      const nextInsp = clampInspector(insp, side, width)
      const nextSide = clampSidebar(side, open ? nextInsp : 0, width)
      if (nextInsp !== insp) setInspWidth(nextInsp)
      if (nextSide !== side) setSideWidth(nextSide)
    }
    window.addEventListener('resize', fitToWindow)
    // 首屏也收一次：上次可能是在更大的窗口里拖的
    fitToWindow()
    return () => window.removeEventListener('resize', fitToWindow)
  }, [])

  return (
    <div ref={shellRef} className={inspectorOpen ? 'shell' : 'shell is-insp-hidden'}>
      <TitleBar />
      <Rail />
      <Sidebar />
      <MainArea />
      <Inspector />
      <StatusBar />

      <PaneResizer
        edge="left"
        label="调整侧栏宽度"
        width={sideWidth}
        min={SIDEBAR_MIN}
        defaultWidth={SIDEBAR_DEFAULT}
        ceiling={() => {
          const { insp, open } = layoutRef.current
          return sidebarCeiling(open ? insp : 0, window.innerWidth)
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
        ceiling={() => inspectorCeiling(layoutRef.current.side, window.innerWidth)}
        onDrag={(next) => shellRef.current?.style.setProperty('--insp-w', `${next}px`)}
        onCommit={(next) => {
          setInspWidth(next)
          saveInspectorWidth(next)
        }}
      />
    </div>
  )
}
