import { isPreview } from '../host'
import { useStore } from '../store'

const MODE_LABEL = { normal: '普通', terminal: '终端', html: 'HTML' } as const

/** 底部状态栏 —— 多段并存，左边身份，右边状态 */
export function StatusBar() {
  const snapshot = useStore((s) => s.snapshot)
  const mode = useStore((s) => s.mode)
  const eventCount = useStore((s) => s.eventCount)

  return (
    <footer className="shell-bar flex items-center gap-4 bg-surface px-4 text-[10.5px] text-fg-3">
      <span className="truncate">{snapshot.currentProject?.name ?? '未选择项目'}</span>
      <span className="truncate font-mono">
        {snapshot.session.sessionId ? `session ${snapshot.session.sessionId.slice(0, 8)}` : 'no session'}
      </span>

      <span className="ml-auto flex items-center gap-4">
        <span>{MODE_LABEL[mode]}</span>
        <span className="font-mono">events {eventCount}</span>
        <span>
          {isPreview ? '浏览器预览 · 假数据' : snapshot.session.ready ? 'Pi 就绪' : 'Pi 未就绪'}
        </span>
      </span>
    </footer>
  )
}
