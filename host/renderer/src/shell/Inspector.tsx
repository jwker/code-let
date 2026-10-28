/** 右侧检视器 —— 多个面板可并存，宿主给外壳，组件给内容 */
export function Inspector() {
  return (
    <aside className="shell-insp flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-hairline bg-surface p-3">
      <section className="rounded-md border border-hairline">
        <header className="border-b border-hairline px-3 py-2 text-[12px] font-semibold text-fg-1">
          Git
        </header>
        <div className="px-3 py-3 text-[11.5px] text-fg-3">面板还没接</div>
      </section>

      <section className="rounded-md border border-hairline">
        <header className="border-b border-hairline px-3 py-2 text-[12px] font-semibold text-fg-1">
          Agent
        </header>
        <div className="px-3 py-3 text-[11.5px] text-fg-3">面板还没接</div>
      </section>
    </aside>
  )
}
