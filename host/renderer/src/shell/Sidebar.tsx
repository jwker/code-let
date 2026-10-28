import { useStore } from '../store'
import { ConversationList } from './ConversationList'
import { IconPlus } from './icons'
import { ProjectSwitcher } from './ProjectSwitcher'
import { host } from '../host'

/** 上下文侧栏 —— 宿主独占：项目切换器 + 当前项目的对话列表 */
export function Sidebar() {
  const count = useStore((s) => s.snapshot.conversations.length)

  return (
    <aside className="shell-side flex min-h-0 flex-col border-r border-hairline bg-surface">
      <ProjectSwitcher />

      <div className="flex items-center gap-2 px-3 py-2">
        <h2 className="text-[12px] font-semibold text-fg-1">对话</h2>
        <span className="font-mono text-[10px] text-fg-3">{count}</span>
        <button
          type="button"
          title="新建对话"
          aria-label="新建对话"
          onClick={() => void host.newConversation()}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-sm text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1"
        >
          <IconPlus />
        </button>
      </div>

      <ConversationList />
    </aside>
  )
}
