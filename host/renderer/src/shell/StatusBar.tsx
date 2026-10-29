import { isPreview } from '../host'
import { useStore } from '../store'

const MODE_LABEL = { normal: '普通', terminal: '终端', html: 'HTML' } as const

/**
 * 底部状态栏 —— 多段并存，左边身份，右边状态。
 *
 * 模型也在这里：它是「这个会话现在是什么状态」的一部分，随时看得到。
 * 主要的操作入口在输入框那一行（见 ConversationArea 的模型胶囊），这里点一下也能开同一个选择器。
 */
export function StatusBar() {
  const snapshot = useStore((s) => s.snapshot)
  const mode = useStore((s) => s.mode)
  const eventCount = useStore((s) => s.eventCount)
  const openPicker = useStore((s) => s.openModelPicker)

  const model = snapshot.session.model
  const fallback = snapshot.session.modelFallback

  return (
    <footer className="shell-bar flex items-center gap-4 bg-surface px-4 text-[10.5px] text-fg-3">
      <span className="truncate">{snapshot.currentProject?.name ?? '未选择项目'}</span>
      <span className="truncate font-mono">
        {snapshot.session.sessionId ? `session ${snapshot.session.sessionId.slice(0, 8)}` : 'no session'}
      </span>

      <span className="ml-auto flex min-w-0 items-center gap-4">
        {fallback && (
          <span className="truncate text-warn" title={fallback}>
            ▲ 未能恢复原模型
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            openPicker({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
          }}
          title={model ? `${model.provider}/${model.id}` : '未选模型'}
          className="flex min-w-0 max-w-[300px] items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-fg-2 transition-colors hover:bg-sunken hover:text-fg-1"
        >
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-ok" />
          <span className="min-w-0 truncate">{model ? model.name : '未选模型'}</span>
        </button>
        <span>{MODE_LABEL[mode]}</span>
        <span className="font-mono">events {eventCount}</span>
        <span>
          {isPreview ? '浏览器预览 · 假数据' : snapshot.session.ready ? 'Pi 就绪' : 'Pi 未就绪'}
        </span>
      </span>
    </footer>
  )
}
