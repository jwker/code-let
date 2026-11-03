import { useStore } from '../store'
import { host } from '../host'

/**
 * 扩展加载 / 执行错误的主区提示。
 *
 * 扩展错误不属于某一条对话内容，放在主区顶部而不是对话流里；
 * 最多展示最近一条，title 给完整路径和错误，点「清除」清掉整批。
 */
export function ExtensionErrorBanner() {
  const errors = useStore((s) => s.snapshot.extensionErrors)
  const latest = errors[errors.length - 1]
  const tab = useStore((s) => (latest?.tabId ? s.snapshot.tabs.find((item) => item.id === latest.tabId) : undefined))
  if (!latest) return null

  const label = latest.kind === 'load' ? '加载失败' : '执行失败'
  const detail = latest.event ? `${latest.path} · ${latest.event}` : latest.path

  return (
    <div
      role="alert"
      style={{ borderColor: 'var(--danger-line)' }}
      className="flex flex-none items-center gap-2 border-b bg-danger-wash px-4 py-1.5 text-[11.5px] text-danger"
    >
      <span className="flex-none" aria-hidden="true">
        ▲
      </span>
      <span className="flex-none font-medium">扩展{label}</span>
      <span className="min-w-0 flex-1 truncate" title={`${detail}\n${latest.message}`}>
        {tab ? `${tab.title} · ` : ''}
        {detail}：{latest.message}
      </span>
      {errors.length > 1 && <span className="flex-none opacity-70">共 {errors.length} 条</span>}
      <button
        type="button"
        onClick={() => void host.dismissExtensionErrors()}
        title="清除扩展错误"
        className="flex-none rounded-md px-2 py-0.5 transition-colors hover:bg-white/20"
      >
        清除
      </button>
    </div>
  )
}
