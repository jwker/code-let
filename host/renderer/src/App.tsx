import { useEffect } from 'react'
import { host } from './host'
import { Inspector } from './shell/Inspector'
import { MainArea } from './shell/MainArea'
import { Rail } from './shell/Rail'
import { Sidebar } from './shell/Sidebar'
import { StatusBar } from './shell/StatusBar'
import { TitleBar } from './shell/TitleBar'
import { useStore } from './store'

export function App() {
  const setSnapshot = useStore((s) => s.setSnapshot)
  const applySessionEvents = useStore((s) => s.applySessionEvents)
  const setItems = useStore((s) => s.setItems)
  const theme = useStore((s) => s.theme)
  const sessionId = useStore((s) => s.snapshot.session.sessionId)
  const inspectorOpen = useStore((s) => s.inspectorOpen)

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

  return (
    <div className={inspectorOpen ? 'shell' : 'shell is-insp-hidden'}>
      <TitleBar />
      <Rail />
      <Sidebar />
      <MainArea />
      <Inspector />
      <StatusBar />
    </div>
  )
}
