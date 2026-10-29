import { useStore } from '../store'
import { ConversationList } from './ConversationList'
import { IconPencil } from './icons'
import { ProjectSwitcher } from './ProjectSwitcher'
import { host } from '../host'

/** 上下文侧栏 —— 宿主独占：项目切换器 + 当前项目的对话列表 */
export function Sidebar() {
  const count = useStore((s) => s.snapshot.conversations.length)

  return (
    <aside className="shell-side flex min-h-0 flex-col border-r border-hairline bg-panel">
      <ProjectSwitcher />

      <div className="px-2.5 pt-1">
        <button
          type="button"
          title="新建对话"
          aria-label="新建对话"
          onClick={() => void host.newConversation()}
          className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-[13.5px] text-fg-1 transition-colors hover:bg-sunken"
        >
          <span className="flex-none text-fg-2">
            <IconPencil />
          </span>
          <span>新建对话</span>
        </button>
      </div>

      <div className="flex items-center gap-2 px-3.5 pb-1 pt-4">
        <h2 className="text-[11.5px] font-medium text-fg-3">对话</h2>
        <span className="font-mono text-[10px] text-fg-3/70">{count}</span>
      </div>

      <ConversationList />
    </aside>
  )
}
