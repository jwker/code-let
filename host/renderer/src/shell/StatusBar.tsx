import { isPreview } from '../host'
import { useStore } from '../store'

const MODE_LABEL = { normal: '普通', terminal: '终端', html: 'HTML' } as const

/**
 * 底部状态栏 —— 多段并存，左边身份，右边状态。
 *
 * 模型不在这一行 —— 它只在输入框那一行显示与切换（见 ConversationArea 的模型胶囊）。
 * 同一件事不在两处说，也不给两个都能点的入口。
 */
export function StatusBar() {
  const snapshot = useStore((s) => s.snapshot)
  const mode = useStore((s) => s.mode)
  const eventCount = useStore((s) => s.eventCount)

  const fallback = snapshot.session.modelFallback

  return (
    <footer className="shell-bar flex items-center gap-4 bg-surface px-4 text-[10.5px] text-fg-3">
      <span className="truncate">{snapshot.currentProject?.name ?? '未选择项目'}</span>
      <span className="truncate font-mono">
        {snapshot.session.sessionId ? `session ${snapshot.session.sessionId.slice(0, 8)}` : 'no session'}
      </span>

      <span className="ml-auto flex min-w-0 items-center gap-4">
        {/*
          模型不在这里显示 —— 唯一的位置是输入框那一行（换模型是「准备发消息」
          时做的决定）。这一条只是恢复失败的告警，不是第二个模型入口。
        */}
        {fallback && (
          <span className="truncate text-warn" title={fallback}>
            ▲ 未能恢复原模型
          </span>
        )}
        <span>{MODE_LABEL[mode]}</span>
        <span className="font-mono">events {eventCount}</span>
        <span>
          {isPreview ? '浏览器预览 · 假数据' : snapshot.session.ready ? 'Pi 就绪' : 'Pi 未就绪'}
        </span>
      </span>
    </footer>
  )
}
