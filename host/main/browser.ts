import { BrowserWindow, WebContentsView } from 'electron'
import type {
  BrowserAgentActivity,
  BrowserBounds,
  BrowserState,
  BrowserTabState
} from '@contract/index'

/**
 * 右侧浏览器会话。
 *
 * 每个标签一个独立的 WebContentsView；标签栏、地址栏仍在 React，
 * 页面内容由原生 view 叠在内容区上。这里只允许本地页面和被明确允许的协议。
 */

const MAX_DATA_URL = 4 * 1024 * 1024
const PARTITION = 'persist:codelet-browser'
/** 页面里最多给多少个可交互元素编号 */
const MAX_ELEMENTS = 1000
/** 一次快照默认返回多少个元素 */
const DEFAULT_PAGE_SIZE = 80
/** 一次快照最多返回多少个元素 */
const MAX_PAGE_SIZE = 200
/** 截图进模型前缩到多长 */
const SCREENSHOT_MAX_EDGE = 1024
/** 截图 base64 上限 —— 再大只会吃 token */
const SCREENSHOT_MAX_BASE64 = 400_000
/** browser_wait 的默认等待上限 */
const WAIT_MAX_MS = 30_000

interface Tab {
  id: string
  view: WebContentsView
  url: string
  title: string
  loading: boolean
  error: string | null
  /** 这个页面上的元素引用计数器；换页就重来 */
  refSeq: number
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
  // "localhost:5173" 看着像协议，其实是主机 + 端口；真正带协议的写法一定有 "//"。
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(candidate)) {
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
      activeTabId: this.activeTabId,
      agent: this.agentActivity
    }
  }

  /** 最近一次 agent 操作 —— 面板上给用户看 */
  private agentActivity: BrowserAgentActivity | null = null
  private agentTimer: ReturnType<typeof setTimeout> | null = null

  private noteAgent(tool: string, label: string, ref?: string): void {
    this.agentActivity = { tool, label, ...(ref ? { ref } : {}), at: Date.now() }
    // 过一会儿自己收起：agent 不再动作时，面板上不该一直挂着提示
    if (this.agentTimer) clearTimeout(this.agentTimer)
    this.agentTimer = setTimeout(() => {
      this.agentActivity = null
      this.agentTimer = null
      this.emit()
    }, 6000)
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
    if (this.agentTimer) clearTimeout(this.agentTimer)
    this.agentTimer = null
  }

  /** 给 agent 用的工具入口；所有操作仍然走同一批标签 */
  async tool(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const tab = this.tabs.find((item) => item.id === (typeof args.tabId === 'string' ? args.tabId : '')) ??
      this.tabs.find((item) => item.id === this.activeTabId) ??
      this.tabs[0]
    const url = typeof args.url === 'string' ? args.url : ''

    if (tool === 'tabs') return this.state()
    if (tool === 'open') {
      this.noteAgent('browser_open', `打开 ${url || '空白页'}`)
      return this.create(url || 'about:blank')
    }
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
      this.noteAgent('browser_navigate', `导航到 ${url}`)
      return this.navigate(tab.id, url)
    }
    if (tool === 'snapshot') {
      const offset = Number.isInteger(args.offset) ? Number(args.offset) : 0
      const limit = Number.isInteger(args.limit) ? Number(args.limit) : DEFAULT_PAGE_SIZE
      return this.snapshot(tab.id, Math.max(0, offset), Math.min(MAX_PAGE_SIZE, Math.max(1, limit)))
    }
    if (tool === 'click') {
      const ref = typeof args.ref === 'string' ? args.ref : ''
      if (!/^e\d+$/.test(ref)) throw new Error('click 需要快照里的元素 ref')
      const clicked = await tab.view.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-codelet-ref="${ref}"]'); if (!el) return false; el.click(); return true })()`
      )
      if (!clicked) throw new Error(`找不到元素 ${ref}`)
      const label = await this.describeElement(tab, ref)
      this.noteAgent('browser_click', `点击 ${label}`, ref)
      this.highlight(tab, ref)
      this.emit()
      return { clicked: ref, label, url: tab.view.webContents.getURL() }
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
      const label = await this.describeElement(tab, ref)
      this.noteAgent('browser_type', `在 ${label} 输入 ${text.length} 个字符`, ref)
      this.highlight(tab, ref)
      this.emit()
      return { typed: ref, label, url: tab.view.webContents.getURL() }
    }
    if (tool === 'screenshot') {
      this.noteAgent('browser_screenshot', '截取页面')
      return this.screenshot(tab.id)
    }
    if (tool === 'wait') {
      const selector = typeof args.selector === 'string' ? args.selector : ''
      const timeout = Math.min(
        WAIT_MAX_MS,
        Number.isInteger(args.timeoutMs) ? Math.max(0, Number(args.timeoutMs)) : 10_000
      )
      const result = await this.wait(tab, selector, timeout)
      this.noteAgent('browser_wait', selector ? `等待 ${selector}` : '等待页面稳定')
      this.emit()
      return result
    }
    throw new Error(`不支持的浏览器工具：${tool}`)
  }

  /** 快照里元素的可读名字；agent 的日志要给人看 */
  private async describeElement(tab: Tab, ref: string): Promise<string> {
    const text = await tab.view.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-codelet-ref="${ref}"]');
        if (!el) return '';
        return (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.tagName).trim().slice(0, 60);
      })()`
    )
    return typeof text === 'string' && text ? text : ref
  }

  /** 给 agent 操作的元素加一圈临时高亮，让用户看得见它在动哪里 */
  private highlight(tab: Tab, ref: string): void {
    void tab.view.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-codelet-ref="${ref}"]');
        if (!el) return false;
        const previous = el.getAttribute('data-codelet-outline');
        el.setAttribute('data-codelet-outline', '1');
        el.style.outline = '2px solid #356A9A';
        el.style.outlineOffset = '2px';
        el.style.borderRadius = '4px';
        setTimeout(() => {
          if (previous) el.setAttribute('data-codelet-outline', previous);
          else el.removeAttribute('data-codelet-outline');
          el.style.outline = '';
          el.style.outlineOffset = '';
        }, 1600);
        return true;
      })()`
    ).catch(() => {
      // 高亮失败不影响操作本身
    })
  }

  /**
   * 等待条件成立。
   *
   * selector 非空时等它出现；否则等页面进入 complete 且没有正在进行的请求。
   */
  private async wait(tab: Tab, selector: string, timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ready = await tab.view.webContents.executeJavaScript(
        selector
          ? `(() => !!document.querySelector(${JSON.stringify(selector)}))()`
          : `(() => document.readyState === 'complete')()`
      ).catch(() => false)
      if (ready) return { ok: true, waited: true, selector: selector || null }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    return { ok: false, waited: false, timedOut: true, selector: selector || null }
  }

  /** 截当前页面；缩到模型能看的大小 */
  private async screenshot(tabId: string): Promise<unknown> {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (!tab) throw new Error('没有打开的浏览器标签')
    try {
      const image = await tab.view.webContents.capturePage()
      const size = image.getSize()
      if (size.width === 0 || size.height === 0) {
        return { ok: false, error: '页面还没有可截取的内容' }
      }
      const longest = Math.max(size.width, size.height)
      const scale = longest > SCREENSHOT_MAX_EDGE ? SCREENSHOT_MAX_EDGE / longest : 1
      const resized =
        scale < 1
          ? image.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: 'good'
            })
          : image
      const buffer = resized.toJPEG(80)
      const data = buffer.toString('base64')
      if (data.length > SCREENSHOT_MAX_BASE64) {
        return {
          ok: false,
          error: '截图太大，没有返回图片',
          bytes: buffer.length
        }
      }
      return {
        ok: true,
        mimeType: 'image/jpeg',
        data,
        width: resized.getSize().width,
        height: resized.getSize().height
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async snapshot(tabId: string, offset: number, limit: number): Promise<unknown> {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (!tab) throw new Error('没有打开的浏览器标签')
    const raw = await tab.view.webContents.executeJavaScript(
      `(() => {
        const all = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[onclick]'));
        const elements = all.slice(0, ${MAX_ELEMENTS}).map((element, index) => {
          const ref = 'e' + (index + 1);
          element.setAttribute('data-codelet-ref', ref);
          const text = (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.getAttribute('name') || '').trim();
          const rect = element.getBoundingClientRect();
          return {
            ref,
            tag: element.tagName.toLowerCase(),
            text: text.slice(0, 160),
            ...(element.type ? { type: element.type } : {}),
            visible: rect.width > 0 && rect.height > 0
          };
        });
        return {
          tabId: ${JSON.stringify(tabId)},
          url: location.href,
          title: document.title,
          text: (document.body && document.body.innerText || '').slice(0, 12000),
          elements,
          total: all.length
        };
      })()`
    )
    const data = raw as {
      tabId: string
      url: string
      title: string
      text: string
      elements: Array<{ ref: string; tag: string; text: string; type?: string; visible?: boolean }>
      total: number
    }
    const page = data.elements.slice(offset, offset + limit)
    return {
      tabId: data.tabId,
      url: data.url,
      title: data.title,
      text: data.text,
      elements: page.map(({ visible, ...rest }) => rest),
      total: data.total,
      offset,
      hasMore: offset + page.length < data.total
    }
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
      error: null,
      refSeq: 0
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
