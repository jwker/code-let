import type { NavEntry } from '@contract/index'
import { useStore } from '../store'
import { NavBar } from './NavBar'

/** 导航项对应的视图标题 */
const TITLES: Record<NavEntry, string> = {
  board: '看板',
  memory: '记忆图谱',
  code: '代码',
  terminal: '终端'
}

/**
 * 右侧检视器 —— 多个面板可并存，宿主给外壳，组件给内容。
 *
 * 顶部是导航栏（原来在左边的导航轨）。
 * **导航点开的视图在这里打开**，不是把主区换掉 —— 对话始终在。
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
          {nav ? (
            // 导航点开的视图：占满整块面板
            <section className="flex min-h-0 flex-1 flex-col rounded-xl border border-hairline bg-raised shadow-[var(--sh-sm)]">
              <header className="flex h-10 flex-none items-center px-3 text-[13px] font-medium text-fg-1">
                {TITLES[nav]}
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                <div className="placeholder py-8 text-center">
                  <div>{TITLES[nav]} · 视图还没接</div>
                  <div className="text-[11.5px]">组件放在 ext/ + view/，一个组件一视图</div>
                </div>
              </div>
            </section>
          ) : (
            // 没选导航项 —— 默认的两块面板
            <>
              <section className="rounded-xl border border-hairline bg-raised shadow-[var(--sh-sm)]">
                <header className="flex h-10 items-center px-3 text-[13px] font-medium text-fg-1">
                  Git
                </header>
                <div className="px-3 pb-3 text-[11.5px] text-fg-3">面板还没接</div>
              </section>

              <section className="rounded-xl border border-hairline bg-raised shadow-[var(--sh-sm)]">
                <header className="flex h-10 items-center px-3 text-[13px] font-medium text-fg-1">
                  Agent
                </header>
                <div className="px-3 pb-3 text-[11.5px] text-fg-3">面板还没接</div>
              </section>
            </>
          )}
        </div>
      )}
    </aside>
  )
}
