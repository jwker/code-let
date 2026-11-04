import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { basename, normalize, relative } from 'node:path'
import type {
  CommandArgumentOption,
  CommandOption,
  ContextDiffSession,
  ContextDiffView,
  ContextSnapshotRef,
  ConversationInfo,
  DeleteConversationsResult,
  ExtensionErrorInfo,
  FileContent,
  FileEntry,
  FileSearchResult,
  FileTab,
  HostSnapshot,
  ModelOption,
  PickAttachmentsResult,
  SessionState,
  ThinkingLevel,
  StreamItem,
  TabInfo,
  TemporaryChatState
} from '@contract/index'
import { ATTACHMENT_LIMITS } from '@contract/index'
import {
  externalAttachmentName,
  inspectExternalFile,
  prepareAttachments,
  type ExternalAttachment
} from './attachments'
import { ContextDiffStore, type RawContextSnapshot } from './contextDiff'
import { affectsConversationList, DebouncedRefresh } from './conversationRefresh'
import { pickDirectory } from './directoryPicker'
import { pickFiles } from './filePicker'
import { shell } from 'electron'
import { listDirectory, readFileContent, resolveInsideCwd, searchFiles as searchProjectFiles } from './files'
import { PiRuntime, type PiRuntimePort } from './pi/runtime'
import { ProjectStore } from './projects'
import { moveSessionFilesToTrash } from './sessionFiles'
import { TabStore, type StoredFile, type StoredTab } from './tabs'

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
  /**
   * 这个标签「已经看到」的会话文件修改时间（ms）。
   *
   * 比它新 = 文件在别处被改过。**我们自己写文件之后要把它推上去** ——
   * 不然自己发一条消息就会把自己标成「有外部更新」。
   */
  seenMtime: number
  /** 文件在别处被改过，内容流落后了 */
  stale: boolean
}

/**
 * 宿主权威状态（PLAN.md D7）。
 *
 * 渲染进程只是它的投影：状态变化从这里推快照，不从渲染进程回写。
 */
/** 文件的修改时间（ms）；文件不在就是 0 */
function mtimeOf(path: string | null): number {
  if (!path) return 0
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 窗口离开多久之后，回来才值得重读会话列表。
 *
 * 判据用「离开时长」而不是「上次刷新过了多久」：
 * 点了下别的窗口又点回来（离开 1 秒）根本不需要重读 ——
 * 那段时间应用自己会收到事件。而真的在终端里聊了五分钟再切回来，才需要重扫磁盘。
 */
const MIN_AWAY_MS = 3000

export class HostState extends EventEmitter {
  readonly pi: PiRuntimePort
  /** 用户选的项目清单 —— 侧栏只列这些项目的会话 */
  private readonly projects: ProjectStore
  private readonly tabStore: TabStore
  private readonly pickDirectory: () => Promise<string | null>
  private readonly pickFiles: () => Promise<string[] | null>
  private tabs: HostTab[] = []
  private activeTabId: string | null = null
  private conversations: ConversationInfo[] = []
  /** 扩展加载 / 执行错误 —— 最多留 20 条，界面顶部提示 */
  private extensionErrors: ExtensionErrorInfo[] = []
  /** 正在进行的 `@` 文件搜索 —— requestId -> controller */
  private fileSearches = new Map<string, AbortController>()
  /** 系统选择器上传的附件 —— id -> 批准的绝对路径 */
  private uploads = new Map<string, ExternalAttachment>()
  private uploadSeq = 0
  /** 当前临时对话；null = 没有或已彻底关闭 */
  private temporaryChat: TemporaryChatState | null = null
  private temporarySeq = 0
  /** 请求级上下文 diff 的索引和内容缓存 */
  private readonly contextDiff: ContextDiffStore
  /** 活动标签的默认上下文对比 */
  private contextDiffView: ContextDiffView | null = null
  private session: SessionState = {
    ready: false,
    cwd: null,
    sessionId: null,
    model: null,
    thinkingLevel: null,
    modelFallback: null,
    error: null
  }
  /**
   * 打开的文件（PLAN.md D22）—— **全局的、跨项目的**，跟会话标签是两套东西。
   *
   * 切片 1 先不落盘；持久化在切片 2。
   */
  private files: FileTab[] = []
  /** 当前活动的文件 */
  private activeFileId: string | null = null
  /** 文件标签 id 的序号 */
  private fileSeq = 0
  /** 每个文件标签「已经看到」的 mtime */
  private fileMtime = new Map<string, number>()
  /** 被外部改过的文件标签 */
  private fileStale = new Set<string>()
  /** 去抖刷新：把一轮里的多次刷新合成一次 */
  private readonly conversationsRefresh: DebouncedRefresh
  /** 刷新的序号：只认最后一次发起的 */
  private refreshToken = 0
  /** 标签 id 的序号 —— 宿主自己发，与会话 id 解耦 */
  private tabSeq = 0
  /**
   * 正在进行的重读操作数。
   *
   * 用计数不用布尔：会话列表刷新和标签重载可能同时发生，
   * 布尔会在第一个结束时就把「刷新中」关掉。
   */
  private pendingRefreshes = 0
  /**
   * 正在中止的标签。
   *
   * 用集合不用单值：多标签可以同时在跑、同时被停。
   */
  private aborting = new Set<string>()
  /** 同一时间只允许一个删除请求 —— 连点、单条与批量并发都靠它挡住 */
  private deleting = false
  /** 会话文件移入废纸篓的方式 —— 注入是为了测试不启动 Electron */
  private readonly trashFile: (path: string) => Promise<void>
  /** init() 跑完了没 —— 没跑完之前不响应焦点刷新（init 自己会读一次） */
  private initialized = false
  /** 窗口上次失去焦点的时刻 —— 回来时用「离开多久」决定要不要重读 */
  private blurredAt = 0

  /** 运行时、标签存储、目录选择器都能塞进来 —— 真跑要模型，测不动 */
  constructor(options?: {
    pi?: PiRuntimePort
    tabStore?: TabStore
    projects?: ProjectStore
    pickDirectory?: () => Promise<string | null>
    pickFiles?: () => Promise<string[] | null>
    contextDiffDir?: string
    trashFile?: (path: string) => Promise<void>
  }) {
    super()
    this.pi = options?.pi ?? new PiRuntime()
    this.projects = options?.projects ?? new ProjectStore()
    this.tabStore = options?.tabStore ?? new TabStore()
    this.pickDirectory = options?.pickDirectory ?? pickDirectory
    this.pickFiles = options?.pickFiles ?? pickFiles
    this.contextDiff = new ContextDiffStore(options?.contextDiffDir ?? null)
    this.trashFile = options?.trashFile ?? ((path) => shell.trashItem(path))
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
      refreshing: this.pendingRefreshes > 0,
      aborting: [...this.aborting],
      // stale 是派生状态，不存在 FileTab 里，推快照时合进去
      files: this.files.map((f) => (this.fileStale.has(f.id) ? { ...f, stale: true } : f)),
      activeFileId: this.activeFileId,
      extensionErrors: this.extensionErrors,
      temporaryChat: this.temporaryChat ? { ...this.temporaryChat } : null,
      contextDiff: this.contextDiffView,
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
      stale: tab.stale,
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
      // 请求级上下文快照：进 context diff，不进会话事件流
      if (event.type === 'context_diff_snapshot') {
        if (this.temporaryChat?.id !== event.tabId) {
          this.contextDiff.capture(event.tabId, event.data as RawContextSnapshot)
          if (this.activeTabId === event.tabId) {
            this.contextDiffView = this.contextDiff.getView(event.tabId)
            this.push()
          }
        }
        return
      }
      // 扩展错误走快照，不混进会话事件流
      if (event.type === 'extension_error') {
        this.recordExtensionError(event.tabId, event.data as Omit<ExtensionErrorInfo, 'tabId'>)
        return
      }
      this.emit('session-event', event)
      // 模型被换了（比如扩展调的 setModel）—— 快照跟着变
      if (event.type === 'model_select') {
        this.readSession()
        this.refreshTemporary()
        this.push()
      }
      // 会话文件变了，对话列表要跟着变
      if (affectsConversationList(event)) {
        this.conversationsRefresh.schedule()
      }
      // 一轮结束 —— 这一轮我们自己写了不少东西，把「已看到」的时间推上去，
      // 免得紧接着的检查把自己标成「有外部更新」
      if (event.type === 'agent_settled') this.markWritten(event.tabId)
    })

    // 先把会话列表读出来 —— 首次启动没有标签时，要靠它找「接着上次那个会话跑」
    await this.refreshConversations()
    // 恢复上次的标签（PLAN.md D4 修订）：标签栏立刻能显示，
    // runtime 等用户点它的时候再建（懒加载）。
    const restored = await this.restoreTabs()
    if (!restored) await this.openFallbackTab()
    // 文件标签跟会话标签各自恢复（D21）—— 两者互相独立
    this.restoreFiles()
    // 启动时已经读过一次了 —— 别让紧接着的那次 focus 再扫一遍
    this.initialized = true
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
          error: null,
          seenMtime: hasFile ? mtimeOf(stored.path) : 0,
          stale: false
        })
      } catch (error) {
        // 目录被删之类 —— 标签留着，但标出来
        this.tabs.push({
          id: stored.id,
          cwd: stored.cwd,
          path: stored.path,
          title: stored.title,
          error: error instanceof Error ? error.message : String(error),
          seenMtime: 0,
          stale: false
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
    this.tabs.push({ id, cwd: options.cwd, path, title, error: null, seenMtime: mtimeOf(path), stale: false })
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

  /**
   * 从宿主的标签列表里摘掉一批标签（同步，不碰 runtime、不推快照）。
   *
   * 关单个标签和批量删会话共用这段：都先把「哪些标签还在」定下来，再动 runtime。
   * 返回活动标签有没有变、新的活动标签是谁 —— 变了的话调用方要把新的 runtime
   * 建起来（懒加载的标签点开才建）。
   */
  private detachTabs(tabIds: string[]): { activeChanged: boolean; nextActiveId: string | null } {
    const ids = new Set(tabIds)
    if (ids.size === 0) return { activeChanged: false, nextActiveId: this.activeTabId }
    let activeChanged = false
    for (const id of ids) {
      const index = this.tabs.findIndex((t) => t.id === id)
      if (index < 0) continue
      const wasActive = this.activeTabId === id
      this.tabs.splice(index, 1)
      // 关掉的正好是活动标签 —— 活动标签落到相邻的一个
      if (wasActive) {
        activeChanged = true
        const next = this.tabs[Math.min(index, this.tabs.length - 1)]
        this.activeTabId = next ? next.id : null
      }
    }
    this.persistTabs()
    return { activeChanged, nextActiveId: this.activeTabId }
  }

  /** 关掉某个标签 */
  async closeTab(tabId: string): Promise<void> {
    if (!this.tabs.some((t) => t.id === tabId)) return
    const { activeChanged, nextActiveId } = this.detachTabs([tabId])
    await this.pi.closeTab(tabId)
    // 新的活动标签如果是懒加载的，把它建起来
    if (activeChanged && nextActiveId) await this.pi.activateTab(nextActiveId)
    this.readSession()
    this.push()
  }

  /**
   * 删除一批会话（PLAN.md D23）。
   *
   * 顺序是硬约束：
   * 1. 先确认路径都在当前会话列表里 —— 会话文件在 `~/.pi/agent/sessions/` 下，
   *    不在项目目录里，`resolveInsideCwd()` 那套校验用不上，白名单是唯一可靠的校验。
   * 2. 摘掉引用它们的标签与文件标签。
   * 3. 关掉标签的 runtime（`closeTab` 内部先 abort 等结算，再 dispose）。
   *    文件删了而 runtime 还活着的话，下一条消息会用 `appendFileSync`
   *    重建一个没有头部的会话文件。
   * 4. 最后才把文件移入废纸篓。
   */
  async deleteConversations(paths: string[]): Promise<DeleteConversationsResult> {
    if (this.deleting) throw new Error('上一次删除还没结束')
    this.deleting = true
    try {
      const targets = [...new Set(paths.map((path) => normalize(path)))]
      const known = new Set(this.conversations.map((conversation) => normalize(conversation.path)))
      const unknown = targets.filter((path) => !known.has(path))
      if (unknown.length > 0) throw new Error(`不在当前对话列表里：${unknown.join('、')}`)
      const targetSet = new Set(targets)

      // 会话文件没了，预览它的文件标签也一起关掉
      const fileIds = this.files
        .filter((file) => targetSet.has(normalize(file.path)))
        .map((file) => file.id)
      for (const fileId of fileIds) this.removeFileTab(fileId)
      if (fileIds.length > 0) this.persistFiles()

      const tabIds = this.tabs
        .filter((tab) => tab.path && targetSet.has(normalize(tab.path)))
        .map((tab) => tab.id)
      const previousActiveTabId = this.activeTabId
      const { nextActiveId } = this.detachTabs(tabIds)

      // 先关 runtime 再动文件 —— runtime 里还拿着这个会话文件路径。
      // 用 allSettled 等所有标签都停稳：一条失败也要等其他的关完，
      // 否则 deleting 已经放开了、别的 runtime 还在写。
      const closeResults = await Promise.allSettled(tabIds.map((tabId) => this.pi.closeTab(tabId)))
      const closeFailure = closeResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (closeFailure) {
        throw closeFailure.reason instanceof Error ? closeFailure.reason : new Error(String(closeFailure.reason))
      }

      // 活动标签被删了的话，把新的活动标签建起来（懒加载的这时才建）
      if (this.activeTabId !== previousActiveTabId && nextActiveId) {
        await this.pi.activateTab(nextActiveId)
      }

      const outcome = await moveSessionFilesToTrash(targets, this.trashFile)
      for (const path of outcome.deleted) this.contextDiff.deleteBySessionPath(path)
      await this.refreshConversations()
      this.readSession()
      this.push()
      return outcome
    } finally {
      this.deleting = false
    }
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
  /**
   * 包一层：进出都改一次计数并推快照 —— 渲染进程靠它显示「刷新中」。
   *
   * 只包真正读盘的操作（重读会话列表、重建 runtime）。
   * `readSession()` 那种读内存的微秒级操作不包，显示出来只会闪。
   */
  private async trackRefresh<T>(run: () => Promise<T>): Promise<T> {
    this.pendingRefreshes += 1
    this.push()
    try {
      return await run()
    } finally {
      this.pendingRefreshes -= 1
      this.push()
    }
  }

  async refreshConversations(): Promise<void> {
    await this.trackRefresh(() => this.readConversations())
  }

  private async readConversations(): Promise<void> {
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
      // 顺便看看有没有标签的会话文件在别处被改过
      this.checkStale()
    } catch {
      if (token !== this.refreshToken) return
      this.conversations = []
    }
    this.push()
  }

  /**
   * 检查每个标签的会话文件有没有在**别处**被改过。
   *
   * 判据：文件 mtime 比这个标签「已经看到」的时间新。
   * 我们自己写文件之后会把 seenMtime 推上去（见 markWritten），
   * 所以自己发消息不会把自己标成「有外部更新」。
   *
   * 只标记、不自动重读 —— 重建 runtime 会丢掉当前状态，
   * 而且如果别处还在写，重建完很快又会落后。让用户自己决定。
   */
  private checkStale(): void {
    let changed = false
    for (const tab of this.tabs) {
      if (!tab.path) continue
      /*
       * 这个标签的 agent 正在跑 —— 文件是我们自己在写，不算「别处改过」。
       *
       * 不跳过会误报：用户消息落盘之后 mtime 就变了，而 `markWritten` 要等
       * `agent_settled` 才更新 seenMtime。这一整轮里标签都会被标成 stale，
       * 输入框跟着被禁用 —— AI 回复期间用户就打不了字了。
       */
      if (this.pi.tabState(tab.id).streaming) continue
      const stale = mtimeOf(tab.path) > tab.seenMtime
      if (stale !== tab.stale) {
        tab.stale = stale
        changed = true
      }
    }
    if (changed) this.push()
  }

  /**
   * 我们自己往这个标签的会话里写过东西 —— 把「已经看到」的时间推到当下。
   *
   * 不推的话，自己发一条消息就会把自己标成「有外部更新」。
   */
  private markWritten(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab?.path) return
    tab.seenMtime = mtimeOf(tab.path)
    tab.stale = false
  }

  /**
   * 重新加载某个标签：重建 runtime，从磁盘重新读会话。
   *
   * 用于「这个会话在别处被改过」（stale）之后。
   */
  async reloadTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId)
    if (!tab) return
    await this.trackRefresh(() => this.pi.reloadTab(tabId))
    // 重建后路径可能变了（原来是「没说过话的空标签」的话）
    const state = this.pi.tabState(tabId)
    if (state.sessionFile) tab.path = state.sessionFile
    tab.seenMtime = mtimeOf(tab.path)
    tab.stale = false
    this.readSession()
    this.push()
  }

  // ---------------------------------------------------------------------
  // 文件（PLAN.md D20 / D22）
  // ---------------------------------------------------------------------

  /** 列一个目录下的条目 */
  listFiles(cwd: string, dir: string): Promise<FileEntry[]> {
    return listDirectory(cwd, dir)
  }

  /** 读一个文件 */
  readFile(cwd: string, path: string): Promise<FileContent> {
    return readFileContent(cwd, path)
  }

  /**
   * 打开一个文件（进文件标签栏）。
   *
   * 同一个文件重复打开 → 切过去，不新建标签。
   * `cwd` 是**打开那一刻的快照** —— 之后会话关了、cwd 变了，这个文件的 cwd 不变。
   */
  async openFile(cwd: string, path: string): Promise<void> {
    const root = normalize(cwd)
    const full = normalize(path)
    const existing = this.files.find((f) => f.path === full)
    if (existing) {
      this.activeFileId = existing.id
      // 重新打开视为「看过了」—— 把已看到的时间推上去，清掉 stale
      this.fileMtime.set(existing.id, mtimeOf(full))
      this.fileStale.delete(existing.id)
      this.persistFiles()
      this.push()
      return
    }
    this.fileSeq += 1
    const tab: FileTab = {
      id: `file-${Date.now().toString(36)}-${this.fileSeq}`,
      path: full,
      cwd: root,
      relPath: relative(root, full) || full
    }
    this.files.push(tab)
    this.activeFileId = tab.id
    this.fileMtime.set(tab.id, mtimeOf(full))
    this.persistFiles()
    this.push()
  }

  /** 从宿主的文件标签列表里摘掉一个文件（同步，不落盘、不推快照） */
  private removeFileTab(fileId: string): boolean {
    const index = this.files.findIndex((f) => f.id === fileId)
    if (index < 0) return false
    this.files.splice(index, 1)
    // 关掉的是活动文件 —— 活动落到相邻的一个
    if (this.activeFileId === fileId) {
      const next = this.files[Math.min(index, this.files.length - 1)]
      this.activeFileId = next ? next.id : null
    }
    this.fileMtime.delete(fileId)
    this.fileStale.delete(fileId)
    return true
  }

  /** 关掉一个文件标签 */
  async closeFile(fileId: string): Promise<void> {
    if (!this.removeFileTab(fileId)) return
    this.persistFiles()
    this.push()
  }

  /**
   * 用系统默认程序打开一个文件。
   *
   * 走的是 `shell.openPath` —— 拿系统登记的程序打开，不是执行它。
   * 同样要过路径校验：不能让渲染进程传 `../../etc/passwd` 过来。
   */
  async openFileExternal(cwd: string, path: string): Promise<void> {
    const full = await resolveInsideCwd(cwd, path)
    const error = await shell.openPath(full)
    if (error) throw new Error(error)
  }

  /** 切到某个文件标签 */
  async activateFile(fileId: string): Promise<void> {
    if (!this.files.some((f) => f.id === fileId)) return
    this.activeFileId = fileId
    this.persistFiles()
    this.push()
  }

  /**
   * 检查打开的文件有没有在别处被改过。
   *
   * 跟会话标签的 `checkStale` 同一个思路：文件 mtime 比「已看到」的时间新就是 stale。
   * 只标记、不自动重读 —— 用户可能正在看某一段，自动刷新会把滚动位置也带走。
   */
  private checkFilesStale(): void {
    let changed = false
    for (const file of this.files) {
      const seen = this.fileMtime.get(file.id)
      // 没记录过的（刚恢复出来的）先补上，不算 stale
      if (seen === undefined) {
        this.fileMtime.set(file.id, mtimeOf(file.path))
        continue
      }
      const stale = mtimeOf(file.path) > seen
      if (stale !== this.fileStale.has(file.id)) {
        if (stale) this.fileStale.add(file.id)
        else this.fileStale.delete(file.id)
        changed = true
      }
    }
    if (changed) this.push()
  }

  /**
   * 重新加载一个文件：把它「已看到」的时间推到当下，清掉 stale。
   *
   * 内容由渲染进程重新读（`fileContents` 是按路径缓存的，清掉就会重读）。
   */
  async reloadFile(fileId: string): Promise<void> {
    const file = this.files.find((f) => f.id === fileId)
    if (!file) return
    this.fileMtime.set(fileId, mtimeOf(file.path))
    this.fileStale.delete(fileId)
    this.push()
  }

  /** 把文件标签落盘 */
  private persistFiles(): void {
    const stored: StoredFile[] = this.files.map((f) => ({
      id: f.id,
      path: f.path,
      cwd: f.cwd,
      relPath: f.relPath
    }))
    this.tabStore.saveFiles(stored, this.activeFileId)
  }

  /**
   * 恢复文件标签（PLAN.md D21 / R25）。
   *
   * **文件不在了就丢掉这一条** —— 跟会话标签同一个规则：内容就在文件里，
   * 文件没了内容也没了。但整个列表不能因为一条坏掉就全丢。
   */
  private restoreFiles(): void {
    this.files = []
    this.activeFileId = null
    for (const stored of this.tabStore.listFiles()) {
      if (!existsSync(stored.path)) continue
      this.files.push({
        id: stored.id,
        path: stored.path,
        cwd: stored.cwd,
        relPath: stored.relPath
      })
    }
    // 活动文件：原来那个还在就用它，否则落到最后一个
    const wanted = this.tabStore.activeFile()
    this.activeFileId =
      (wanted && this.files.some((f) => f.id === wanted) ? wanted : null) ??
      this.files[this.files.length - 1]?.id ??
      null
    // id 序号推上去，避免新开的标签跟恢复的撞号
    for (const file of this.files) {
      const m = /-(\d+)$/.exec(file.id)
      if (m) this.fileSeq = Math.max(this.fileSeq, Number(m[1]))
    }
  }

  /** 窗口失去焦点 —— 记下时刻，回来时算离开了多久 */
  noteBlur(): void {
    this.blurredAt = Date.now()
  }

  /**
   * 窗口重新获得焦点时，视情况重读会话列表。
   *
   * **为什么需要这个**：列表刷新本来是事件驱动的，但那只覆盖「Codelet 自己的 runtime」。
   * 用户在裸 pi 的 TUI 里说话时，那是另一个进程 —— 我们收不到任何事件，
   * 列表就一直不动，只有重启（`init()` 里无条件重读）才更新。
   *
   * **只在离开够久时才读**（MIN_AWAY_MS）：一次重读要读并解析那几个项目的 jsonl
   * （实测 4 个项目 21 个会话约 180ms，在主进程上）。
   * 点了下别的窗口又点回来不该付这个代价 —— 那段时间应用自己会收到事件。
   *
   * 没有 blur 记录（比如启动后第一次 focus）就不读：init() 已经读过一次了。
   */
  async refreshOnFocus(): Promise<void> {
    if (!this.initialized) return
    const away = Date.now() - this.blurredAt
    // 没离开过（blurredAt 是 0 或者离开时间太短）—— 不读
    if (this.blurredAt === 0 || away < MIN_AWAY_MS) return
    // 消费掉这次离开记录 —— 同一次离开只触发一次重读
    this.blurredAt = 0
    await this.refreshConversations()
    // 顺便看看打开的文件有没有被别处改过
    this.checkFilesStale()
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
        thinkingLevel: null,
        modelFallback: null,
        error: null
      }
      this.contextDiffView = null
      return
    }
    const tab = this.tabs.find((t) => t.id === tabId)
    const state = this.pi.tabState(tabId)
    this.session = {
      ready: state.ready,
      cwd: tab?.cwd ?? null,
      sessionId: state.sessionId,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      modelFallback: state.modelFallback,
      error: tab?.error ?? null
    }
    if (state.sessionId) this.contextDiff.attachTab(tabId, state.sessionId)
    this.contextDiffView = this.contextDiff.getView(tabId)
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

  /** 某个标签可用的 `/` 命令（Pi 模板、扩展、技能） */
  listCommands(tabId: string): Promise<CommandOption[]> {
    return this.pi.listCommands(tabId)
  }

  /** 某个扩展命令的参数候选 */
  completeCommand(tabId: string, name: string, prefix: string): Promise<CommandArgumentOption[]> {
    return this.pi.completeCommand(tabId, name, prefix)
  }

  /** 当前模型可用的思考等级 */
  listThinkingLevels(tabId: string): Promise<ThinkingLevel[]> {
    return Promise.resolve(this.pi.thinkingLevels(tabId))
  }

  /** 切换某个标签的思考等级（只影响当前会话） */
  async selectThinkingLevel(tabId: string, level: ThinkingLevel): Promise<void> {
    if (!this.pi.thinkingLevels(tabId).includes(level)) {
      throw new Error(`当前模型不支持思考等级 ${level}`)
    }
    this.pi.setThinkingLevel(tabId, level)
    this.readSession()
    this.push()
  }

  /** `@` 引用用的文件搜索；requestId 用来取消上一次请求 */
  async searchFiles(
    cwd: string,
    query: string,
    limit: number,
    requestId?: string
  ): Promise<FileSearchResult[]> {
    const controller = new AbortController()
    if (requestId) {
      this.fileSearches.get(requestId)?.abort()
      this.fileSearches.set(requestId, controller)
    }
    try {
      return await searchProjectFiles(cwd, query, limit, controller.signal)
    } finally {
      if (requestId && this.fileSearches.get(requestId) === controller) {
        this.fileSearches.delete(requestId)
      }
    }
  }

  /** 取消一个文件搜索；索引构建本身继续，下一次查询直接复用 */
  cancelFileSearch(requestId: string): void {
    this.fileSearches.get(requestId)?.abort()
    this.fileSearches.delete(requestId)
  }

  /** 取活动标签的上下文对比；baselineId 为空时用上一次请求 */
  async getContextDiff(tabId: string, baselineId?: string): Promise<ContextDiffView | null> {
    return this.contextDiff.getView(tabId, baselineId)
  }

  /** 截至某一轮的最后两次请求；对话导航圆点用 */
  async getContextDiffForTurn(
    tabId: string,
    turn: number,
    baselineId?: string
  ): Promise<ContextDiffView | null> {
    return this.contextDiff.getViewForTurn(tabId, turn, baselineId)
  }

  /** 有快照可比较的会话（跨会话基线选择器） */
  listContextDiffSessions(): Promise<ContextDiffSession[]> {
    return Promise.resolve(this.contextDiff.listSessions())
  }

  /** 某个标签当前会话的请求快照 */
  listContextDiffSnapshots(tabId: string): Promise<ContextSnapshotRef[]> {
    return Promise.resolve(this.contextDiff.listSnapshots(tabId))
  }

  /** 取某条消息全文；只用于当前/已加载的会话快照 */
  async getContextDiffDetail(
    tabId: string,
    snapshotId: string,
    key: string
  ): Promise<{ text: string; truncated: boolean } | null> {
    return this.contextDiff.detail(tabId, snapshotId, key)
  }

  /** 打开或恢复临时对话；已有会话时不新建 */
  async openTemporaryChat(): Promise<HostSnapshot> {
    if (this.temporaryChat) return this.snapshot()

    const active = this.tabs.find((tab) => tab.id === this.activeTabId)
    if (!active) throw new Error('先打开一个项目再使用临时对话')
    const activeModel = this.activeTabId ? this.pi.tabState(this.activeTabId).model : null
    const id = `temp-${++this.temporarySeq}`

    await this.pi.openTab(id, { cwd: active.cwd, inMemory: true })
    this.temporaryChat = { id, cwd: active.cwd, model: null, error: null }

    if (activeModel) {
      try {
        await this.pi.selectModel(id, activeModel.provider, activeModel.id, false)
      } catch (error) {
        if (this.temporaryChat?.id === id) {
          this.temporaryChat.error = error instanceof Error ? error.message : String(error)
        }
      }
    }
    this.refreshTemporary()
    this.push()
    return this.snapshot()
  }

  /** 彻底关闭临时对话；内存 session 随 runtime 释放 */
  async closeTemporaryChat(): Promise<HostSnapshot> {
    const temp = this.temporaryChat
    if (!temp) return this.snapshot()
    await this.pi.closeTab(temp.id)
    this.temporaryChat = null
    this.push()
    return this.snapshot()
  }

  /** 临时对话发消息；只接受系统选择器上传的附件 id */
  async promptTemporary(id: string, text: string, uploadIds?: string[]): Promise<void> {
    const temp = this.temporaryChat
    if (!temp || temp.id !== id) throw new Error('临时对话已经关闭')
    const external = this.resolveUploads(uploadIds)
    const prepared = await prepareAttachments(temp.cwd, [], external)
    const merged = prepared.text ? `${text}\n\n${prepared.text}` : text
    await this.pi.prompt(id, merged, prepared.images, { expandPromptTemplates: false })
    for (const upload of external) this.uploads.delete(upload.id)
  }

  /** 中止临时对话当前轮 */
  async abortTemporary(id: string): Promise<void> {
    if (!this.temporaryChat || this.temporaryChat.id !== id) return
    await this.pi.abortTab(id)
  }

  /** 临时对话可用模型 */
  listTemporaryModels(id: string): Promise<ModelOption[]> {
    if (!this.temporaryChat || this.temporaryChat.id !== id) return Promise.resolve([])
    return this.pi.listModels(id)
  }

  /** 临时对话切换模型；persist 固定为 false */
  async selectTemporaryModel(id: string, provider: string, modelId: string): Promise<HostSnapshot> {
    if (!this.temporaryChat || this.temporaryChat.id !== id) throw new Error('临时对话已经关闭')
    await this.pi.selectModel(id, provider, modelId, false)
    this.refreshTemporary()
    this.push()
    return this.snapshot()
  }

  private refreshTemporary(): void {
    if (!this.temporaryChat) return
    const state = this.pi.tabState(this.temporaryChat.id)
    this.temporaryChat.model = state.model
    if (state.modelFallback) this.temporaryChat.error = state.modelFallback
  }

  private resolveUploads(uploadIds?: string[]): ExternalAttachment[] {
    const external: ExternalAttachment[] = []
    for (const id of uploadIds ?? []) {
      const upload = this.uploads.get(id)
      if (!upload) throw new Error('上传的附件已失效，请重新选择')
      external.push(upload)
    }
    return external
  }

  /** 压缩某个标签的上下文 */
  async compactTab(tabId: string): Promise<void> {
    await this.pi.compactTab(tabId)
  }

  /** 切某个标签的模型 */
  async selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void> {
    await this.pi.selectModel(tabId, provider, id, persist)
    this.readSession()
    this.push()
  }

  /**
   * 给一个会话改名（PLAN.md D24）。
   *
   * 名字写进 Pi 的会话文件（`session_info` 条目），重读列表之后标题就变了。
   * 空名字表示清掉自定义名，标题退回第一条用户消息。
   *
   * 路径必须命中当前会话列表 —— 跟删除用同一条白名单规则。
   */
  async renameConversation(path: string, name: string): Promise<void> {
    const target = normalize(path)
    const conversation = this.conversations.find((item) => normalize(item.path) === target)
    if (!conversation) throw new Error(`不在当前对话列表里：${path}`)
    await this.pi.renameSession(conversation.path, name.trim())
    // 不等去抖：改名要立刻反映到侧栏标题和标签标题上
    await this.refreshConversations()
    this.readSession()
    this.push()
  }

  /**
   * 往某个标签发一条用户消息。
   *
   * attachments 是项目内的相对路径；uploads 是 pickAttachments() 返回的 id。
   * 只有这里能把 id 解析成绝对路径，渲染进程拿不到这个映射。
   */
  async prompt(
    tabId: string,
    text: string,
    attachments?: string[],
    uploadIds?: string[]
  ): Promise<void> {
    const tab = this.tabs.find((item) => item.id === tabId)
    if (!tab) throw new Error(`标签不存在：${tabId}`)

    const external = this.resolveUploads(uploadIds)

    if ((!attachments || attachments.length === 0) && external.length === 0) {
      await this.pi.prompt(tabId, text)
      return
    }

    const prepared = await prepareAttachments(tab.cwd, attachments ?? [], external)
    const merged = prepared.text ? `${text}\n\n${prepared.text}` : text
    await this.pi.prompt(tabId, merged, prepared.images)

    // 发送成功才丢弃上传映射；失败时保留，用户可以直接重试
    for (const upload of external) this.uploads.delete(upload.id)
  }

  /** 打开系统文件选择器，读并校验选中的文件，返回可显示的附件元信息 */
  async pickAttachments(): Promise<PickAttachmentsResult> {
    const selected = await this.pickFiles()
    if (!selected || selected.length === 0) return { attachments: [], errors: [] }

    const attachments: PickAttachmentsResult['attachments'] = []
    const errors: string[] = []
    for (const path of selected) {
      const name = externalAttachmentName(path)
      if (attachments.length >= ATTACHMENT_LIMITS.maxCount) {
        errors.push(`附件最多 ${ATTACHMENT_LIMITS.maxCount} 个，已忽略「${name}」`)
        continue
      }
      try {
        const checked = await inspectExternalFile(path)
        if ('error' in checked) {
          errors.push(`${name}：${checked.error}`)
          continue
        }
        const id = `upload-${++this.uploadSeq}`
        this.uploads.set(id, { id, name, path })
        attachments.push({ id, name, ...checked.attachment })
      } catch (error) {
        errors.push(`${name}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { attachments, errors }
  }

  /**
   * 中止某个标签正在跑的那一轮。
   *
   * 先把 tabId 记进 `aborting` 再推快照 —— 界面要靠它显示「停止中」，
   * 而 `abort()` 可能要等好几秒（工具在执行）。
   *
   * 已经在停的标签直接返回：按钮连点两下不该调两次 `abort()`。
   */
  async abortPrompt(tabId: string): Promise<void> {
    if (this.aborting.has(tabId)) return
    this.aborting.add(tabId)
    this.emit('snapshot', this.snapshot())
    try {
      await this.pi.abortTab(tabId)
    } finally {
      this.aborting.delete(tabId)
      this.emit('snapshot', this.snapshot())
    }
  }

  /**
   * 记一条扩展错误。同一个错误（同标签、同类型、同路径、同事件、同正文）只保留一条，
   * 重复发生时把它挪到末尾；最多留 20 条，避免刷屏。
   */
  private recordExtensionError(tabId: string, error: Omit<ExtensionErrorInfo, 'tabId'>): void {
    const entry: ExtensionErrorInfo = { ...error, tabId }
    const keyOf = (item: ExtensionErrorInfo): string =>
      `${item.tabId}|${item.kind}|${item.path}|${item.event ?? ''}|${item.message}`
    const key = keyOf(entry)
    const index = this.extensionErrors.findIndex((item) => keyOf(item) === key)
    if (index >= 0) this.extensionErrors.splice(index, 1)
    this.extensionErrors.push(entry)
    if (this.extensionErrors.length > 20) {
      this.extensionErrors.splice(0, this.extensionErrors.length - 20)
    }
    this.push()
  }

  /** 清掉已经显示的扩展错误 */
  dismissExtensionErrors(): void {
    if (this.extensionErrors.length === 0) return
    this.extensionErrors = []
    this.push()
  }

  async dispose(): Promise<void> {
    this.conversationsRefresh.dispose()
    for (const controller of this.fileSearches.values()) controller.abort()
    this.fileSearches.clear()
    this.uploads.clear()
    this.temporaryChat = null
    await this.pi.stop()
  }
}
