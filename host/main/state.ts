import { EventEmitter } from 'node:events'
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
import { PiRuntime, TabSessionMissingError, type PiRuntimePort } from './pi/runtime'
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
export class HostState extends EventEmitter {
  readonly pi: PiRuntimePort
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

  /** 运行时、标签存储、目录选择器都能塞进来 —— 真跑要模型，测不动 */
  constructor(options?: {
    pi?: PiRuntimePort
    tabStore?: TabStore
    pickDirectory?: () => Promise<string | null>
  }) {
    super()
    this.pi = options?.pi ?? new PiRuntime()
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
  }

  /**
   * 首次启动（没有存过标签）时的退路：接着最近的那个会话跑。
   *
   * 一个会话都没有的话，就在当前目录下开一个新会话。
   */
  private async openFallbackTab(): Promise<void> {
    const latest = this.conversations[0]
    if (latest) {
      await this.openTab({ cwd: latest.cwd, path: latest.path, title: latest.title })
      return
    }
    await this.openTab({ cwd: process.cwd() })
  }

  /**
   * 恢复上次的标签。
   *
   * **会话文件没了的标签直接丢掉** —— 内容就在会话文件里，文件没了内容也没了。
   * **项目目录被删的**标签留着但标为出错 —— 它还能被看到、能被关掉。
   */
  private async restoreTabs(): Promise<boolean> {
    for (const stored of this.tabStore.list()) {
      try {
        await this.pi.openTab(stored.id, { cwd: stored.cwd, path: stored.path ?? undefined, lazy: true })
        this.tabs.push({ id: stored.id, cwd: stored.cwd, path: stored.path, title: stored.title, error: null })
      } catch (error) {
        if (error instanceof TabSessionMissingError) continue
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
    this.tabs.push({ id, cwd: options.cwd, path: options.path ?? null, title, error: null })
    this.activeTabId = id
    this.persistTabs()
    this.readSession()
    this.push()
    return id
  }

  /** 打开项目（系统目录选择器）→ 在那儿开一个新标签 */
  async openProject(): Promise<string | null> {
    const picked = await this.pickDirectory()
    if (!picked) return null
    const dir = normalize(picked)
    await this.openTab({ cwd: dir })
    return dir
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
      const list = await PiRuntime.listConversations((partial) => {
        // 分段出结果：listAll 要读并解析每一个 jsonl，先给一部分，别让侧栏干等。
        //
        // **只加不删** —— 拿部分结果替换整个列表，侧栏会先塌下去再涨回来，
        // 看着就是闪一下（实测：58 条塌成 4 条再回到 61 条）。
        if (token !== this.refreshToken) return
        this.conversations = mergeConversations(this.conversations, partial)
        this.push()
      })
      if (token !== this.refreshToken) return
      this.conversations = list
    } catch {
      if (token !== this.refreshToken) return
      this.conversations = []
    }
    this.push()
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

/**
 * 把分段读出来的结果并进现有列表。
 *
 * **只加不删** —— 列表已有的会话保留，缺的是补上，标题/时间变了的用新的。
 * 顺序按修改时间倒序（新的在前），跟完整列表一致。
 */
function mergeConversations(existing: ConversationInfo[], incoming: ConversationInfo[]): ConversationInfo[] {
  const byPath = new Map(existing.map((conversation) => [conversation.path, conversation]))
  for (const conversation of incoming) byPath.set(conversation.path, conversation)
  return [...byPath.values()].sort((a, b) => b.modified.localeCompare(a.modified))
}
