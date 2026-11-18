import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserState, BrowserTabState } from '@contract/index'
import type { BrowserHost } from '@contract/browser'
import { host } from '../host'
import { useStore } from '../store'

/**
 * 右侧浏览器。
 *
 * 标签栏、地址栏和错误态都在 React 里；网页本身由主进程的 WebContentsView
 * 叠在 pageRef 这块占位区上。这里只负责报告矩形，不直接碰 webContents。
 */

function displayUrl(tab: BrowserTabState | null): string {
  if (!tab || tab.url === 'about:blank') return ''
  return tab.url
}

/**
 * 浏览器面板（PLAN.md D57）。
 *
 * `host` 决定它看的是哪一套标签：`project` 是窄轨里那个入口，
 * `agent:<id>` 是某个 agent 自己的预览。两套标签互不可见 ——
 * agent 的 `browser_*` 工具也只作用于自己的那一套。
 */
export function BrowserPane({ host: browserHost }: { host: BrowserHost }) {
  const [state, setState] = useState<BrowserState>(() => ({
    host: browserHost,
    tabs: [],
    activeTabId: null,
    agent: null
  }))
  const [address, setAddress] = useState('')
  const [addressFocused, setAddressFocused] = useState(false)
  const [creating, setCreating] = useState(false)
  const pageRef = useRef<HTMLDivElement>(null)
  const addressRef = useRef<HTMLInputElement>(null)
  const active = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) ?? null,
    [state]
  )
  const agent = state.agent
  /**
   * 这个面板是某个 agent 的预览，而不是窄轨里那个公共浏览器。
   *
   * 两者的空态不一样：公共浏览器空着就是空着，agent 的预览空着要说明
   * 「这里在等什么」—— 产品 agent 的区域 6 一开始就是一块白板（D52）。
   */
  const isAgentHost = browserHost.startsWith('agent:')
  /** 只有一张 about:blank 的空白标签：还没做出任何页面 */
  const blankPreview = isAgentHost && (!active || active.url === 'about:blank')

  useEffect(() => {
    let cancelled = false
    void host.getBrowserState(browserHost).then((next) => {
      if (cancelled) return
      setState(next)
      if (next.tabs.length === 0) {
        setCreating(true)
        void host.createBrowserTab(browserHost, 'about:blank').then((created) => {
          if (!cancelled) {
            setState(created)
            setCreating(false)
          }
        }).catch(() => {
          if (!cancelled) setCreating(false)
        })
      }
    })
    const off = host.onBrowserState((event) => {
      // 两个宿主各推各的 —— 只收自己那一份
      if (cancelled || event.host !== browserHost) return
      setState(event.state)
    })
    return () => {
      cancelled = true
      off()
      void host.setBrowserVisible(browserHost, false)
    }
  }, [browserHost])

  useEffect(() => {
    if (!addressFocused) setAddress(displayUrl(active))
  }, [active?.id, active?.url, addressFocused])

  // 原生 view 的位置来自这块占位区的窗口坐标。面板拖动、窗口缩放都走 ResizeObserver。
  useEffect(() => {
    const node = pageRef.current
    if (!node) return
    let frame = 0
    function report(): void {
      if (!node) return
      const rect = node.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) {
        void host.setBrowserVisible(browserHost, false)
        return
      }
      void host.setBrowserBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    }
    function onResize(): void {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(report)
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(node)
    window.addEventListener('resize', onResize)
    onResize()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [])

  /*
   * 什么时候让原生 view 露出来。
   *
   * 三种情况都要收起：没有活动标签、页面报错（让错误说明可见）、
   * **有浮层开着**（气泡/菜单/对话框会被原生 view 盖住 —— 它永远画在 DOM 之上）。
   */
  const overlayCount = useStore((s) => s.overlayCount)
  useEffect(() => {
    /*
     * 空白预览也收起：原生 view 永远画在 DOM 之上，不收起来下面的空态文案
     * 会被一张白色的 about:blank 盖得看不见。
     */
    void host.setBrowserVisible(
      browserHost,
      Boolean(active) && !active?.error && overlayCount === 0 && !blankPreview
    )
  }, [browserHost, active?.id, active?.url, active?.error, overlayCount, blankPreview])

  async function createTab(): Promise<void> {
    setCreating(true)
    try {
      const next = await host.createBrowserTab(browserHost, 'about:blank')
      setState(next)
      requestAnimationFrame(() => addressRef.current?.focus())
    } finally {
      setCreating(false)
    }
  }

  async function closeTab(tabId: string): Promise<void> {
    const next = await host.closeBrowserTab(browserHost, tabId)
    setState(next)
  }

  async function activateTab(tabId: string): Promise<void> {
    const next = await host.activateBrowserTab(browserHost, tabId)
    setState(next)
  }

  async function navigate(): Promise<void> {
    if (!active) return
    const next = await host.navigateBrowser(browserHost, active.id, address)
    setState(next)
  }

  async function goBack(): Promise<void> {
    if (active) setState(await host.browserBack(browserHost, active.id))
  }

  async function goForward(): Promise<void> {
    if (active) setState(await host.browserForward(browserHost, active.id))
  }

  async function reload(): Promise<void> {
    if (active) setState(await host.browserReload(browserHost, active.id))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-[36px] flex-none items-end gap-1 overflow-x-auto border-b border-hairline bg-panel px-1.5 pt-1">
        {state.tabs.map((tab) => {
          const selected = tab.id === active?.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => void activateTab(tab.id)}
              className={`flex h-[28px] max-w-[200px] flex-none items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-[12px] ${
                selected
                  ? 'border-hairline-strong bg-surface text-fg-1'
                  : 'border-transparent text-fg-3 hover:bg-sunken hover:text-fg-2'
              }`}
              title={tab.url}
            >
              <span className="grid h-4 w-4 flex-none place-items-center rounded bg-sunken font-mono text-[9.5px] text-fg-3">
                {tab.loading ? '◌' : tab.url.startsWith('file:') ? '▤' : '◈'}
              </span>
              <span className="min-w-0 truncate">{tab.title || tab.url || '新标签'}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label="关闭标签"
                className="ml-1 grid h-4 w-4 flex-none place-items-center rounded text-[13px] text-fg-3 hover:bg-sunken hover:text-fg-1"
                onClick={(event) => {
                  event.stopPropagation()
                  void closeTab(tab.id)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  event.stopPropagation()
                  void closeTab(tab.id)
                }}
              >
                ×
              </span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={() => void createTab()}
          disabled={creating}
          className="mb-1 grid h-6 w-6 flex-none place-items-center rounded text-[15px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-40"
          aria-label="新建浏览器标签"
          title="新建标签"
        >
          ＋
        </button>
      </div>

      <div className="flex h-[40px] flex-none items-center gap-1 border-b border-hairline px-2">
        <button type="button" onClick={() => void goBack()} disabled={!active?.canGoBack} className="grid h-7 w-7 place-items-center rounded text-[14px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="后退">
          ‹
        </button>
        <button type="button" onClick={() => void goForward()} disabled={!active?.canGoForward} className="grid h-7 w-7 place-items-center rounded text-[14px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="前进">
          ›
        </button>
        <button type="button" onClick={() => void reload()} disabled={!active} className="grid h-7 w-7 place-items-center rounded text-[14px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="刷新">
          ↻
        </button>
        <div className="flex h-[25px] min-w-0 flex-1 items-center gap-1.5 rounded-md border border-hairline bg-panel px-1.5 focus-within:border-hairline-strong">
          <span className="font-mono text-[10px] text-fg-3">◎</span>
          <input
            ref={addressRef}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => setAddressFocused(false)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              void navigate()
            }}
            placeholder="localhost:5173 或 file:///…"
            aria-label="浏览器地址"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-fg-2 outline-none placeholder:text-fg-3"
          />
          <span className="flex-none rounded-full border border-ok-line bg-ok-wash px-2 text-[10px] leading-5 text-ok">本地</span>
        </div>
        <button type="button" onClick={() => void navigate()} disabled={!active} className="grid h-7 w-7 place-items-center rounded text-[14px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="打开地址">
          ↵
        </button>
      </div>

      {agent && (
        <div className="flex h-[26px] flex-none items-center gap-1.5 border-b border-hairline bg-warn-wash px-2 text-[11px] text-warn">
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-warn" />
          <span className="min-w-0 truncate">Agent 正在操作 · {agent.label}</span>
          <span className="ml-auto flex-none font-mono text-[10px] opacity-70">{agent.tool}</span>
        </div>
      )}

      <div ref={pageRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface">
        {!active && !creating && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[12px] leading-6 text-fg-3">
            <div className="mb-2 text-[20px] text-fg-2">◎</div>
            <b className="mb-1 text-[13px] text-fg-2">还没有浏览器标签</b>
            点上方 ＋ 新建一个本地页面。
          </div>
        )}
        {/* 产品 agent 的区域 6：说明这块地方在等什么，而不是给一块白板 */}
        {blankPreview && !active?.error && !creating && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[12px] leading-6 text-fg-3">
            <div className="mb-2 text-[20px] text-fg-2">◎</div>
            <b className="mb-1 text-[13px] text-fg-2">这个 agent 还没有做出原型</b>
            它做出页面并打开之后，这里会显示出来。
            <br />
            也可以在对话里让它「在右边打开 preview/…」。
          </div>
        )}
        {active?.error && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[12px] leading-6 text-fg-3">
            <div className="mb-2 text-[20px] text-warn">!</div>
            <b className="mb-1 text-[13px] text-fg-2">页面加载失败</b>
            <span className="max-w-full break-words">{active.error}</span>
            <button type="button" onClick={() => void navigate()} className="mt-3 rounded border border-hairline-strong px-2.5 py-1 text-[11.5px] text-fg-2 hover:bg-sunken">
              重试
            </button>
          </div>
        )}
      </div>

      <div className="flex h-6 flex-none items-center gap-1.5 border-t border-hairline bg-panel px-2 text-[11px] text-fg-3">
        <span>本地页面</span>
        <span>·</span>
        <span>独立 session</span>
        {agent && (
          <span className="min-w-0 truncate text-fg-2" title={agent.label}>
            {agent.label}
          </span>
        )}
        <span className="ml-auto flex-none font-mono">WebContentsView</span>
      </div>
    </div>
  )
}
