import { useEffect, useRef, useState } from 'react'
import type { ConversationMode } from '@contract/index'
import { useStore } from '../store'
import { IconMore, IconPanelLeft, IconPanelRight } from './icons'
import { TabBar } from './TabBar'

const MODES: Array<{ key: ConversationMode; label: string }> = [
  { key: 'normal', label: '普通' },
  { key: 'terminal', label: '终端' },
  { key: 'html', label: 'HTML' }
]

/**
 * 窗口标题栏 —— 画布色，铺满整宽（跟导航轨连成一个 L 形）。
 *
 * 横向三段：红绿灯右侧是左按钮板块，中间是标签板块（药丸），右边是右按钮板块。
 *
 * 整条可拖动；可点的部分标 no-drag。
 */
export function TitleBar() {
  const nav = useStore((s) => s.nav)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  const toggleInspector = useStore((s) => s.toggleInspector)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  const [menuOpen, setMenuOpen] = useState(false)
  const [subOpen, setSubOpen] = useState(false)
  // 二级菜单默认往右展开；右边放不下就翻到左边
  const [subLeft, setSubLeft] = useState(false)
  // 鼠标从一级菜单移到二级菜单时中间有缝，给关闭留一点缓冲
  const subCloseTimer = useRef<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 二级菜单宽度（w-44 = 176）加 8px 缝隙，留够才往右开
  const SUB_W = 176 + 8

  function clearSubTimer(): void {
    if (subCloseTimer.current !== null) {
      window.clearTimeout(subCloseTimer.current)
      subCloseTimer.current = null
    }
  }

  function openSub(): void {
    clearSubTimer()
    // 一级菜单贴到窗口右边时（检视器收起），二级菜单再往右就出屏了
    const rect = menuRef.current?.getBoundingClientRect()
    if (rect) setSubLeft(rect.right + SUB_W > window.innerWidth)
    setSubOpen(true)
  }

  function closeSubSoon(): void {
    clearSubTimer()
    subCloseTimer.current = window.setTimeout(() => {
      subCloseTimer.current = null
      setSubOpen(false)
    }, 160)
  }

  function closeMenu(): void {
    clearSubTimer()
    setMenuOpen(false)
    setSubOpen(false)
  }

  function selectMode(next: ConversationMode): void {
    setMode(next)
    closeMenu()
  }

  // 卸载时把悬停关闭的定时器清掉
  useEffect(() => () => clearSubTimer(), [])

  // 离开会话页时把菜单收起来
  useEffect(() => {
    if (nav !== 'session') {
      clearSubTimer()
      setMenuOpen(false)
      setSubOpen(false)
    }
  }, [nav])

  // Esc 关闭菜单
  useEffect(() => {
    if (!menuOpen) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  return (
    <header className="shell-title drag-region bg-canvas">
      {/* 红绿灯占的那一片 —— 拖动区 */}
      <div className="titlebar-gutter" />

      {/* 左按钮板块 */}
      <div className="titlebar-zone left no-drag">
        <button
          type="button"
          aria-pressed={sidebarOpen}
          aria-label={sidebarOpen ? '隐藏侧栏' : '显示侧栏'}
          title={sidebarOpen ? '隐藏侧栏 ⌘B' : '显示侧栏 ⌘B'}
          onClick={toggleSidebar}
          className="titlebar-icon-btn"
        >
          <IconPanelLeft />
        </button>
        <span className="titlebar-app">Codelet</span>
      </div>

      {/* 标签板块：药丸标签 */}
      <TabBar />

      {/* 右按钮板块 */}
      <div className="titlebar-zone right no-drag">
        {nav === 'session' && (
          <div className="titlebar-more relative">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="更多"
              title="更多"
              onClick={() => {
                clearSubTimer()
                setSubOpen(false)
                setMenuOpen((value) => !value)
              }}
              className="titlebar-icon-btn"
            >
              <IconMore />
            </button>

            {menuOpen && (
              <>
                <div className="no-drag fixed inset-0 z-40" onClick={closeMenu} />

                <div
                  ref={menuRef}
                  role="menu"
                  aria-label="更多"
                  className="no-drag absolute right-0 top-full z-50 mt-2 w-52 rounded-xl border border-hairline bg-raised p-1"
                  style={{ boxShadow: 'var(--sh-md)' }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeMenu()
                      toggleSidebar()
                    }}
                    className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-fg-1 transition-colors hover:bg-sunken"
                  >
                    <span>{sidebarOpen ? '隐藏侧栏' : '显示侧栏'}</span>
                    <span className="ml-auto font-mono text-[10.5px] text-fg-3">⌘B</span>
                  </button>

                  <div className="my-1 h-px bg-hairline" />

                  <div className="relative" onMouseEnter={openSub} onMouseLeave={closeSubSoon}>
                    <button
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={subOpen}
                      onClick={() => {
                        if (subOpen) setSubOpen(false)
                        else openSub()
                      }}
                      className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] text-fg-1 transition-colors hover:bg-sunken"
                    >
                      <span>模式切换</span>
                      <span className="ml-auto text-[13px] text-fg-3">
                        {subLeft && subOpen ? '‹' : '›'}
                      </span>
                    </button>

                    {subOpen && (
                      <div
                        role="menu"
                        aria-label="模式"
                        className="no-drag absolute top-0 z-50 w-44 rounded-xl border border-hairline bg-raised p-1"
                        style={{ boxShadow: 'var(--sh-md)' }}
                      >
                        {MODES.map((item) => {
                          const active = mode === item.key
                          return (
                            <button
                              key={item.key}
                              type="button"
                              role="menuitemradio"
                              aria-checked={active}
                              onClick={() => selectMode(item.key)}
                              className={[
                                'flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors',
                                active ? 'bg-accent-wash text-fg-1' : 'text-fg-2 hover:bg-sunken hover:text-fg-1'
                              ].join(' ')}
                            >
                              <span>{item.label}</span>
                              <span className="ml-auto text-[11px] text-fg-1">{active ? '✓' : ''}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        <button
          type="button"
          aria-pressed={inspectorOpen}
          aria-label={inspectorOpen ? '隐藏右侧面板' : '显示右侧面板'}
          title={inspectorOpen ? '隐藏右侧面板' : '显示右侧面板'}
          onClick={toggleInspector}
          className="titlebar-icon-btn"
        >
          <IconPanelRight />
        </button>
      </div>
    </header>
  )
}
