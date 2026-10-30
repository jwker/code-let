import type { NavEntry } from '@contract/index'
import { useStore } from '../store'
import { NavBar } from './NavBar'

/** 导航项对应的视图标题 */
const TITLES: Record<NavEntry, string> = {
  board: '看板',
  memory: '记忆图谱',
  code: '代码',
  terminal: '终端',
  git: 'Git',
  agent: 'Agent'
}

/** 还没接的视图 —— 先给一句占位说明 */
const PLACEHOLDER: Record<NavEntry, string> = {
  board: '组件放在 ext/ + view/，一个组件一视图',
  memory: '组件放在 ext/ + view/，一个组件一视图',
  code: '组件放在 ext/ + view/，一个组件一视图',
  terminal: '常驻终端面板（node-pty），跟对话区的终端模式是两件事',
  git: '面板还没接',
  agent: '面板还没接'
}

/**
 * 右侧检视器 —— 一次只显示一个视图，**没有常驻面板**。
 *
 * 顶部是导航栏（原来在左边的导航轨），6 个入口：看板 / 记忆 / 代码 / 终端 / Git / Agent。
 * 点开的视图占满整块面板 —— 所以看板、代码这些需要空间的能用到全部宽度。
 *
 * 收起时卡片收成 38px 的窄轨：导航栏留着（竖排图标），面板内容收起来 ——
 * 导航入口不能因为收起面板就没了。
 */
export function Inspector() {
  const open = useStore((s) => s.inspectorOpen)
  const nav = useStore((s) => s.nav)

  return (
    <aside className="shell-card insp">
      <NavBar compact={!open} />
      {open && (
        <div className="insp-body">
          <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-hairline bg-raised shadow-[var(--sh-sm)]">
            <header className="flex h-10 flex-none items-center px-3 text-[13px] font-medium text-fg-1">
              {TITLES[nav]}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              <div className="placeholder py-8 text-center">
                <div>{TITLES[nav]} · 视图还没接</div>
                <div className="text-[11.5px]">{PLACEHOLDER[nav]}</div>
              </div>
            </div>
          </section>
        </div>
      )}
    </aside>
  )
}
