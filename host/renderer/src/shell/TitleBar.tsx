import { useEffect, useRef, useState } from 'react'
import type { ConversationMode, NavEntry } from '@contract/index'
import { useStore } from '../store'
import { IconMore, IconPanelRight, IconSession } from './icons'

const NAV_TITLES: Record<NavEntry, string> = {
  session: '会话',
  board: '看板',
  memory: '记忆图谱',
  code: '代码',
  terminal: '终端'
}

const MODES: Array<{ key: ConversationMode; label: string }> = [
  { key: 'normal', label: '普通' },
  { key: 'terminal', label: '终端' },
  { key: 'html', label: 'HTML' }
]

/**
 * 窗口标题栏。
 *
 * 横向跟 shell 一样切成三段：左（导航轨 + 侧栏）/ 中（主区）/ 右（检视器）。
 * 中间段标题贴左、菜单按钮贴右；模式切换放在「…」菜单的二级菜单里。
 */
export function TitleBar() {
  const nav = useStore((s) => s.nav)
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const sessionId = useStore((s) => s.snapshot.session.sessionId)
  const conversations = useStore((s) => s.snapshot.conversations)
  const inspectorOpen = useStore((s) => s.inspectorOpen)
  const toggleInspector = useStore((s) => s.toggleInspector)

  const [menuOpen, setMenuOpen] = useState(false)
  const [subOpen, setSubOpen] = useState(false)
  // 二级菜单默认往右展开；右边放不下就翻到左边
  const [subLeft, setSubLeft] = useState(false)
  // 鼠标从一级菜单移到二级菜单时中间有缝，给关闭留一点缓冲
  const subCloseTimer = useRef<number | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // 二级菜单宽度（w-44 = 176）加 8px 缝隙，留够才往右开
  const SUB_W = 176 + 8

  const activeConversation = conversations.find((conversation) => conversation.id === sessionId)
  const title =
    nav === 'session'
      ? (activeConversation?.title ?? (sessionId ? '对话' : '新对话'))
      : NAV_TITLES[nav]

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
      setSubOpen(false)
      subCloseTimer.current = null
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
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [menuOpen])

  return (
    <header className="shell-title drag-region bg-canvas">
      <div className="titlebar-left" />

      <div className="titlebar-main">
        <div className="titlebar-content">
          <div className="titlebar-title">
            <span className="title-icon flex-none text-fg-3">
              <IconSession />
            </span>
            <span className="truncate text-[13px] font-semibold text-fg-1">{title}</span>
          </div>

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
                className="no-drag flex h-7 w-7 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-sunken hover:text-fg-1"
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
                    style={{ boxShadow: 'var(--sh-lg)' }}
                  >
                    <div
                      className="relative"
                      onMouseEnter={openSub}
                      onMouseLeave={closeSubSoon}
                    >
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
                          className={[
                            'no-drag absolute top-0 z-50',
                            subLeft ? 'right-full pr-1' : 'left-full pl-1'
                          ].join(' ')}
                          onMouseEnter={openSub}
                        >
                          <div
                            role="menu"
                            aria-label="模式"
                            className="w-44 rounded-xl border border-hairline bg-raised p-1"
                            style={{ boxShadow: 'var(--sh-lg)' }}
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
                                    active
                                      ? 'bg-accent-wash text-fg-1'
                                      : 'text-fg-2 hover:bg-sunken hover:text-fg-1'
                                  ].join(' ')}
                                >
                                  <span>{item.label}</span>
                                  <span className="ml-auto text-[11px] text-fg-1">
                                    {active ? '✓' : ''}
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="titlebar-insp">
        {/*
         * 固定在窗口右上角：检视器收起时这一列会变成 0 宽，
         * 按钮不能跟着列走，所以脱离网格绝对定位。
         */}
        <button
          type="button"
          aria-pressed={inspectorOpen}
          aria-label={inspectorOpen ? '隐藏右侧面板' : '显示右侧面板'}
          title={inspectorOpen ? '隐藏右侧面板' : '显示右侧面板'}
          onClick={toggleInspector}
          className={[
            'no-drag absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-sunken hover:text-fg-1',
            inspectorOpen ? 'text-fg-2' : 'text-fg-3'
          ].join(' ')}
        >
          <IconPanelRight />
        </button>
      </div>
    </header>
  )
}
