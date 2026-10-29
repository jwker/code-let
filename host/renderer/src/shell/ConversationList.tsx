import { useStore } from '../store'
import type { ConversationInfo } from '@contract/index'
import { host } from '../host'

function startOfToday(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function groupOf(modified: string): '今天' | '昨天' | '更早' {
  const time = new Date(modified).getTime()
  const today = startOfToday()
  if (time >= today) return '今天'
  if (time >= today - 86_400_000) return '昨天'
  return '更早'
}

function relativeTime(modified: string): string {
  const diff = Math.max(0, Date.now() - new Date(modified).getTime())
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return `${Math.floor(diff / 1000)}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)} 天前`
}

const GROUP_ORDER = ['今天', '昨天', '更早'] as const

/** 当前项目的对话列表 —— 宿主数据，组件不进侧栏 */
export function ConversationList() {
  const conversations = useStore((s) => s.snapshot.conversations)
  const activeSessionId = useStore((s) => s.snapshot.session.sessionId)

  const groups = new Map<string, ConversationInfo[]>()
  for (const conversation of conversations) {
    const key = groupOf(conversation.modified)
    const bucket = groups.get(key)
    if (bucket) bucket.push(conversation)
    else groups.set(key, [conversation])
  }

  if (conversations.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-[12.5px] text-fg-3">
        这个项目还没有对话
        <br />
        点上面的新建对话开一个
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 pb-4 pt-1">
      {GROUP_ORDER.filter((key) => groups.has(key)).map((key) => (
        <div key={key} className="mb-3">
          <div className="px-3 pb-1 pt-2 text-[11.5px] text-fg-3">{key}</div>
          {groups.get(key)?.map((conversation) => {
            const active = conversation.id === activeSessionId
            return (
              <button
                key={conversation.id}
                type="button"
                onClick={() => void host.switchConversation(conversation.path)}
                className={[
                  'group flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                  active ? 'bg-accent-wash text-fg-1' : 'text-fg-2 hover:bg-sunken'
                ].join(' ')}
              >
                <span
                  className={[
                    'min-w-0 flex-1 truncate text-[13.5px]',
                    active ? 'font-medium' : ''
                  ].join(' ')}
                >
                  {conversation.title}
                </span>
                <span className="flex-none font-mono text-[10px] text-fg-3 opacity-0 transition-opacity group-hover:opacity-100">
                  {relativeTime(conversation.modified)}
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
