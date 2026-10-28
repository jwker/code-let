import type { NavEntry } from '@contract/index'
import { ConversationArea } from '../conversation/ConversationArea'
import { useStore } from '../store'

const TITLES: Record<NavEntry, string> = {
  session: '会话',
  board: '看板',
  memory: '记忆图谱',
  code: '代码',
  terminal: '终端'
}

/** 主工作区 —— 一个入口一个视图，位置写死（PLAN.md D5） */
export function MainArea() {
  const nav = useStore((s) => s.nav)

  if (nav === 'session') {
    return (
      <main className="shell-main flex min-h-0 flex-col bg-canvas">
        <ConversationArea />
      </main>
    )
  }

  return (
    <main className="shell-main flex min-h-0 flex-col bg-canvas">
      <header className="flex h-11 flex-none items-center border-b border-hairline px-4">
        <h1 className="text-[13px] font-semibold text-fg-1">{TITLES[nav]}</h1>
      </header>
      <div className="placeholder">
        <div>{TITLES[nav]} · 视图还没接</div>
        <div className="text-[11.5px]">组件放在 ext/ + view/，一个组件一视图</div>
      </div>
    </main>
  )
}
