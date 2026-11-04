import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserBounds, BrowserState, BrowserTabState } from '@contract/index'

/**
 * 右侧浏览器会话。
 *
 * 每个标签一个独立的 WebContentsView；标签栏、地址栏仍在 React，
 * 页面内容由原生 view 叠在内容区上。这里只允许本地页面和被明确允许的协议。
 */

const MAX_DATA_URL = 4 * 1024 * 1024
const PARTITION = 'persist:codelet-browser'

interface Tab {
  id: string
  view: WebContentsView
  url: string
  title: string
  loading: boolean
  error: string | null
}

function localHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost')
  )
}

/** 地址栏输入 → 可加载 URL；不允许的地址返回错误文案 */
export function normalizeBrowserUrl(input: string): { url: string; error: string | null } {
  const raw = input.trim()
  if (!raw) return { url: 'about:blank', error: null }

  if (raw === 'about:blank') return { url: raw, error: null }
  if (raw.startsWith('javascript:')) {
    return raw.length > 64 * 1024
      ? { url: '', error: 'javascript: 地址太长' }
      : { url: raw, error: null }
  }
  if (raw.startsWith('data:')) {
    return raw.length > MAX_DATA_URL
      ? { url: '', error: 'data: 页面太大' }
      : { url: raw, error: null }
  }
  if (raw.startsWith('file:')) {
    try {
      const url = new URL(raw)
      if (!url.pathname) return { url: '', error: 'file: 地址缺少路径' }
      return { url: url.toString(), error: null }
    } catch {
      return { url: '', error: 'file: 地址格式不正确' }
    }
  }

  let candidate = raw
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(candidate)) {
    candidate = `http://${candidate}`
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { url: '', error: '地址格式不正确' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { url: '', error: `不支持的协议：${url.protocol}` }
  }
  if (!localHost(url.hostname)) {
    return { url: '', error: '当前浏览器只打开本地页面（localhost / 127.0.0.1）' }
  }
  return { url: url.toString(), error: null }
}

export class BrowserManager {
  private readonly tabs: Tab[] = []
  private activeTabId: string | null = null
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private visible = false
  private seq = 0
  private permissionConfigured = false
  private disposed = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly onChange: (state: BrowserState) => void
  ) {}

  state(): BrowserState {
    return {
      tabs: this.tabs.map((tab) => this.publicTab(tab)),
      activeTabId: this.activeTabId
    }
  }

  getState(): Promise<BrowserState> {
    return Promise.resolve(this.state())
  }

  async create(url = 'about:blank'): Promise<BrowserState> {
    const tab = this.createTab()
    this.activeTabId = tab.id
    this.applyVisibility()
    await this.load(tab, url)
    this.emit()
    return this.state()
  }

  close(tabId: string): Promise<BrowserState> {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return Promise.resolve(this.state())
    const [tab] = this.tabs.splice(index, 1)
    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id ?? null
      this.applyVisibility()
    }
    this.emit()
    return Promise.resolve(this.state())
  }

  activate(tabId: string): Promise<BrowserState> {
    if (this.tabs.some((tab) => tab.id === tabId)) {
      this.activeTabId = tabId
      this.applyVisibility()
      this.emit()
    }
    return Promise.resolve(this.state())
  }

  async navigate(tabId: string, input: string): Promise<BrowserState> {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (!tab) return this.state()
    const normalized = normalizeBrowserUrl(input)
    if (normalized.error) {
      tab.error = normalized.error
      this.emit()
      return this.state()
    }
    tab.error = null
    if (normalized.url.startsWith('javascript:')) {
      try {
        await tab.view.webContents.executeJavaScript(normalized.url.slice('javascript:'.length))
      } catch (error) {
        tab.error = error instanceof Error ? error.message : String(error)
      }
      this.emit()
      return this.state()
    }
    await this.load(tab, normalized.url)
    return this.state()
  }

  back(tabId: string): Promise<BrowserState> {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (tab?.view.webContents.canGoBack()) tab.view.webContents.goBack()
    return Promise.resolve(this.state())
  }

  forward(tabId: string): Promise<BrowserState> {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (tab?.view.webContents.canGoForward()) tab.view.webContents.goForward()
    return Promise.resolve(this.state())
  }

  reload(tabId: string): Promise<BrowserState> {
    const tab = this.tabs.find((item) => item.id === tabId)
    tab?.view.webContents.reload()
    return Promise.resolve(this.state())
  }

  setBounds(bounds: BrowserBounds): Promise<void> {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    }
    this.applyBounds()
    return Promise.resolve()
  }

  setVisible(visible: boolean): Promise<void> {
    this.visible = visible
    this.applyVisibility()
    return Promise.resolve()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const tab of this.tabs.splice(0)) {
      try {
        this.win.contentView.removeChildView(tab.view)
      } catch {
        // 窗口已经进入销毁流程时 contentView 可能不可用
      }
      try {
        tab.view.webContents.close()
      } catch {
        // 同上：关闭浏览器标签失败不能让应用退不出去
      }
    }
    this.activeTabId = null
  }

  /** 给 agent 用的工具入口；所有操作仍然走同一批标签 */
  async tool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tab = this.tabs.find((item) => item.id === (typeof args.tabId === 'string' ? args.tabId : '')) ??
      this.tabs.find((item) => item.id === this.activeTabId) ??
      this.tabs[0]
    const url = typeof args.url === 'string' ? args.url : ''

    if (tool === 'tabs') return this.state()
    if (tool === 'open') return this.create(url || 'about:blank')
    if (!tab) throw new Error('没有打开的浏览器标签')

    if (tool === 'activate') {
      return args.tabId ? this.activate(String(args.tabId)) : this.state()
    }
    if (tool === 'close') return this.close(tab.id)
    if (tool === 'back') return this.back(tab.id)
    if (tool === 'forward') return this.forward(tab.id)
    if (tool === 'reload') return this.reload(tab.id)
    if (tool === 'navigate') {
      if (!url) throw new Error('navigate 需要 url')
      return this.navigate(tab.id, url)
    }
    if (tool === 'snapshot') return this.snapshot(tab.id)
    if (tool === 'click') {
      const ref = typeof args.ref === 'string' ? args.ref : ''
      if (!/^e\d+$/.test(ref)) throw new Error('click 需要快照里的元素 ref')
      const clicked = await tab.view.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-codelet-ref="${ref}"]'); if (!el) return false; el.click(); return true })()`
      )
      if (!clicked) throw new Error(`找不到元素 ${ref}`)
      return { clicked: ref, url: tab.view.webContents.getURL() }
    }
    if (tool === 'type') {
      const ref = typeof args.ref === 'string' ? args.ref : ''
      const text = typeof args.text === 'string' ? args.text : ''
      if (!/^e\d+$/.test(ref)) throw new Error('type 需要快照里的元素 ref')
      const changed = await tab.view.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-codelet-ref="${ref}"]');
          if (!el) return false;
          el.focus();
          if ('value' in el) el.value = ${JSON.stringify(text)};
          else el.textContent = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`
      )
      if (!changed) throw new Error(`找不到元素 ${ref}`)
      return { typed: ref, url: tab.view.webContents.getURL() }
    }
    throw new Error(`不支持的浏览器工具：${tool}`)
  }

  private async snapshot(tabId: string): Promise<unknown> {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (!tab) throw new Error('没有打开的浏览器标签')
    return tab.view.webContents.executeJavaScript(
      `(() => {
        const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"]'))
          .slice(0, 80)
          .map((element, index) => {
            const ref = 'e' + (index + 1);
            element.setAttribute('data-codelet-ref', ref);
            const text = (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').trim();
            return {
              ref,
              tag: element.tagName.toLowerCase(),
              text: text.slice(0, 160),
              ...(element.type ? { type: element.type } : {})
            };
          });
        return {
          tabId: ${JSON.stringify(tabId)},
          url: location.href,
          title: document.title,
          text: (document.body && document.body.innerText || '').slice(0, 12000),
          elements
        };
      })()`
    )
  }

  private createTab(): Tab {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    const tab: Tab = {
      id: `browser-${++this.seq}`,
      view,
      url: 'about:blank',
      title: '新标签',
      loading: false,
      error: null
    }

    view.setBackgroundColor('#ffffff')
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.setVisualZoomLevelLimits(1, 3)

    if (!this.permissionConfigured) {
      this.permissionConfigured = true
      view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
        callback(false)
      })
    }

    view.webContents.on('will-navigate', (event, target) => {
      const normalized = normalizeBrowserUrl(target)
      if (normalized.error) {
        event.preventDefault()
        tab.error = normalized.error
        this.emit()
      }
    })
    view.webContents.on('did-start-loading', () => {
      tab.loading = true
      tab.error = null
      this.emit()
    })
    view.webContents.on('did-stop-loading', () => {
      tab.loading = false
      this.emit()
    })
    view.webContents.on('did-navigate', (_event, target) => {
      tab.url = target
      tab.error = null
      this.emit()
    })
    view.webContents.on('did-navigate-in-page', (_event, target) => {
      tab.url = target
      this.emit()
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || '新标签'
      this.emit()
    })
    view.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      tab.loading = false
      tab.error = `${description}（${code}）`
      if (validatedURL) tab.url = validatedURL
      this.emit()
    })
    view.webContents.on('render-process-gone', (_event, details) => {
      tab.loading = false
      tab.error = `页面进程退出：${details.reason}`
      this.emit()
    })

    this.win.contentView.addChildView(view)
    this.tabs.push(tab)
    view.setVisible(false)
    view.setBounds(this.bounds)
    return tab
  }

  private async load(tab: Tab, input: string): Promise<void> {
    const normalized = normalizeBrowserUrl(input)
    if (normalized.error) {
      tab.error = normalized.error
      this.emit()
      return
    }
    if (normalized.url === 'about:blank') {
      tab.url = 'about:blank'
      tab.title = '新标签'
      tab.error = null
      await tab.view.webContents.loadURL('about:blank')
      this.emit()
      return
    }
    if (normalized.url.startsWith('javascript:')) {
      await tab.view.webContents.executeJavaScript(normalized.url.slice('javascript:'.length))
      return
    }
    try {
      await tab.view.webContents.loadURL(normalized.url)
    } catch (error) {
      tab.loading = false
      tab.error = error instanceof Error ? error.message : String(error)
      this.emit()
    }
  }

  private applyBounds(): void {
    for (const tab of this.tabs) tab.view.setBounds(this.bounds)
  }

  private applyVisibility(): void {
    for (const tab of this.tabs) {
      const active = tab.id === this.activeTabId
      tab.view.setBounds(this.bounds)
      tab.view.setVisible(this.visible && active)
    }
  }

  private publicTab(tab: Tab): BrowserTabState {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: tab.view.webContents.canGoBack(),
      canGoForward: tab.view.webContents.canGoForward(),
      error: tab.error
    }
  }

  private emit(): void {
    this.onChange(this.state())
  }
}
