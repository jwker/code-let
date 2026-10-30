import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { basename, normalize } from 'node:path'
import type {
  ConversationInfo,
  HostSnapshot,
  ModelOption,
  SessionState,
  StreamItem,
  TabInfo
} from '@contract/index'
import { affectsConversationList, DebouncedRefresh } from './conversationRefresh'
import { pickDirectory } from './directoryPicker'
import { PiRuntime, type PiRuntimePort } from './pi/runtime'
import { ProjectStore } from './projects'
import { TabStore, type StoredTab } from './tabs'

/** 宿主这边记的一个标签 */
interface HostTab {
  /** 标签自己的 id —— 宿主发的，稳定的身份 */
  id: string
  /** 会话所在目录 */
  cwd: string
  /** 会话文件路径 */
  path: string | null
  /** 标签显示的标题 */
  title: string
  /** 创建失败时的原因 */
  error: string | null
}

/**
 * 宿主权威状态（PLAN.md D7）。
 *
 * 渲染进程只是它的投影：状态变化从这里推快照，不从渲染进程回写。
 */
/** 焦点刷新的最小间隔 —— 快速 alt-tab 别反复扫盘 */
const FOCUS_REFRESH_MIN_MS = 2000

export class HostState extends EventEmitter {
  readonly pi: PiRuntimePort
  /** 用户选的项目清单 —— 侧栏只列这些项目的会话 */
  private readonly projects: ProjectStore
  private readonly tabStore: TabStore
  private readonly pickDirectory: () => Promise<string | null>
  private tabs: HostTab[] = []
  private activeTabId: string | null = null
  private conversations: ConversationInfo[] = []
  private session: SessionState = {
    ready: false,
    cwd: null,
    sessionId: null,
    model: null,
    modelFallback: null,
    error: null
  }
  /** 去抖刷新：把一轮里的多次刷新合成一次 */
  private readonly conversationsRefresh: DebouncedRefresh
  /** 刷新的序号：只认最后一次发起的 */
  private refreshToken = 0
  /** 标签 id 的序号 —— 宿主自己发，与会话 id 解耦 */
  private tabSeq = 0
  /** init() 跑完了没 —— 没跑完之前不响应焦点刷新（init 自己会读一次） */
  private initialized = false
  /** 上次「焦点刷新」的时刻，用来限流 */
  private lastFocusRefresh = 0

  /** 运行时、标签存储、目录选择器都能塞进来 —— 真跑要模型，测不动 */
  constructor(options?: {
    pi?: PiRuntimePort
    tabStore?: TabStore
    projects?: ProjectStore
    pickDirectory?: () => Promise<string | null>
  }) {
    super()
    this.pi = options?.pi ?? new PiRuntime()
    this.projects = options?.projects ?? new ProjectStore()
    this.tabStore = options?.tabStore ?? new TabStore()
    this.pickDirectory = options?.pickDirectory ?? pickDirectory
    this.conversationsRefresh = new DebouncedRefresh(() => this.refreshConversations())
  }

  // ---------------------------------------------------------------------
  // 快照
  // ---------------------------------------------------------------------

  snapshot(): HostSnapshot {
    return {
      tabs: this.tabs.map((tab) => this.tabInfo(tab)),
      activeTabId: this.activeTabId,
      projects: this.projects.list(),
      conversations: this.conversations,
      session: this.session
    }
  }

  private tabInfo(tab: HostTab): TabInfo {
    const state = this.pi.tabState(tab.id)
    return {
      id: tab.id,
      sessionId: state.sessionId,
      path: tab.path,
      cwd: tab.cwd,
      title: tab.title,
      projectName: basename(tab.cwd) || tab.cwd,
      streaming: state.streaming,
      ready: state.ready,
      // 项目从清单里移走了 —— 标签还能用，但它不再「在清单里」
      removed: !this.projects.has(tab.cwd),
      model: state.model,
      modelFallback: state.modelFallback,
      error: tab.error
    }
  }

  private push(): void {
    this.emit('snapshot', this.snapshot())
  }

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------

  async init(): Promise<void> {
    // 会话流事件：转发给渲染进程（带 tabId）
    this.pi.onEvent((event) => {
      this.emit('session-event', event)
      // 模型被换了（比如扩展调的 setModel）—— 快照跟着变
      if (event.type === 'model_select') {
        this.readSession()
        this.push()
      }
      // 会话文件变了，对话列表要跟着变
      if (affectsConversationList(event)) {
        this.conversationsRefresh.schedule()
      }
    })

    // 先把会话列表读出来 —— 首次启动没有标签时，要靠它找「接着上次那个会话跑」
    await this.refreshConversations()
    // 恢复上次的标签（PLAN.md D4 修订）：标签栏立刻能显示，
    // runtime 等用户点它的时候再建（懒加载）。
    const restored = await this.restoreTabs()
    if (!restored) await this.openFallbackTab()
    // 启动时已经读过一次了 —— 别让紧接着的那次 focus 再扫一遍
    this.initialized = true
    this.lastFocusRefresh = Date.now()
  }

  /**
   * 首次启动（没有存过标签）时的退路：接着最近的那个会话跑。
   *
   * 一个会话都没有的话，就在当前目录下开一个新会话。
   */
  private async openFallbackTab(): Promise<void> {
    const projects = this.projects.list()
    // 一个项目都没选 —— 不开标签，侧栏显示空态，等用户「打开项目」
    if (projects.length === 0) return
    const latest = this.conversations[0]
    if (latest) {
      await this.openTab({ cwd: latest.cwd, path: latest.path, title: latest.title })
      return
    }
    await this.openTab({ cwd: projects[0].path })
  }

  /**
   * 恢复上次的标签。
   *
   * **会话文件没了的标签直接丢掉** —— 内容就在会话文件里，文件没了内容也没了。
   * **项目目录被删的**标签留着但标为出错 —— 它还能被看到、能被关掉。
   */
  private async restoreTabs(): Promise<boolean> {
    for (const stored of this.tabStore.list()) {
      /*
       * 会话文件还在 → 打开它，内容都在。
       * 文件不在 → 在同一个目录里当**新会话**开，标签留着。
       *
       * 为什么不是「丢掉这个标签」：Pi 创建会话时就把路径算出来了，
       * 但文件要等第一条用户消息才建 —— 所以「有路径、没文件」的标签
       * 绝大多数是**从没说过话的空标签**，它们本来就没有内容可丢。
       * 把「开着的标签」当工作区的一部分保住，比因为没内容就扔掉更合理。
       */
      const hasFile = Boolean(stored.path && existsSync(stored.path))
      try {
        await this.pi.openTab(stored.id, {
          cwd: stored.cwd,
          path: hasFile ? (stored.path ?? undefined) : undefined,
          lazy: true
        })
        this.tabs.push({
          id: stored.id,
          cwd: stored.cwd,
          // 重开的是新会话，路径要换成它的（此刻文件还没建，先记着）
          path: hasFile ? stored.path : null,
          title: stored.title,
          error: null
        })
      } catch (error) {
        // 目录被删之类 —— 标签留着，但标出来
        this.tabs.push({
          id: stored.id,
          cwd: stored.cwd,
          path: stored.path,
          title: stored.title,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    if (this.tabs.length === 0) return false
    // 恢复出来的第一个标签成为活动标签
    this.activeTabId = this.tabs[0].id
    await this.pi.activateTab(this.tabs[0].id)
    this.readSession()
    this.persistTabs()
    this.push()
    return true
  }

  // ---------------------------------------------------------------------
  // 标签
  // ---------------------------------------------------------------------

  private nextTabId(): string {
    this.tabSeq += 1
    return `tab-${Date.now().toString(36)}-${this.tabSeq}`
  }

  /**
   * 开一个新标签：给会话路径就打开已有会话，不给就在这个目录里新建。
   */
  private async openTab(options: { cwd: string; path?: string; title?: string }): Promise<string> {
    const id = this.nextTabId()
    await this.pi.openTab(id, { cwd: options.cwd, path: options.path })
    const title = options.title ?? (options.path ? '对话' : '新对话')
    // 会话文件路径必须记下来 —— 重启时按它找回会话。
    // 新建的会话在 Pi 里立刻就有路径了（只是文件还没建），所以这里读得到。
    const path = options.path ?? this.pi.tabState(id).sessionFile
    this.tabs.push({ id, cwd: options.cwd, path, title, error: null })
    this.activeTabId = id
    this.persistTabs()
    this.readSession()
    this.push()
    return id
  }

  /** 打开项目（系统目录选择器）→ 加进项目清单 → 在那儿开一个新标签 */
  async openProject(): Promise<string | null> {
    const picked = await this.pickDirectory()
    if (!picked) return null
    const dir = normalize(picked)
    await this.addProject(dir)
    await this.openTab({ cwd: dir })
    return dir
  }

  /**
   * 把一个项目加进清单，并重读它的会话。
   *
   * **必须重读** —— 会话清单只列清单里的项目，而清单是刚变的。
   * 不重读的话，新加的项目在侧栏里就是个空组，
   * 之前跟它聊过的会话要等到下一次事件触发刷新才出现。
   */
  async addProject(path: string): Promise<void> {
    this.projects.add(path)
    await this.refreshConversations()
    this.push()
  }

  /**
   * 从清单里移除一个项目。
   *
   * **Pi 存的对话一个字都不动** —— 只是这个目录不再出现在 Codelet 的清单里，
   * 侧栏不列它了。已经打开的标签留着照常用，只是标记成「已移除」。
   */
  async removeProject(path: string): Promise<void> {
    this.projects.remove(path)
    await this.refreshConversations()
    this.push()
  }

  /** 打开一个已有会话 → 开成新标签 */
  async openConversation(path: string, cwd: string): Promise<void> {
    const conversation = this.conversations.find((c) => c.path === path)
    await this.openTab({ cwd, path, title: conversation?.title })
  }

  /** 在某个目录里新建会话 → 开成新标签 */
  async newConversation(cwd: string): Promise<void> {
    await this.openTab({ cwd })
  }

  /** 切到某个标签 */
  async activateTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error(`标签不存在：${tabId}`)
    this.activeTabId = tabId
    // runtime 还没建就建（懒加载）
    await this.pi.activateTab(tabId)
    // 懒加载的标签这时候才真的有会话 —— 把它的文件路径补上，
    // 不然下次重启它又变回「没路径的空标签」。
    if (!tab.path) {
      const path = this.pi.tabState(tabId).sessionFile
      if (path) {
        tab.path = path
        this.persistTabs()
      }
    }
    this.readSession()
    this.push()
  }

  /** 关掉某个标签 */
  async closeTab(tabId: string): Promise<void> {
    const index = this.tabs.findIndex((t) => t.id === tabId)
    if (index < 0) return
    await this.pi.closeTab(tabId)
    this.tabs.splice(index, 1)
    // 关掉的正好是活动标签 —— 活动标签落到相邻的一个
    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)]
      this.activeTabId = next ? next.id : null
      if (next) await this.pi.activateTab(next.id)
    }
    this.persistTabs()
    this.readSession()
    this.push()
  }

  /** 把当前的标签列表落盘（顺序即标签栏的顺序） */
  private persistTabs(): void {
    const stored: StoredTab[] = this.tabs.map((tab) => ({
      id: tab.id,
      cwd: tab.cwd,
      path: tab.path,
      title: tab.title
    }))
    this.tabStore.saveTabs(stored)
  }

  // ---------------------------------------------------------------------
  // 对话列表（全部项目）
  // ---------------------------------------------------------------------

  /**
   * 重读对话列表（磁盘上的会话文件是权威）。
   *
   * 现在列的是**全部项目**的会话（`SessionManager.listAll()`）。
   * 它要读并解析每一个 jsonl —— 实测 38 个会话 212ms，随会话数线性增长。
   * 所以用 `onProgress` 分段出结果：先给一部分，别让侧栏干等。
   */
  async refreshConversations(): Promise<void> {
    const token = ++this.refreshToken
    try {
      // 只读用户选中的那几个项目的目录 —— 不是 Pi 聊过的所有项目
      const cwds = this.projects.list().map((project) => project.path)
      const list = await PiRuntime.listConversations(cwds)
      if (token !== this.refreshToken) return
      this.conversations = list
      // 会话标题变了（第一条用户消息落盘后，标题从「新对话」变成消息内容）——
      // 标签上的标题要跟着变，不然标签一直写着「新对话」
      let titleChanged = false
      for (const tab of this.tabs) {
        if (!tab.path) continue
        const conversation = list.find((c) => c.path === tab.path)
        if (conversation && conversation.title !== tab.title) {
          tab.title = conversation.title
          titleChanged = true
        }
      }
      // 标题变了要落盘 —— 不然重启后标签还写着「新对话」
      if (titleChanged) this.persistTabs()
    } catch {
      if (token !== this.refreshToken) return
      this.conversations = []
    }
    this.push()
  }

  /**
   * 窗口重新获得焦点时重读会话列表。
   *
   * **为什么需要这个**：列表刷新本来是事件驱动的，但那只覆盖「Codelet 自己的 runtime」。
   * 用户在裸 pi 的 TUI 里说话时，那是另一个进程 —— 我们收不到任何事件，
   * 列表就一直不动，只有重启（`init()` 里无条件重读）才更新。
   *
   * 触发点选「窗口获得焦点」，因为那正是用户期望看到最新状态的时刻。
   *
   * 限流：快速 alt-tab 会反复触发，而每次都要读并解析那几个项目的 jsonl
   * （实测 38 个会话 212ms）。所以两次之间至少隔 FOCUS_REFRESH_MIN_MS。
   */
  async refreshOnFocus(): Promise<void> {
    if (!this.initialized) return
    const now = Date.now()
    if (now - this.lastFocusRefresh < FOCUS_REFRESH_MIN_MS) return
    this.lastFocusRefresh = now
    await this.refreshConversations()
  }

  /**
   * 把运行时里的会话状态抄进快照。
   *
   * 模型是跟着会话走的，漏抄就会出现「切了标签，状态栏还显示上一个标签的模型」。
   */
  private readSession(): void {
    const tabId = this.activeTabId
    if (!tabId) {
      this.session = {
        ready: false,
        cwd: null,
        sessionId: null,
        model: null,
        modelFallback: null,
        error: null
      }
      return
    }
    const tab = this.tabs.find((t) => t.id === tabId)
    const state = this.pi.tabState(tabId)
    this.session = {
      ready: state.ready,
      cwd: tab?.cwd ?? null,
      sessionId: state.sessionId,
      model: state.model,
      modelFallback: state.modelFallback,
      error: tab?.error ?? null
    }
  }

  // ---------------------------------------------------------------------
  // 会话
  // ---------------------------------------------------------------------

  /** 某个标签已经说过的话（R1 R5） */
  readEntries(tabId: string): StreamItem[] {
    return this.pi.readEntries(tabId)
  }

  /** 已配置凭据的模型清单（选择器用） */
  listModels(tabId: string): Promise<ModelOption[]> {
    return this.pi.listModels(tabId)
  }

  /** 切某个标签的模型 */
  async selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void> {
    await this.pi.selectModel(tabId, provider, id, persist)
    this.readSession()
    this.push()
  }

  /** 往某个标签发一条用户消息 */
  async prompt(tabId: string, text: string): Promise<void> {
    await this.pi.prompt(tabId, text)
  }

  async dispose(): Promise<void> {
    this.conversationsRefresh.dispose()
    await this.pi.stop()
  }
}
