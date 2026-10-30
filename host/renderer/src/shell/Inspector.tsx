import { useStore } from '../store'
import { NavBar } from './NavBar'

/**
 * 右侧检视器 —— 多个面板可并存，宿主给外壳，组件给内容。
 *
 * 顶部是导航栏（原来在左边的导航轨）。
 * 收起时卡片收成 38px 的窄轨：**导航栏留着**（竖排图标），面板内容收起来 ——
 * 导航入口不能因为收起面板就没了。
 */
export function Inspector() {
  const open = useStore((s) => s.inspectorOpen)

  return (
    <aside className="shell-card insp">
      <NavBar compact={!open} />
      {open && (
        <div className="insp-body">
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
        </div>
      )}
    </aside>
  )
}
