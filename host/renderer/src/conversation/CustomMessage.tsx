import type { StreamItem } from '@contract/index'
import { Markdown } from './Markdown'

/**
 * 扩展消息（`pi.sendMessage()`，display 为 true）。
 *
 * 跟用户气泡、助手正文都区分开：左上角标出扩展自己的 customType，
 * 内容按普通 Markdown 渲染。TUI 里注册的自定义 renderer 是 TUI 组件，
 * Codelet 用不了，这里统一走通用样式。
 */
export function CustomMessage({ item }: { item: Extract<StreamItem, { kind: 'custom' }> }) {
  return (
    <div className="my-2 rounded-xl border border-hairline bg-sunken px-3 py-2">
      <div className="mb-1 font-mono text-[10px] tracking-wide text-fg-3">
        [{item.customType}]
      </div>
      {item.text ? (
        <div className="text-[13px] leading-relaxed text-fg-2">
          <Markdown text={item.text} variant="normal" />
        </div>
      ) : (
        <div className="text-[11.5px] text-fg-3">扩展消息没有文本内容</div>
      )}
    </div>
  )
}
