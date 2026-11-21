import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AnnotationState,
  BlockCitation,
  BrowserState,
  BrowserTabState,
  PreviewEntry
} from '@contract/index'
import { blockKey, blockLabel } from '@contract/index'
import { isAgentBrowserHost, type BrowserHost } from '@contract/browser'
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

/** 原型列表里的修改时间：紧凑到分钟，够排序对照就行 */
function formatPrototypeTime(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 没有引用时的空数组 —— 保持引用稳定，免得角标同步 effect 每帧都跑 */
const NO_CITATIONS: BlockCitation[] = []

/** 预览工具栏上的一个小按钮（标注 / 编号 / 清单共用一套样式） */
function AnnotationToolButton({
  label,
  icon,
  title,
  pressed,
  disabled,
  onClick
}: {
  label: string
  icon: string
  title: string
  pressed: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-[23px] flex-none items-center gap-1 rounded border px-2 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        pressed
          ? 'border-accent bg-accent text-accent-fg'
          : 'border-transparent text-fg-3 hover:bg-sunken hover:text-fg-1'
      }`}
    >
      {icon} {label}
    </button>
  )
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
  const isAgentHost = isAgentBrowserHost(browserHost)
  /** 预览宿主的 id —— 标注状态、引用都按它记 */
  const agentId = isAgentHost ? browserHost.slice('agent:'.length) : ''
  const annotation: AnnotationState | null = useStore((s) => s.annotations[browserHost] ?? null)
  const annotationEnabled = annotation?.enabled === true
  /** 编号显示着吗（关掉后角标与描边全隐，号还在） */
  const numbersVisible = annotation?.numbers !== false
  const citations = useStore((s) => (agentId ? (s.citations[agentId] ?? NO_CITATIONS) : NO_CITATIONS))
  /** 标注清单展开着吗 —— 纯界面状态，切到另一个宿主的预览时收起来 */
  const [listOpen, setListOpen] = useState(false)
  /** 没有可恢复的地址时，预览区该显示什么（原型目录的列表或空态） */
  const [entry, setEntry] = useState<PreviewEntry | null>(null)
  /** 只有一张 about:blank 的空白标签：还没做出任何页面 */
  const blankPreview = isAgentHost && (!active || active.url === 'about:blank')

  useEffect(() => {
    let cancelled = false
    setEntry(null)
    void (async () => {
      const next = await host.getBrowserState(browserHost)
      if (cancelled) return
      setState(next)
      if (next.tabs.length > 0) return
      if (isAgentHost) {
        // 有可恢复的地址就开回来；否则拿到目录列表 / 空态
        const preview = await host.getPreviewEntry(browserHost)
        if (cancelled) return
        if (preview.kind === 'restore') {
          const restored = await host.getBrowserState(browserHost)
          if (!cancelled) setState(restored)
          return
        }
        setEntry(preview)
      }
      setCreating(true)
      try {
        const created = await host.createBrowserTab(browserHost, 'about:blank')
        if (!cancelled) setState(created)
      } catch {
        // 建不出标签就留着列表/空态，别把整块地方变成白板
      } finally {
        if (!cancelled) setCreating(false)
      }
    })()
    const off = host.onBrowserState((event) => {
      // 两个宿主各推各的 —— 只收自己那一份
      if (cancelled || event.host !== browserHost) return
      setState(event.state)
    })
    /*
     * 标注状态（开关、块登记）跟浏览器状态分开走：它只对 agent 预览有意义，
     * 而且要在切宿主、切面板之后恢复。进来先取一次，之后跟事件。
     */
    if (isAgentHost) {
      void host.getAnnotation(browserHost).then((next) => {
        if (!cancelled) useStore.getState().setAnnotation(next)
      })
    }
    const offAnnotation = host.onAnnotation((event) => {
      if (cancelled || event.host !== browserHost) return
      useStore.getState().setAnnotation(event.state)
      // 点了一块：「#4」落进输入框，角标跟着这个引用常驻
      if (event.picked && event.state.file && agentId) {
        useStore.getState().addCitation(agentId, { file: event.state.file, ...event.picked })
      }
    })
    return () => {
      cancelled = true
      off()
      offAnnotation()
      void host.setBrowserVisible(browserHost, false)
    }
  }, [browserHost, isAgentHost, agentId])

  /** 角标跟着输入框里的引用走：加一个多一个，删掉一起撤 */
  useEffect(() => {
    if (!isAgentHost) return
    void host.setAnnotationBadges(
      browserHost,
      citations.map((item) => blockKey(item)),
      numbersVisible
    )
  }, [browserHost, isAgentHost, citations, numbersVisible])

  // 切换宿主时 React 会复用同一个组件实例（props 变了而已）：清单要跟着收起来
  useEffect(() => {
    setListOpen(false)
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
        useStore.getState().setBrowserSpan(null)
        void host.setBrowserVisible(browserHost, false)
        return
      }
      // 浮层要判断自己会不会盖住这块原生视图（`shell/overlay.ts`）
      useStore.getState().setBrowserSpan({ left: rect.left, width: rect.width })
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
      // 这块原生视图没了，浮层不用再为它让路
      useStore.getState().setBrowserSpan(null)
    }
  }, [])

  /*
   * 什么时候让原生 view 露出来。
   *
   * 三种情况都要收起：没有活动标签、页面报错（让错误说明可见）、
   * **有浮层开着**（气泡/菜单/对话框会被原生 view 盖住 —— 它永远画在 DOM 之上）。
   */
  /*
   * 只数**会盖住这块原生视图**的浮层 —— 窄轨上的气泡和菜单不在此列，
   * 不然鼠标扫过头像，右边的页面就整片消失。
   */
  const browserOverlayCount = useStore((s) => s.browserOverlayCount)
  useEffect(() => {
    /*
     * 空白预览也收起：原生 view 永远画在 DOM 之上，不收起来下面的空态文案
     * 会被一张白色的 about:blank 盖得看不见。
     */
    void host.setBrowserVisible(
      browserHost,
      Boolean(active) && !active?.error && browserOverlayCount === 0 && !blankPreview
    )
  }, [browserHost, active?.id, active?.url, active?.error, browserOverlayCount, blankPreview])

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

  /** 从原型列表里打开一个文件 —— 用空白标签导航，不在旁边再堆一个标签 */
  async function openPrototype(url: string): Promise<void> {
    const blank = state.tabs.find((tab) => tab.url === 'about:blank')
    setEntry(null)
    try {
      const next = blank
        ? await host.navigateBrowser(browserHost, blank.id, url)
        : await host.createBrowserTab(browserHost, url)
      setState(next)
    } catch {
      // 打开失败就把列表拿回来，让用户重选
      setEntry(await host.getPreviewEntry(browserHost))
    }
  }

  async function refreshPreviewEntry(): Promise<void> {
    setEntry(await host.getPreviewEntry(browserHost))
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

      {isAgentHost && (
        <div className="flex h-[32px] flex-none items-center gap-1.5 border-b border-hairline bg-panel px-2">
          <span className="min-w-0 truncate font-mono text-[11px] text-fg-3" title={annotation?.file ?? ''}>
            {annotation?.file ?? '还没有原型文件'}
          </span>
          <div className="ml-auto flex flex-none items-center gap-0.5">
            <AnnotationToolButton
              label="标注"
              icon="✎"
              title="打开后，页面里的点击用来选块；再点一次把点击还给原型"
              pressed={annotationEnabled}
              disabled={blankPreview}
              onClick={() => {
                void host.setAnnotation(browserHost, !annotationEnabled).then((next) => {
                  useStore.getState().setAnnotation(next)
                })
              }}
            />
            <AnnotationToolButton
              label="编号"
              icon="≡"
              title="关掉之后画面干净，号还在"
              pressed={numbersVisible}
              disabled={!annotation}
              onClick={() => {
                if (!annotation) return
                useStore.getState().setAnnotation({ ...annotation, numbers: !numbersVisible })
              }}
            />
            <AnnotationToolButton
              label="清单"
              icon="☰"
              title="列出这一页标过的块，点一条滚到那一块"
              pressed={listOpen}
              onClick={() => setListOpen((open) => !open)}
            />
          </div>
        </div>
      )}

      {annotationEnabled && (
        <div className="flex h-[26px] flex-none items-center gap-1.5 border-b border-hairline bg-accent-wash px-2 text-[11px] text-fg-2">
          <span className="h-1.5 w-1.5 flex-none rounded-full bg-fg-1" />
          <span className="min-w-0 truncate">标注模式 · 点击选块，不触发原型自己的交互 · Esc 退出</span>
        </div>
      )}

      {isAgentHost && listOpen && (
        <div
          role="group"
          aria-label="标注清单"
          className="flex max-h-[78px] flex-none flex-wrap items-center gap-1 overflow-y-auto border-b border-hairline bg-panel px-2 py-1.5"
        >
          {citations.length === 0 ? (
            <span className="text-[11px] text-fg-3">这一页还没有标过的块</span>
          ) : (
            citations.map((citation) => (
              <button
                key={`${citation.file}:${blockKey(citation)}`}
                type="button"
                title={citation.selector}
                onClick={() => void host.focusAnnotation(browserHost, blockKey(citation))}
                className="flex h-[21px] max-w-[260px] items-center gap-1.5 rounded-full border border-info-line bg-info-wash px-2 text-[10.5px] text-info transition-colors hover:border-info"
              >
                <span className="flex-none font-mono">{blockLabel(citation)}</span>
                <span className="min-w-0 truncate">{citation.text || citation.selector}</span>
              </button>
            ))
          )}
        </div>
      )}

      {agent && (
        <div className="flex h-[26px] flex-none items-center gap-1.5 border-b border-hairline bg-warn-wash px-2 text-[11px] text-warn">
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-warn" />
          <span className="min-w-0 truncate">Agent 正在操作 · {agent.label}</span>
          <span className="ml-auto flex-none font-mono text-[10px] opacity-70">{agent.tool}</span>
        </div>
      )}

      <div ref={pageRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface">
        {!active && !creating && !isAgentHost && (
          <div className="flex h-full flex-col items-center justify-center px-5 text-center text-[12px] leading-6 text-fg-3">
            <div className="mb-2 text-[20px] text-fg-2">◎</div>
            <b className="mb-1 text-[13px] text-fg-2">还没有浏览器标签</b>
            点上方 ＋ 新建一个本地页面。
          </div>
        )}
        {/*
          产品 agent 的区域 6：没有可恢复的地址时，列出项目的原型目录；
          目录空着或不存在，就说清楚是哪一种 —— 不再统一说成「还没做出原型」。
        */}
        {blankPreview && !active?.error && !creating && (
          <div className="flex h-full flex-col items-center justify-center px-5 py-4 text-center text-[12px] leading-6 text-fg-3">
            {entry?.kind === 'list' ? (
              <>
                <div className="mb-2 text-[20px] text-fg-2">◫</div>
                <b className="mb-0.5 text-[13px] text-fg-2">
                  原型目录里有 {entry.listing.files.length} 个页面
                </b>
                <div className="mb-3 max-w-full break-all font-mono text-[10.5px]">
                  {entry.listing.dir}
                </div>
                <div
                  aria-label="原型文件"
                  className="flex max-h-[70%] w-full max-w-[420px] flex-col gap-1 overflow-y-auto"
                >
                  {entry.listing.files.map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      title={file.path}
                      onClick={() => void openPrototype(file.url)}
                      className="flex flex-none items-center gap-2 rounded-md border border-hairline bg-raised px-2.5 py-1.5 text-left text-[12px] text-fg-2 transition-colors hover:border-hairline-strong hover:bg-sunken"
                    >
                      <span className="flex-none text-fg-3">&lt;&gt;</span>
                      <span className="min-w-0 flex-1 truncate font-mono">{file.name}</span>
                      <span className="flex-none font-mono text-[10px] text-fg-3">
                        {formatPrototypeTime(file.modified)}
                      </span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => void refreshPreviewEntry()}
                    className="mt-1 flex-none rounded-md border border-dashed border-hairline px-2.5 py-1 text-[11px] text-fg-3 hover:border-hairline-strong hover:text-fg-2"
                  >
                    重新查找
                  </button>
                </div>
              </>
            ) : entry?.kind === 'empty' ? (
              entry.listing.exists ? (
                <>
                  <div className="mb-2 text-[20px] text-fg-2">◫</div>
                  <b className="mb-1 text-[13px] text-fg-2">原型目录里还没有页面</b>
                  <div className="mb-2 max-w-full break-all font-mono text-[10.5px]">
                    {entry.listing.dir}
                  </div>
                  让 agent 生成一个，或者把 .html 放进去。
                  <br />
                  放好之后点下面重新找一次。
                  <button
                    type="button"
                    onClick={() => void refreshPreviewEntry()}
                    className="mt-2 rounded border border-hairline-strong px-2.5 py-1 text-[11.5px] text-fg-2 hover:bg-sunken"
                  >
                    重新查找
                  </button>
                </>
              ) : (
                <>
                  <div className="mb-2 text-[20px] text-fg-2">◇</div>
                  <b className="mb-1 text-[13px] text-fg-2">这个项目还没有原型</b>
                  <div className="mb-1 max-w-full break-all font-mono text-[10.5px]">
                    {entry.listing.dir || '项目的原型目录'}
                  </div>
                  产品 agent 做出原型之后会写到这里；
                  <br />
                  也可以在对话里让它「做一个原型」。
                </>
              )
            ) : null}
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
