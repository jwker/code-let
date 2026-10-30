/**
 * 右侧检视器 —— 多个面板可并存，宿主给外壳，组件给内容。
 *
 * 收起时外壳宽度归零，内容保持原宽靠右对齐、被裁掉，
 * 这样滑出的是整块面板，而不是每帧重新排版文字。
 */
export function Inspector() {
  return (
    <aside className="shell-card insp">
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
    </aside>
  )
}
