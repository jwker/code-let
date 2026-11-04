import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserState, BrowserTabState } from '@contract/index'
import { host } from '../host'

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

export function BrowserPane() {
  const [state, setState] = useState<BrowserState>({ tabs: [], activeTabId: null, agent: null })
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

  useEffect(() => {
    let cancelled = false
    void host.getBrowserState().then((next) => {
      if (cancelled) return
      setState(next)
      if (next.tabs.length === 0) {
        setCreating(true)
        void host.createBrowserTab('about:blank').then((created) => {
          if (!cancelled) {
            setState(created)
            setCreating(false)
          }
        }).catch(() => {
          if (!cancelled) setCreating(false)
        })
      }
    })
    const off = host.onBrowserState((next) => {
      if (!cancelled) setState(next)
    })
    return () => {
      cancelled = true
      off()
      void host.setBrowserVisible(false)
    }
  }, [])

  useEffect(() => {
    if (!addressFocused) setAddress(displayUrl(active))
  }, [active?.id, active?.url, addressFocused])

  // 原生 view 的位置来自这块占位区的窗口坐标。面板拖动、侧栏收放、窗口缩放都走 ResizeObserver。
  useEffect(() => {
    const node = pageRef.current
    if (!node) return
    let frame = 0
    function report(): void {
      if (!node) return
      const rect = node.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) {
        void host.setBrowserVisible(false)
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

  // 页面报错时把原生 view 收起来，让下面的错误说明可见；没有标签时同理。
  useEffect(() => {
    void host.setBrowserVisible(Boolean(active) && !active?.error)
  }, [active?.id, active?.error])

  async function createTab(): Promise<void> {
    setCreating(true)
    try {
      const next = await host.createBrowserTab('about:blank')
      setState(next)
      requestAnimationFrame(() => addressRef.current?.focus())
    } finally {
      setCreating(false)
    }
  }

  async function closeTab(tabId: string): Promise<void> {
    const next = await host.closeBrowserTab(tabId)
    setState(next)
  }

  async function activateTab(tabId: string): Promise<void> {
    const next = await host.activateBrowserTab(tabId)
    setState(next)
  }

  async function navigate(): Promise<void> {
    if (!active) return
    const next = await host.navigateBrowser(active.id, address)
    setState(next)
  }

  async function goBack(): Promise<void> {
    if (active) setState(await host.browserBack(active.id))
  }

  async function goForward(): Promise<void> {
    if (active) setState(await host.browserForward(active.id))
  }

  async function reload(): Promise<void> {
    if (active) setState(await host.browserReload(active.id))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-[33px] flex-none items-end gap-1 overflow-x-auto border-b border-hairline bg-panel px-1.5 pt-1">
        {state.tabs.map((tab) => {
          const selected = tab.id === active?.id
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => void activateTab(tab.id)}
              className={`flex h-[25px] max-w-[170px] flex-none items-center gap-1.5 rounded-t-md border border-b-0 px-1.5 text-[9px] ${
                selected
                  ? 'border-hairline-strong bg-surface text-fg-1'
                  : 'border-transparent text-fg-3 hover:bg-sunken hover:text-fg-2'
              }`}
              title={tab.url}
            >
              <span className="grid h-3 w-3 flex-none place-items-center rounded bg-sunken font-mono text-[7px] text-fg-3">
                {tab.loading ? '◌' : tab.url.startsWith('file:') ? '▤' : '◈'}
              </span>
              <span className="min-w-0 truncate">{tab.title || tab.url || '新标签'}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label="关闭标签"
                className="ml-0.5 grid h-3.5 w-3.5 flex-none place-items-center rounded text-[12px] text-fg-3 hover:bg-sunken hover:text-fg-1"
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
          className="mb-px grid h-6 w-6 flex-none place-items-center rounded text-[15px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-40"
          aria-label="新建浏览器标签"
          title="新建标签"
        >
          ＋
        </button>
      </div>

      <div className="flex h-[35px] flex-none items-center gap-0.5 border-b border-hairline px-1.5">
        <button type="button" onClick={() => void goBack()} disabled={!active?.canGoBack} className="grid h-6 w-6 place-items-center rounded text-[13px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="后退">
          ‹
        </button>
        <button type="button" onClick={() => void goForward()} disabled={!active?.canGoForward} className="grid h-6 w-6 place-items-center rounded text-[13px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="前进">
          ›
        </button>
        <button type="button" onClick={() => void reload()} disabled={!active} className="grid h-6 w-6 place-items-center rounded text-[13px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="刷新">
          ↻
        </button>
        <div className="flex h-[25px] min-w-0 flex-1 items-center gap-1.5 rounded-md border border-hairline bg-panel px-1.5 focus-within:border-hairline-strong">
          <span className="font-mono text-[8px] text-fg-3">◎</span>
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
            className="min-w-0 flex-1 bg-transparent font-mono text-[8.5px] text-fg-2 outline-none placeholder:text-fg-3"
          />
          <span className="flex-none rounded-full border border-ok-line bg-ok-wash px-1.5 text-[7px] leading-4 text-ok">本地</span>
        </div>
        <button type="button" onClick={() => void navigate()} disabled={!active} className="grid h-6 w-6 place-items-center rounded text-[13px] text-fg-3 hover:bg-sunken hover:text-fg-1 disabled:opacity-30" aria-label="打开地址">
          ↵
        </button>
      </div>

      {agent && (
        <div className="flex h-[22px] flex-none items-center gap-1.5 border-b border-hairline bg-warn-wash px-2 text-[8px] text-warn">
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-warn" />
          <span className="min-w-0 truncate">Agent 正在操作 · {agent.label}</span>
          <span className="ml-auto flex-none font-mono text-[7px] opacity-70">{agent.tool}</span>
        </div>
      )}

      <div ref={pageRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface">
        {!active && !creating && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[10px] leading-6 text-fg-3">
            <div className="mb-2 text-[20px] text-fg-2">◎</div>
            <b className="mb-1 text-[11px] text-fg-2">还没有浏览器标签</b>
            点上方 ＋ 新建一个本地页面。
          </div>
        )}
        {active?.error && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[10px] leading-6 text-fg-3">
            <div className="mb-2 text-[20px] text-warn">!</div>
            <b className="mb-1 text-[11px] text-fg-2">页面加载失败</b>
            <span className="max-w-full break-words">{active.error}</span>
            <button type="button" onClick={() => void navigate()} className="mt-3 rounded border border-hairline-strong px-2 py-1 text-[9px] text-fg-2 hover:bg-sunken">
              重试
            </button>
          </div>
        )}
      </div>

      <div className="flex h-5 flex-none items-center gap-1.5 border-t border-hairline bg-panel px-2 text-[7.5px] text-fg-3">
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
