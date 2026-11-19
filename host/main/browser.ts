import { BrowserWindow, ipcMain, WebContentsView, type IpcMainEvent } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, sep } from 'node:path'
import {
  BROWSER_ANNOTATION_CHANNEL,
  type AnnotationEvent,
  type AnnotationState,
  type BlockCitation,
  type BrowserAgentActivity,
  type BrowserBounds,
  type BrowserState,
  type BrowserTabState,
  type PreviewBlock
} from '@contract/index'
import { agentIdOfHost } from '@contract/browser'
import {
  BrowserPools,
  PROJECT_BROWSER,
  agentBrowserHost,
  isAgentBrowserHost,
  type BrowserHost
} from './browserPools'
import { ANNOTATION_SCRIPT } from './annotationScript'
import { PrototypeWatch } from './prototypeWatch'
import { checkAnchors, readAnchors, type AnchorBreak, type FileAnchor } from './anchorCheck'
import {
  assignTemp,
  promotedBlock,
  resolveBlockKey,
  resolveCitation,
  type TempAssignment
} from './annotation'

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
/** 一次截图最多进模型多少 base64 字符 */
const SCREENSHOT_MAX_BASE64 = 400_000
/** 主进程产物目录 —— 浏览器视图的 preload 跟主进程在同一个 out 里 */
const currentDir = dirname(fileURLToPath(import.meta.url))
/** browser_wait 的默认等待上限 */
const WAIT_MAX_MS = 30_000

/** 一个宿主的标注登记 —— 主进程是「引用载荷 / 角标 / 块清单」的唯一数据源 */
interface AnnotationRecord {
  /** 标注模式开着吗 */
  enabled: boolean
  /** 当前页面对应的原型文件（相对项目根；不是本地文件时是 URL） */
  file: string | null
  /** 当前页面的块登记 */
  blocks: PreviewBlock[]
  /** 哪些块该显示常驻角标（键是块号或临时号） */
  badges: string[]
  /** 编号显示着吗；关掉后角标与描边全隐，号还在 */
  numbers: boolean
  /** 临时号的分配表：只活在本次运行里，不写进用户的文件 */
  temps: TempAssignment[]
  /** 保号校验的记账：这一轮开始时的锚点 + 已经消失、还没回来的号 */
  anchors: AnchorRecord
}

/** 保号校验跨轮记着的东西 */
interface AnchorRecord {
  /** 这一轮开始时文件里的块号 → 文字；这一轮没读到基线就是 null */
  before: Record<number, string> | null
  /** 已经消失、还没回来的号 → 消失前那一段的文字 */
  missing: Record<number, string>
  /** before 对应哪个文件；换文件就重新来过 */
  file: string | null
}

/** 一轮结束时的结论 */
export interface TurnEndResult {
  /** 原型文件（相对项目根）；没有预览文件时为 null */
  file: string | null
  /** 保号校验发现的破坏；空数组 = 号没动过 */
  breaks: AnchorBreak[]
}

/**
 * 把页面报上来的块洗干净。
 *
 * 页面是 agent 写出来的东西，不能当可信输入：块号必须是正整数，
 * 选择器和文字都要截断。认不出来、或者选择器为空就丢掉。
 */
function sanitizeBlock(value: unknown): PreviewBlock | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const block =
    typeof raw.block === 'number' && Number.isInteger(raw.block) && raw.block > 0 ? raw.block : null
  const temp = typeof raw.temp === 'string' && raw.temp ? raw.temp.slice(0, 12) : null
  const selector = typeof raw.selector === 'string' ? raw.selector.trim().slice(0, 2000) : ''
  if (!selector) return null
  return {
    block,
    temp: block === null ? temp : null,
    anchor:
      typeof raw.anchor === 'string' && raw.anchor
        ? raw.anchor.slice(0, 200)
        : block !== null
          ? `data-block="${block}"`
          : null,
    selector,
    text: typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
  }
}

/** 块登记里的一项：必须已经有身份（块号或临时号） */
export function readPreviewBlock(value: unknown): PreviewBlock | null {
  const block = sanitizeBlock(value)
  return block && (block.block !== null || block.temp !== null) ? block : null
}

/**
 * 用户点中的一块：还没有锚点的块在分配临时号之前也没有身份，
 * 但选择器和文字已经有了 —— 照样收下来。
 *
 * 页面报上来的临时号一律丢掉：号只能由主进程分配（分配表也在主进程），
 * 页面自己写一个 T1 会被当成别人那一块。
 */
export function readBlockCandidate(value: unknown): PreviewBlock | null {
  const block = sanitizeBlock(value)
  return block ? { ...block, temp: null } : null
}

/** 原型文件的绝对路径。只有本地文件有；http 页面、空白页都没有文件可看 */
export function prototypePathOf(url: string): string | null {
  if (!url || !url.startsWith('file:')) return null
  try {
    return fileURLToPath(url)
  } catch {
    return null
  }
}

/** 锚点列表 → 块号到文字的映射（保号校验的基线） */
function toRecord(anchors: FileAnchor[]): Record<number, string> {
  const record: Record<number, string> = {}
  for (const anchor of anchors) record[anchor.block] = anchor.text
  return record
}

/**
 * 记录下来的预览地址还能不能用。
 *
 * 只认本地文件（`file:`）—— http 预览（dev server）下次启动多半没起，
 * 恢复出一个加载失败的页面比空态更糟。文件不在了也当没有记录。
 * 存在性从外面传进来，测试不用碰磁盘。
 */
export function restorablePreviewUrl(
  url: string | null | undefined,
  fileExists: (path: string) => boolean = existsSync
): string | null {
  if (!url) return null
  const path = prototypePathOf(url)
  if (!path || !fileExists(path)) return null
  return url
}

/** 从页面 URL 算出引用载荷里的「文件」：项目内的本地文件用相对路径 */
export function previewFileOf(url: string, cwd: string | null): string | null {
  if (!url || url === 'about:blank') return null
  if (!url.startsWith('file:')) return url
  const absolute = prototypePathOf(url)
  if (!absolute) return url
  if (!cwd) return absolute
  const rel = relative(cwd, absolute)
  if (!rel || rel.startsWith('..')) return absolute
  return rel.split(sep).join('/')
}

interface Tab {
  id: string
  /** 这条标签属于哪个宿主 —— 事件回调里要靠它知道推给谁 */
  host: BrowserHost
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

/** BrowserManager 的外围依赖 —— 全是回调，构造时一次给齐 */
export interface BrowserManagerOptions {
  /** 标签状态变了 */
  onChange: (host: BrowserHost, state: BrowserState) => void
  /** 标注状态变了（开关、块登记重建、用户点了一块） */
  onAnnotation?: (event: AnnotationEvent) => void
  /** 宿主对应的项目目录 —— 引用载荷里的「文件」要相对它 */
  cwdForHost?: (host: BrowserHost) => string | null
  /** 某个 agent 的预览换成了这个本地地址 */
  onPreviewUrl?: (agentId: string, url: string) => void
}

export class BrowserManager {
  /**
   * 按宿主分开的标签池（PLAN.md D57）。
   *
   * `project` 是窄轨里那个入口，`agent:<id>` 是某个 agent 自己的预览。
   * 分开是为了让 agent 的工具碰不到用户正在看的那一页。
   */
  private readonly pools = new BrowserPools<Tab>()
  /** 现在显示的是哪个宿主的浏览器（同一时刻只有一个 WebContentsView 挂在窗口上） */
  private visibleHost: BrowserHost | null = null
  private bounds: BrowserBounds = { x: 0, y: 0, width: 0, height: 0 }
  private seq = 0
  private permissionConfigured = false
  private disposed = false
  /** 按宿主分开的标注登记（页面刷新后重建，只活在本次运行内） */
  private readonly annotations = new Map<BrowserHost, AnnotationRecord>()
  /** 「这一轮动过原型文件没有」的记账 —— 轮结束时决定要不要自动刷新 */
  private readonly watch = new PrototypeWatch()

  private readonly win: BrowserWindow
  private readonly onChange: (host: BrowserHost, state: BrowserState) => void
  /** 标注状态变了（开关、块登记重建、用户点了一块） */
  private readonly onAnnotation: (event: AnnotationEvent) => void
  /** 宿主对应的项目目录 —— 引用载荷里的「文件」要相对它 */
  private readonly cwdForHost: (host: BrowserHost) => string | null
  /** 某个 agent 的预览换成了这个本地地址 —— 宿主记下来，下次启动按它恢复 */
  private readonly onPreviewUrl: (agentId: string, url: string) => void
  /**
   * 已经尝试过恢复的宿主。
   *
   * 一次运行只恢复一次：用户自己关掉了预览标签，切回来的时候不该又冒出来。
   */
  private readonly previewRestored = new Set<BrowserHost>()

  constructor(win: BrowserWindow, options: BrowserManagerOptions) {
    this.win = win
    this.onChange = options.onChange
    this.onAnnotation = options.onAnnotation ?? (() => {})
    this.cwdForHost = options.cwdForHost ?? (() => null)
    this.onPreviewUrl = options.onPreviewUrl ?? (() => {})
    /*
     * 原型页面的 preload 把注入脚本 post 出来的消息转到这里。
     * 建在管理器上而不是 IPC 注册处：要按 webContents 找到它属于哪个宿主。
     */
    ipcMain.on(BROWSER_ANNOTATION_CHANNEL, this.onPageMessage)
  }

  private annotationRecord(host: BrowserHost): AnnotationRecord {
    const found = this.annotations.get(host)
    if (found) return found
    const created: AnnotationRecord = {
      enabled: false,
      file: null,
      blocks: [],
      badges: [],
      numbers: true,
      temps: [],
      anchors: { before: null, missing: {}, file: null }
    }
    this.annotations.set(host, created)
    return created
  }

  annotationState(host: BrowserHost): AnnotationState {
    // 标注只作用于产品 agent 的预览宿主，项目级浏览器不参与
    if (!isAgentBrowserHost(host)) {
      return { host, enabled: false, numbers: true, file: null, blocks: [] }
    }
    const record = this.annotationRecord(host)
    return {
      host,
      enabled: record.enabled,
      numbers: record.numbers,
      file: record.file,
      blocks: record.blocks
    }
  }

  /** 开 / 关标注模式。项目级宿主恒为关 */
  async setAnnotation(host: BrowserHost, enabled: boolean): Promise<AnnotationState> {
    if (!isAgentBrowserHost(host)) return this.annotationState(host)
    const record = this.annotationRecord(host)
    record.enabled = enabled
    const tab = this.pools.active(host)
    if (tab) {
      await this.runAnnotation(tab, `setMode(${enabled ? 'true' : 'false'})`)
      // 顺手重建一次块登记 —— 页面里新加的块也能马上被点到
      await this.scanAnnotation(host, tab)
    }
    this.emitAnnotation(host)
    return this.annotationState(host)
  }

  /**
   * 同步常驻角标的集合与编号的显隐。
   *
   * 键跟着输入框里的引用走：加一个引用多一个角标，删掉引用角标一起撤掉。
   * numbers 是「编号」开关：关掉只是不画，号与引用都还在。
   */
  async setAnnotationBadges(host: BrowserHost, keys: string[], numbers: boolean): Promise<void> {
    if (!isAgentBrowserHost(host)) return
    const record = this.annotationRecord(host)
    record.badges = [...new Set(keys.filter((key) => key.length > 0))].slice(0, 500)
    record.numbers = numbers
    const tab = this.pools.active(host)
    if (tab) await this.pushBadges(tab, record)
  }

  /**
   * 滚到某一块 —— 标注清单里的条目点一下就用它。
   *
   * 块不在当前页面上（agent 重写过原型）时页面里什么也不会发生。
   */
  async focusAnnotation(host: BrowserHost, key: string): Promise<void> {
    if (!isAgentBrowserHost(host)) return
    const record = this.annotationRecord(host)
    const tab = this.pools.active(host)
    if (!tab) return
    // 临时号转正之后按块号找；还没转正就还是 T1（页面按选择器找）
    const resolved = resolveBlockKey(key, record.temps, record.blocks)
    await this.runAnnotation(tab, `focus(${JSON.stringify(resolved)})`)
  }

  /**
   * 把角标推给页面。
   *
   * 键先按最新登记解析：临时号转正之后画的是正式块号；还没转正的临时块
   * 没有 `data-block` 可找，所以连选择器一起给页面。
   */
  private async pushBadges(tab: Tab, record: AnnotationRecord): Promise<void> {
    const entries = record.badges.map((key) => ({
      key: resolveBlockKey(key, record.temps, record.blocks),
      selector: record.temps.find((item) => item.temp === key)?.selector ?? null
    }))
    await this.runAnnotation(
      tab,
      `setBadges(${JSON.stringify(entries)}, ${record.numbers ? 'true' : 'false'})`
    )
  }

  /** 在原型页面里执行一段 `__codeletAnnotation` 调用；页面没注入过时安静地失败 */
  private async runAnnotation(tab: Tab, call: string): Promise<void> {
    await tab.view.webContents
      .executeJavaScript(`window.__codeletAnnotation && window.__codeletAnnotation.${call}`)
      .catch(() => {
        // 页面刚导航、脚本还没装上 —— 下一张 did-finish-load 会重来
      })
  }

  /**
   * 给 agent 的块清单：跟渲染层标注看到的是同一份登记。
   *
   * 字段就是 `PreviewBlock`（块号 / 选择器 / 文字摘要 / 锚点）；
   * 还没转正的临时块 `block` 为 null、`temp` 是 T1 这样的号、`anchor` 也是 null。
   */
  blockList(host: BrowserHost): { file: string | null; blocks: PreviewBlock[] } {
    const state = this.annotationState(host)
    const record = this.annotationRecord(host)
    const temps = record.temps
      .filter((item) => promotedBlock(record.temps, state.blocks, item.temp) === null)
      .map((item) => ({
        block: null,
        temp: item.temp,
        anchor: null,
        selector: item.selector,
        text: item.text
      }))
    return { file: state.file, blocks: [...state.blocks, ...temps] }
  }

  /**
   * 一轮开始：记下预览文件的时间戳，以及文件里此刻的锚点。
   *
   * 只有产品 agent 的预览宿主有原型文件；项目级浏览器不参与。
   * 锚点是给「保号校验」用的基线 —— 轮结束时读文件对比，不依赖页面刷新。
   */
  async noteTurnStart(agentId: string): Promise<void> {
    const host = agentBrowserHost(agentId)
    const path = this.previewPath(host)
    await this.watch.begin(agentId, path)
    const record = this.annotationRecord(host)
    if (!path) {
      record.anchors = { before: null, missing: {}, file: null }
      return
    }
    // 换了文件就把「消失过的号」清掉 —— 那是上一个文件的事
    if (record.anchors.file !== path) {
      record.anchors = { before: null, missing: {}, file: path }
    }
    const anchors = await this.readFileAnchors(path)
    record.anchors.before = anchors ? toRecord(anchors) : null
  }

  /**
   * 一轮结束：动过原型文件就重新加载预览，并做一次保号校验。
   *
   * 没动过就什么都不做 —— 刷新会把用户正在看的滚动位置带走。
   * 重新加载之后 `did-finish-load` 会重建块登记、按块号恢复角标。
   */
  async noteTurnEnd(agentId: string): Promise<TurnEndResult> {
    const host = agentBrowserHost(agentId)
    const path = this.previewPath(host)
    const tab = this.pools.active(host)
    const changed = await this.watch.end(agentId, path)
    const record = this.annotationRecord(host)
    const before = record.anchors.before
    record.anchors.before = null
    if (!changed) return { file: record.file, breaks: [] }

    let breaks: AnchorBreak[] = []
    if (path && before && record.anchors.file === path) {
      const current = await this.readFileAnchors(path)
      if (current) {
        const checked = checkAnchors(before, record.anchors.missing, current)
        record.anchors.missing = checked.missing
        breaks = checked.breaks
      }
    }

    if (tab) {
      try {
        tab.view.webContents.reload()
      } catch {
        // 标签在轮结束的那一刻被关掉了 —— 没什么可刷的
      }
    }
    return { file: record.file, breaks }
  }

  /** 读原型文件里的锚点；读不到（文件不在、没权限）返回 null */
  private async readFileAnchors(path: string): Promise<FileAnchor[] | null> {
    try {
      return readAnchors(await readFile(path, 'utf8'))
    } catch {
      return null
    }
  }

  /** 当前预览标签对应的本地文件（绝对路径）；没有就是 null */
  private previewPath(host: BrowserHost): string | null {
    const tab = this.pools.active(host)
    if (!tab) return null
    return prototypePathOf(tab.view.webContents.getURL() || tab.url)
  }

  /** 注入标注脚本、恢复开关与角标、重建块登记 */
  private async installAnnotation(tab: Tab): Promise<void> {
    if (!isAgentBrowserHost(tab.host)) return
    try {
      await tab.view.webContents.executeJavaScript(ANNOTATION_SCRIPT)
    } catch {
      // 页面已经不在（后退 / 关闭），不值得报错
      return
    }
    const record = this.annotationRecord(tab.host)
    await this.runAnnotation(tab, `setMode(${record.enabled ? 'true' : 'false'})`)
    // scan 结束时会按最新登记推角标
    await this.scanAnnotation(tab.host, tab)
    this.emitAnnotation(tab.host)
  }

  /** 重建块登记：只读页面里的 `data-block`，不自己分配号 */
  private async scanAnnotation(host: BrowserHost, tab: Tab): Promise<void> {
    const record = this.annotationRecord(host)
    const raw = await tab.view.webContents
      .executeJavaScript(`window.__codeletAnnotation ? window.__codeletAnnotation.blocks() : []`)
      .catch(() => [])
    record.blocks = Array.isArray(raw)
      ? raw
          .map((item) => readPreviewBlock(item))
          .filter((item): item is PreviewBlock => item !== null)
      : []
    record.file = previewFileOf(tab.view.webContents.getURL() || tab.url, this.cwdForHost(host))
    /*
     * 登记重建之后立刻重推角标：临时号如果因为这个选择器拿到了锚点，
     * 页面上的 T1 要当场变成正式块号（输入框里的引用文字不动）。
     */
    await this.pushBadges(tab, record)
  }

  /**
   * 发送时按最新登记解析引用 —— 临时号转正了就换成正式块号。
   *
   * 渲染层在展开载荷之前调它；项目级宿主没有登记，原样返回。
   */
  resolveCitations(host: BrowserHost, citations: BlockCitation[]): BlockCitation[] {
    if (!isAgentBrowserHost(host)) return citations
    const record = this.annotationRecord(host)
    return citations.map((citation) => resolveCitation(citation, record.temps, record.blocks))
  }

  /** 页面点了一块：块信息以主进程的登记为准，页面报的只当回去的线索 */
  private readonly onPageMessage = (event: IpcMainEvent, message: unknown): void => {
    const found = this.pools
      .allTabs()
      .find(({ tab }) => tab.view.webContents.id === event.sender.id)
    if (!found) return
    const payload = message as { type?: unknown; block?: unknown }
    if (!payload) return
    const host = found.host
    if (!isAgentBrowserHost(host)) return
    // 页面里按了 Esc：退出标注模式（点击还给原型）
    if (payload.type === 'exit') {
      void this.setAnnotation(host, false)
      return
    }
    if (payload.type !== 'pick') return
    const reported = readBlockCandidate(payload.block)
    if (!reported) return
    const record = this.annotationRecord(host)
    // 没有锚点的块：主进程分配临时号（同一选择器复用，重复点不重号）
    if (reported.block === null) {
      const temp = assignTemp(record.temps, reported.selector)
      if (!record.temps.some((item) => item.selector === reported.selector)) {
        record.temps.push({ temp, selector: reported.selector, text: reported.text })
      }
      this.onAnnotation({
        host,
        state: this.annotationState(host),
        picked: { ...reported, temp, block: null, anchor: null }
      })
      return
    }
    const known = record.blocks.find(
      (block) =>
        (reported.block !== null && block.block === reported.block) ||
        (reported.temp !== null && block.temp === reported.temp)
    )
    this.onAnnotation({
      host,
      state: this.annotationState(host),
      picked: known ?? reported
    })
  }

  private emitAnnotation(host: BrowserHost): void {
    this.onAnnotation({ host, state: this.annotationState(host), picked: null })
  }

  state(host: BrowserHost): BrowserState {
    return {
      host,
      tabs: this.pools.list(host).map((tab) => this.publicTab(tab)),
      activeTabId: this.pools.activeTabId(host),
      agent: this.activity.get(host)?.value ?? null
    }
  }

  /**
   * 最近一次 agent 操作 —— 按宿主分开记。
   *
   * 分开是必须的：agent 动的是自己的预览，不该在项目浏览器的面板上
   * 显示「Agent 正在操作」，也不该把窄轨切过去。
   */
  private readonly activity = new Map<
    BrowserHost,
    { value: BrowserAgentActivity | null; timer: ReturnType<typeof setTimeout> | null }
  >()

  private noteAgent(host: BrowserHost, tool: string, label: string, ref?: string): void {
    const entry = this.activity.get(host) ?? { value: null, timer: null }
    entry.value = { tool, label, ...(ref ? { ref } : {}), at: Date.now() }
    // 过一会儿自己收起：agent 不再动作时，面板上不该一直挂着提示
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.value = null
      entry.timer = null
      this.emit(host)
    }, 6000)
    this.activity.set(host, entry)
    /*
     * 推一次 —— 渲染进程靠这个活动记录判断「agent 刚动过浏览器」，
     * 好把右侧面板切到浏览器视图（收着的话顺手展开）。
     * 不推的话，只读类工具（截图、读页面结构）就没有这条通知。
     */
    this.emit(host)
  }

  getState(host: BrowserHost): Promise<BrowserState> {
    return Promise.resolve(this.state(host))
  }

  async create(host: BrowserHost, url = 'about:blank'): Promise<BrowserState> {
    const tab = this.createTab(host)
    this.pools.add(host, tab)
    this.applyVisibility()
    await this.load(tab, url)
    this.emit(host)
    return this.state(host)
  }

  close(host: BrowserHost, tabId: string): Promise<BrowserState> {
    const removed = this.pools.remove(host, tabId)
    if (!removed) return Promise.resolve(this.state(host))
    this.detach(removed.tab)
    if (this.visibleHost === host) this.applyVisibility()
    this.emit(host)
    return Promise.resolve(this.state(host))
  }

  activate(host: BrowserHost, tabId: string): Promise<BrowserState> {
    if (this.pools.setActive(host, tabId)) {
      // 多标签时「上次预览」跟着用户最后切到的那一个走
      const tab = this.pools.find(host, tabId)
      if (tab) this.rememberPreview(tab)
      this.applyVisibility()
      this.emit(host)
    }
    return Promise.resolve(this.state(host))
  }

  /**
   * 产品 agent 的预览从记录里恢复。
   *
   * 只在宿主还没有标签时做，而且一次运行只尝试一次 —— 用户自己关掉了
   * 预览标签，切回来的时候不该又冒出来。
   * 没有记录、记录不是本地文件、或者文件已经不在，都什么都不做（渲染层走空态）。
   */
  async restorePreview(host: BrowserHost, url: string | null): Promise<void> {
    if (!isAgentBrowserHost(host)) return
    if (this.previewRestored.has(host)) return
    this.previewRestored.add(host)
    if (this.pools.list(host).length > 0) return
    const usable = restorablePreviewUrl(url)
    if (!usable) return
    await this.create(host, usable)
  }

  /**
   * 这一页是本地原型，就记成这个 agent 的「上次预览」。
   *
   * 只记 `file:`：http 预览下次启动多半没起，不该被恢复。
   * 同一个地址不重复写盘（重载、页内跳转都会走到这里）。
   */
  private rememberPreview(tab: Tab): void {
    if (!isAgentBrowserHost(tab.host)) return
    const agentId = agentIdOfHost(tab.host)
    if (!agentId) return
    const url = tab.view.webContents.getURL() || tab.url
    if (!url.startsWith('file:')) return
    this.onPreviewUrl(agentId, url)
  }

  async navigate(host: BrowserHost, tabId: string, input: string): Promise<BrowserState> {
    const tab = this.pools.find(host, tabId)
    if (!tab) return this.state(host)
    const normalized = normalizeBrowserUrl(input)
    if (normalized.error) {
      tab.error = normalized.error
      this.emit(host)
      return this.state(host)
    }
    tab.error = null
    if (normalized.url.startsWith('javascript:')) {
      try {
        await tab.view.webContents.executeJavaScript(normalized.url.slice('javascript:'.length))
      } catch (error) {
        tab.error = error instanceof Error ? error.message : String(error)
      }
      this.emit(host)
      return this.state(host)
    }
    await this.load(tab, normalized.url)
    return this.state(host)
  }

  back(host: BrowserHost, tabId: string): Promise<BrowserState> {
    const tab = this.pools.find(host, tabId)
    if (tab?.view.webContents.canGoBack()) tab.view.webContents.goBack()
    return Promise.resolve(this.state(host))
  }

  forward(host: BrowserHost, tabId: string): Promise<BrowserState> {
    const tab = this.pools.find(host, tabId)
    if (tab?.view.webContents.canGoForward()) tab.view.webContents.goForward()
    return Promise.resolve(this.state(host))
  }

  reload(host: BrowserHost, tabId: string): Promise<BrowserState> {
    const tab = this.pools.find(host, tabId)
    tab?.view.webContents.reload()
    return Promise.resolve(this.state(host))
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

  /**
   * 显示 / 隐藏某个宿主的浏览器。
   *
   * 同一时刻只有一个宿主的 WebContentsView 挂在窗口上 —— 区域 6 只有一个格子。
   * 传 `visible: true` 就把可见宿主切过去，原来那个自动隐藏。
   */
  setVisible(host: BrowserHost, visible: boolean): Promise<void> {
    if (visible) this.visibleHost = host
    else if (this.visibleHost === host) this.visibleHost = null
    this.applyVisibility()
    return Promise.resolve()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ipcMain.removeListener(BROWSER_ANNOTATION_CHANNEL, this.onPageMessage)
    this.annotations.clear()
    this.watch.clear()
    for (const { tab } of this.pools.allTabs()) this.detach(tab)
    this.pools.clear()
    this.visibleHost = null
    for (const entry of this.activity.values()) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.activity.clear()
  }

  /**
   * 给 agent 用的工具入口。
   *
   * **host 由调用方给死**（`agent:<id>`），这里不再从参数里猜 ——
   * agent 碰不到别的宿主的标签，这是 D57 的那条安全边界。
   */
  async tool(
    tool: string,
    args: Record<string, unknown> = {},
    host: BrowserHost = PROJECT_BROWSER
  ): Promise<unknown> {
    const requested = typeof args.tabId === 'string' ? args.tabId : ''
    const tab =
      this.pools.find(host, requested) ??
      this.pools.active(host) ??
      this.pools.list(host)[0] ??
      null
    const url = typeof args.url === 'string' ? args.url : ''

    if (tool === 'tabs') {
      this.noteAgent(host, 'browser_tabs', '查看标签列表')
      return this.state(host)
    }
    if (tool === 'open') {
      this.noteAgent(host, 'browser_open', `打开 ${url || '空白页'}`)
      return this.create(host, url || 'about:blank')
    }
    if (tool === 'blocks') {
      this.noteAgent(host, 'browser_blocks', '读取原型块清单')
      return this.blockList(host)
    }
    if (!tab) throw new Error('没有打开的浏览器标签')

    if (tool === 'activate') {
      return requested ? this.activate(host, requested) : this.state(host)
    }
    if (tool === 'close') return this.close(host, tab.id)
    if (tool === 'back') return this.back(host, tab.id)
    if (tool === 'forward') return this.forward(host, tab.id)
    if (tool === 'reload') return this.reload(host, tab.id)
    if (tool === 'navigate') {
      if (!url) throw new Error('navigate 需要 url')
      this.noteAgent(host, 'browser_navigate', `导航到 ${url}`)
      return this.navigate(host, tab.id, url)
    }
    if (tool === 'snapshot') {
      const offset = Number.isInteger(args.offset) ? Number(args.offset) : 0
      const limit = Number.isInteger(args.limit) ? Number(args.limit) : DEFAULT_PAGE_SIZE
      this.noteAgent(host, 'browser_snapshot', '读取页面结构')
      return this.snapshot(host, tab.id, Math.max(0, offset), Math.min(MAX_PAGE_SIZE, Math.max(1, limit)))
    }
    if (tool === 'click') {
      const ref = typeof args.ref === 'string' ? args.ref : ''
      if (!/^e\d+$/.test(ref)) throw new Error('click 需要快照里的元素 ref')
      const clicked = await tab.view.webContents.executeJavaScript(
        `(() => { const el = document.querySelector('[data-codelet-ref="${ref}"]'); if (!el) return false; el.click(); return true })()`
      )
      if (!clicked) throw new Error(`找不到元素 ${ref}`)
      const label = await this.describeElement(tab, ref)
      this.noteAgent(host, 'browser_click', `点击 ${label}`, ref)
      this.highlight(tab, ref)
      this.emit(host)
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
      this.noteAgent(host, 'browser_type', `在 ${label} 输入 ${text.length} 个字符`, ref)
      this.highlight(tab, ref)
      this.emit(host)
      return { typed: ref, label, url: tab.view.webContents.getURL() }
    }
    if (tool === 'screenshot') {
      this.noteAgent(host, 'browser_screenshot', '截取页面')
      return this.screenshot(host, tab.id)
    }
    if (tool === 'wait') {
      const selector = typeof args.selector === 'string' ? args.selector : ''
      const timeout = Math.min(
        WAIT_MAX_MS,
        Number.isInteger(args.timeoutMs) ? Math.max(0, Number(args.timeoutMs)) : 10_000
      )
      const result = await this.wait(tab, selector, timeout)
      this.noteAgent(host, 'browser_wait', selector ? `等待 ${selector}` : '等待页面稳定')
      this.emit(host)
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
  private async screenshot(host: BrowserHost, tabId: string): Promise<unknown> {
    const tab = this.pools.find(host, tabId)
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

  private async snapshot(host: BrowserHost, tabId: string, offset: number, limit: number): Promise<unknown> {
    const tab = this.pools.find(host, tabId)
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

  private createTab(host: BrowserHost): Tab {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        /*
         * 只做一件事：把页面里注入脚本 post 出来的标注消息转成 IPC。
         * 没有暴露任何能力给页面（不走 contextBridge）。
         */
        preload: join(currentDir, '../preload/browser.cjs')
      }
    })
    const tab: Tab = {
      id: `browser-${++this.seq}`,
      host,
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
        this.emit(tab.host)
      }
    })
    view.webContents.on('did-start-loading', () => {
      tab.loading = true
      tab.error = null
      // 新页面还没扫过：块登记先清掉，免得界面还指着上一页的号
      if (isAgentBrowserHost(tab.host)) {
        const record = this.annotationRecord(tab.host)
        record.blocks = []
        record.file = null
        this.emitAnnotation(tab.host)
      }
      this.emit(tab.host)
    })
    view.webContents.on('did-stop-loading', () => {
      tab.loading = false
      this.emit(tab.host)
    })
    view.webContents.on('did-navigate', (_event, target) => {
      tab.url = target
      tab.error = null
      this.rememberPreview(tab)
      this.emit(tab.host)
    })
    view.webContents.on('did-navigate-in-page', (_event, target) => {
      tab.url = target
      this.rememberPreview(tab)
      this.emit(tab.host)
    })
    view.webContents.on('did-finish-load', () => {
      // 注入标注脚本、恢复开关与角标、重建块登记（只对 agent 预览生效）
      void this.installAnnotation(tab)
    })
    view.webContents.on('page-title-updated', (_event, title) => {
      tab.title = title || '新标签'
      this.emit(tab.host)
    })
    view.webContents.on('did-fail-load', (_event, code, description, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      tab.loading = false
      tab.error = `${description}（${code}）`
      if (validatedURL) tab.url = validatedURL
      this.emit(tab.host)
    })
    view.webContents.on('render-process-gone', (_event, details) => {
      tab.loading = false
      tab.error = `页面进程退出：${details.reason}`
      this.emit(tab.host)
    })

    // 先挂上去、默认不可见 —— applyVisibility 决定谁可见
    this.win.contentView.addChildView(view)
    view.setVisible(false)
    view.setBounds(this.bounds)
    return tab
  }

  private async load(tab: Tab, input: string): Promise<void> {
    const normalized = normalizeBrowserUrl(input)
    if (normalized.error) {
      tab.error = normalized.error
      this.emit(tab.host)
      return
    }
    if (normalized.url === 'about:blank') {
      tab.url = 'about:blank'
      tab.title = '新标签'
      tab.error = null
      await tab.view.webContents.loadURL('about:blank')
      this.emit(tab.host)
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
      this.emit(tab.host)
    }
  }

  /** 把一条标签的 view 从窗口上摘掉并关闭它的 webContents */
  private detach(tab: Tab): void {
    try {
      this.win.contentView.removeChildView(tab.view)
    } catch {
      // 窗口已经进入销毁流程时 contentView 可能不可用
    }
    try {
      tab.view.webContents.close()
    } catch {
      // 关闭失败不能让应用退不出去
    }
  }

  private applyBounds(): void {
    for (const { tab } of this.pools.allTabs()) tab.view.setBounds(this.bounds)
  }

  /**
   * 决定哪个 view 挂在窗口上。
   *
   * 只有「可见宿主的活动标签」是可见的，其余全部隐藏 —— 区域 6 只有一个格子，
   * 两个宿主的页面不会同时显示。
   */
  private applyVisibility(): void {
    const visibleTab = this.visibleHost ? this.pools.active(this.visibleHost) : null
    for (const { tab } of this.pools.allTabs()) {
      tab.view.setBounds(this.bounds)
      tab.view.setVisible(tab === visibleTab)
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

  private emit(host: BrowserHost): void {
    this.onChange(host, this.state(host))
  }
}
