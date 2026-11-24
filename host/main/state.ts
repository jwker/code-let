import { EventEmitter } from 'node:events'
import { existsSync, statSync } from 'node:fs'
import { basename, dirname, join, normalize, relative, resolve } from 'node:path'
import type {
  AgentInfo,
  AgentTypeDef,
  AgentTypeDraft,
  AgentTypeRemoveResult,
  AgentTypeSaveResult,
  CommandArgumentOption,
  GitDiff,
  GitDiffScope,
  GitStatus,
  CommandOption,
  ConversationInfo,
  DeleteConversationsResult,
  ExtensionErrorInfo,
  FileContent,
  FileListResult,
  FileSearchResult,
  FileTab,
  HostSnapshot,
  ModelOption,
  PickAttachmentsResult,
  ProjectPaneView,
  ProjectTabInfo,
  RightPanelState,
  SessionState,
  FlatSessionTree,
  ThinkingLevel,
  StreamItem,
  TemporaryChatState,
  TreeNavigateResult
} from '@contract/index'
import { ATTACHMENT_LIMITS } from '@contract/index'
import {
  externalAttachmentName,
  inspectExternalFile,
  prepareAttachments,
  type ExternalAttachment
} from './attachments'
import { DebugConsoleStore, type ConsoleRecordInput } from './debugConsole'
import type { BrowserManager } from './browser'
import { formatAnchorBreaks } from './anchorCheck'
import { agentBrowserHost, agentIdOfHost, type BrowserHost } from '@contract/browser'
import type { PreviewEntry } from '@contract/index'
import { choosePreviewEntry, listPrototypeFiles } from './prototypeFiles'
import { emptyGitStatus, readGitDiff, readGitStatus } from './git'
import { affectsConversationList, DebouncedRefresh } from './conversationRefresh'
import { pickDirectory } from './directoryPicker'
import { pickFiles } from './filePicker'
import { shell } from 'electron'
import {
  PathOutsideCwdError,
  listDirectory,
  readFileContent,
  resolveInsideCwd,
  searchFiles as searchProjectFiles
} from './files'
import { PiRuntime, type PiEvent, type PiRuntimePort } from './pi/runtime'
import { DEFAULT_PROTOTYPE_DIR, normalizePrototypeDir, ProjectStore } from './projects'
import { prototypePromptFragment } from './prototypePrompt'
import { AgentTypeStore } from './agentTypes'
import {
  AgentStore,
  dueForArchive,
  migrateLegacyTabs,
  newAgentRecord,
  restoreRecord,
  type AgentRecord
} from './agents'
import { moveSessionFilesToTrash } from './sessionFiles'
import { TabStore, type StoredFile, type StoredProjectTab } from './tabs'


/**
 * agent 的运行时附加状态 —— **不落盘**。
 *
 * 落盘的那部分在 `AgentRecord`（`agents.json`）。这里只放跟这个进程绑定的东西：
 * 建 runtime 失败的原因、会话文件的 mtime 水位、stale 标记。
 */
interface AgentLiveState {
  /** 创建 / 恢复失败时的原因 */
  error: string | null
  /**
   * 这个 agent「已经看到」的会话文件修改时间（ms）。
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
  /** 浏览器（预览宿主）。宿主状态拿它做「一轮结束要不要刷新预览」 */
  private browser: BrowserManager | null = null
  /** 用户选的项目清单 —— 会话清单只列这些项目的会话 */
  private readonly projects: ProjectStore
  private readonly tabStore: TabStore
  private readonly agentStore: AgentStore
  /** agent 类型的定义清单（内置 + 自定义） */
  private readonly agentTypes: AgentTypeStore
  private readonly pickDirectory: () => Promise<string | null>
  private readonly pickFiles: () => Promise<string[] | null>
  /** 项目标签（一个项目一条，PLAN.md D50） */
  private tabs: StoredProjectTab[] = []
  private activeTabId: string | null = null
  /** agent 的运行时附加状态，键是 agent id */
  private live = new Map<string, AgentLiveState>()
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
  /** 调试控制台的存储 */
  readonly console: DebugConsoleStore
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
  private agentSeq = 0
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
    agentStore?: AgentStore
    agentTypeStore?: AgentTypeStore
    projects?: ProjectStore
    pickDirectory?: () => Promise<string | null>
    pickFiles?: () => Promise<string[] | null>
    /** 调试控制台的存储目录 */
    consoleDir?: string
    trashFile?: (path: string) => Promise<void>
  }) {
    super()
    this.pi = options?.pi ?? new PiRuntime()
    this.projects = options?.projects ?? new ProjectStore()
    this.tabStore = options?.tabStore ?? new TabStore()
    // 默认跟 tabs.json 放同一个目录（生产的 userData、测试的临时目录都是这个规则）
    this.agentStore = options?.agentStore ?? new AgentStore(join(dirname(this.tabStore.path), 'agents.json'))
    this.agentTypes =
      options?.agentTypeStore ??
      new AgentTypeStore(join(dirname(this.tabStore.path), 'agentTypes.json'))
    this.pickDirectory = options?.pickDirectory ?? pickDirectory
    this.pickFiles = options?.pickFiles ?? pickFiles
    this.console = new DebugConsoleStore(options?.consoleDir ?? null)
    // 写完一条记录就通知宿主，界面据此刷新列表
    this.console.setChangeListener(() => {
      this.emit('console-updated')
    })
    this.trashFile = options?.trashFile ?? ((path) => shell.trashItem(path))
    this.conversationsRefresh = new DebouncedRefresh(() => this.refreshConversations())
  }

  /**
   * 把浏览器接到 Pi 的 `browser_*` 工具。
   *
   * **宿主由 agent id 决定**：每个 agent 只能操作自己那套标签（D57）。
   * 这条不是便利性，是安全边界 —— 共用一个池的话，agent 点一下就把
   * 用户正在看的那一页换掉了。
   */
  attachBrowser(browser: BrowserManager): void {
    this.browser = browser
    this.pi.setBrowserToolHandler?.((agentId, request) => {
      const payload = request as { tool?: unknown; args?: unknown }
      const tool = typeof payload.tool === 'string' ? payload.tool : ''
      const args =
        payload.args && typeof payload.args === 'object'
          ? (payload.args as Record<string, unknown>)
          : {}
      // 宿主由 agent id 决定 —— agent 碰不到项目浏览器的标签（D57）
      return browser.tool(tool, args, agentBrowserHost(agentId))
    })
  }

  /**
   * 某个浏览器宿主对应的项目目录。
   *
   * 引用载荷里的「文件」要相对它写成 `preview/pricing.html` 这种样子。
   * 项目级宿主没有 agent，自然也没有目录。
   */
  cwdForHost(host: BrowserHost): string | null {
    const agentId = agentIdOfHost(host)
    return agentId ? (this.agentStore.get(agentId)?.cwd ?? null) : null
  }

  /**
   * 记下某个产品 agent 上次预览的本地文件。
   *
   * 只有产品 agent 有预览；地址不是本地文件时不记（http 预览下次启动多半打不开）。
   * 同一个地址不重复写盘 —— 重载、页内跳转都会走到这里。
   */
  rememberPreviewUrl(agentId: string, url: string): void {
    const agent = this.agentStore.get(agentId)
    if (!agent || agent.type !== 'product') return
    if (agent.previewUrl === url) return
    this.agentStore.update(agentId, { previewUrl: url })
  }

  /**
   * 这个 agent 的系统提示片段：用户的提示词 + 程序片段。
   *
   * 顺序固定：用户在前、程序在后，界面不给调序。用户提示词为空（或只有空白）
   * 就不占位置 —— 空串进 `appendSystemPrompt` 会让 pi 多一段空内容。
   * 类型找不到定义（未知 agent）时只可能拿到空数组。
   *
   * 只在建 runtime 时取：改了提示词之后，已开的会话要 `/reload` 或新建才会变。
   */
  private promptFragmentsFor(agent: Pick<AgentRecord, 'type' | 'cwd'>): string[] {
    const def = this.agentTypes.get(agent.type)
    const user = def && def.prompt.trim() !== '' ? [def.prompt] : []
    return [...user, ...this.programFragmentFor(def, agent.cwd)]
  }

  /**
   * 程序片段：按类型能力生成、用户改不了的那部分。
   *
   * 今天只有带预览能力的类型（内置产品 agent）有；项目管理里没有这个项目时
   * 按默认原型目录算。
   */
  private programFragmentFor(def: AgentTypeDef | null, cwd: string): string[] {
    const project = this.projects.list().find((item) => item.path === cwd)
    return prototypePromptFragment({
      type: def,
      cwd,
      prototypeDir: project?.prototypeDir ?? DEFAULT_PROTOTYPE_DIR
    })
  }

  // ---------------------------------------------------------------------
  // agent 类型（ADR-0004）
  // ---------------------------------------------------------------------

  /** 定义清单：内置三个在前，自定义按创建顺序 */
  listAgentTypes(): AgentTypeDef[] {
    return this.agentTypes.list()
  }

  /** 新建一个自定义 agent。成功之后推一份新的清单给所有窗口 */
  createAgentType(draft: AgentTypeDraft): AgentTypeSaveResult {
    const result = this.agentTypes.create(draft, Date.now())
    if (result.ok) this.emit('agent-types', this.agentTypes.list())
    return result
  }

  /** 改一个。内置类型只收提示词（`AgentTypeStore.update` 里挡） */
  updateAgentType(id: string, draft: AgentTypeDraft): AgentTypeSaveResult {
    const result = this.agentTypes.update(id, draft)
    if (result.ok) this.emit('agent-types', this.agentTypes.list())
    return result
  }

  /**
   * 删一个自定义类型。
   *
   * **有 agent 在用就不让删** —— 不是怕麻烦：删掉之后那些 agent 会变成
   * 未知 agent，用户看到的是「头像变灰、提示词没了」，而他只是想清理列表。
   * 归档的也算在用 —— 记录还在，恢复回来还要靠这个类型。
   */
  removeAgentType(id: string): AgentTypeRemoveResult {
    const usedBy = this.agentStore.list().filter((agent) => agent.type === id).length
    if (usedBy > 0) return { ok: false, error: `有 ${usedBy} 个 agent 在用`, usedBy }
    const result = this.agentTypes.remove(id)
    if (result.ok) this.emit('agent-types', this.agentTypes.list())
    return result
  }

  /**
   * 预览区该显示什么：上次的地址还能用就恢复，否则列项目的原型目录。
   *
   * 只对产品 agent 的预览宿主有意义；项目级浏览器与通用 / 开发 agent 一律空态。
   * `restorePreviewOnce` 保证「一次运行只恢复一次」—— 用户自己关掉的预览标签
   * 不会因为切回来又冒出来，这时给的是目录列表。
   */
  async previewEntry(host: BrowserHost): Promise<PreviewEntry> {
    const agentId = agentIdOfHost(host)
    const agent = agentId ? this.agentStore.get(agentId) : null
    const project = agent ? this.projects.list().find((item) => item.path === agent.cwd) : null
    if (!agent || agent.type !== 'product' || !project) {
      return { kind: 'empty', listing: { dir: '', exists: false, files: [] } }
    }
    const restored = await this.browser?.restorePreviewOnce(host, agent.previewUrl)
    if (restored) return { kind: 'restore', url: restored }
    const listing = await listPrototypeFiles(resolve(agent.cwd, project.prototypeDir))
    return choosePreviewEntry(null, listing)
  }

  // ---------------------------------------------------------------------
  // 快照
  // ---------------------------------------------------------------------

  snapshot(): HostSnapshot {
    return {
      activeAgentId: this.activeTab()?.activeAgentId ?? null,
      projectTabs: this.tabs.map((tab) => this.projectTabInfo(tab)),
      activeProjectTabId: this.activeTabId,
      agents: this.agentStore.list().map((agent) => this.agentInfo(agent)),
      projects: this.projects.list(),
      conversations: this.conversations,
      refreshing: this.pendingRefreshes > 0,
      aborting: [...this.aborting],
      // stale 是派生状态，不存在 FileTab 里，推快照时合进去
      files: this.files.map((f) => (this.fileStale.has(f.id) ? { ...f, stale: true } : f)),
      activeFileId: this.activeFileId,
      extensionErrors: this.extensionErrors,
      temporaryChat: this.temporaryChat ? { ...this.temporaryChat } : null,
      session: this.session
    }
  }

  private projectTabInfo(tab: StoredProjectTab): ProjectTabInfo {
    return {
      id: tab.id,
      cwd: tab.cwd,
      title: tab.title,
      pane: tab.pane,
      rightPanel: { ...tab.rightPanel },
      activeAgentId: tab.activeAgentId
    }
  }

  private agentInfo(agent: AgentRecord): AgentInfo {
    const state = this.pi.agentState(agent.id)
    const conversation = agent.sessionPath
      ? this.conversations.find((item) => item.path === agent.sessionPath)
      : undefined
    return {
      id: agent.id,
      name: agent.name,
      sessionTitle: conversation?.title ?? null,
      type: agent.type,
      instance: agent.instance,
      cwd: agent.cwd,
      sessionPath: agent.sessionPath,
      lastActiveAt: agent.lastActiveAt,
      archivedAt: agent.archivedAt,
      turns: agent.turns,
      streaming: state.streaming,
      ready: state.ready,
      // 只读，不走 liveOf() —— 那个会顺手建一条 live 记录，快照每次都建就成泄漏了
      stale: this.live.get(agent.id)?.stale ?? false
    }
  }

  private push(): void {
    this.emit('snapshot', this.snapshot())
  }

  /**
   * 处理一条 Pi 会话事件（真事件和测试钩子都走这里）。
   *
   * 公开出来是给端到端测试用的：`globalThis.__codeletSessionEvent` 只在测试环境挂，
   * 用例靠它把「一轮开始 / 一轮结束」送进宿主，不用跑真模型。
   */
  handleSessionEvent(event: PiEvent): void {
    // 扩展错误走快照，不混进会话事件流
    if (event.type === 'extension_error') {
      this.recordExtensionError(event.agentId, event.data as Omit<ExtensionErrorInfo, 'agentId'>)
      return
    }
    // 调试控制台的记录：进存储，**不进会话事件流** —— 正文太大，不能发给渲染进程
    if (event.type === 'debug_console_record') {
      this.console.enqueue(event.data as ConsoleRecordInput)
      this.emit('console-updated')
      return
    }
    /*
     * 一轮的开始与结束：记下 / 比较原型文件的修改时间。
     * 结束那一下如果这一轮动过文件，预览自动重新加载（票 04），
     * 同时做一次保号校验，号都还在就不出声。
     */
    if (event.type === 'agent_start') void this.browser?.noteTurnStart(event.agentId)
    if (event.type === 'agent_settled') void this.finishAgentTurn(event.agentId)

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
    if (event.type === 'agent_settled') this.markWritten(event.agentId)
  }

  /**
   * 一轮收尾：动过原型文件就刷新预览，号被改坏了就在对话里说一声。
   *
   * 提示走自定义消息：用户看得见，agent 在下一轮上下文里也看得见。
   * 没变化时一个字都不发 —— 不制造噪音。
   */
  private async finishAgentTurn(agentId: string): Promise<void> {
    const result = await this.browser?.noteTurnEnd(agentId)
    if (!result || result.breaks.length === 0) return
    const content = formatAnchorBreaks(result.breaks, result.file)
    if (!content) return
    try {
      await this.pi.sendCustomMessage?.(agentId, {
        customType: 'annotation',
        content,
        display: true
      })
      /*
       * 这条提示是我们自己写进会话的。不把「已看到」推上去的话，文件 mtime
       * 会比 seenMtime 新，下一次 stale 检查就把自己的写入当成「别处改过」——
       * 界面上会冒出「这个会话在别处有更新」，用户点重新加载才发现是虚惊。
       */
      this.markWritten(agentId)
    } catch {
      // runtime 已经关了、提示发不出去 —— 不能拖垮轮结束
    }
  }

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------

  async init(): Promise<void> {
    // 会话流事件：转发给渲染进程（带 tabId）
    this.pi.onEvent((event) => this.handleSessionEvent(event))

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
   * 恢复项目标签；v1 的旧标签先迁成 agent（PLAN.md D59）。
   *
   * **迁移只在 `agents.json` 还空着的时候跑** —— 迁移完但写盘前崩了的话，
   * 第二次启动不会再建一遍。
   */
  private async restoreTabs(): Promise<boolean> {
    await this.migrateLegacyTabsOnce()

    this.tabs.push(...this.tabStore.list())
    if (this.tabs.length === 0) return false

    /*
     * 登记**所有**未归档的 agent，不是只登记每个项目标签的活动那个。
     *
     * 一个项目里可以有好几个 agent，而项目标签只记一个「活动」的。
     * 只登记活动那个的话，点其它 agent 的头像会「标签不存在」——
     * 这条是跑真机时才暴露的（migration 之后一个项目里有 4 个 agent）。
     */
    for (const agent of this.agentStore.visible()) {
      await this.registerAgent(agent)
    }
    // 恢复出来的第一个标签成为活动标签；它的 agent 这时才建 runtime
    this.activeTabId = this.tabs[0].id
    const first = this.tabs[0].activeAgentId
    if (first) await this.pi.activateAgent(first)
    this.readSession()
    this.persistTabs()
    this.push()
    return true
  }

  /**
   * 给一个 agent 登记 runtime（懒加载：不建，只登记）。
   *
   * 会话文件还在 → 打开它，内容都在；文件不在 → 在同一个目录里当**新会话**开，agent 留着。
   * 「有路径、没文件」的 agent 绝大多数是从没说过话的空 agent —— Pi 创建会话时就给了路径，
   * 文件要等第一条消息才建。它们本来就没有内容可丢，不该因为「没文件」被扔掉。
   */
  private async registerAgent(agent: AgentRecord): Promise<void> {
    const hasFile = Boolean(agent.sessionPath && existsSync(agent.sessionPath))
    try {
      await this.pi.openAgent(agent.id, {
        cwd: agent.cwd,
        path: hasFile ? (agent.sessionPath ?? undefined) : undefined,
        lazy: true,
        appendSystemPrompt: this.promptFragmentsFor(agent)
      })
      // 文件已经不在了 —— 上面重开了一条新会话，旧路径留着只会误导
      if (!hasFile) this.agentStore.update(agent.id, { sessionPath: null })
    } catch (error) {
      // 目录被删之类 —— agent 留着，但标出来
      this.liveOf(agent.id).error = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * 把 v1 的会话标签迁成 agent + 项目标签（D59）。
   *
   * 同一个项目下的多条旧标签合成**一条**项目标签，活动 agent 取第一个 ——
   * 新外壳一个项目一条标签，其余 agent 都进窄轨。
   */
  private async migrateLegacyTabsOnce(): Promise<void> {
    const legacy = this.tabStore.legacyTabs()
    if (legacy.length === 0) return
    this.tabStore.backupLegacy()
    if (this.agentStore.list().length === 0) {
      const now = Date.now()
      const { agents } = migrateLegacyTabs(
        legacy.map((tab) => ({ id: tab.id, cwd: tab.cwd, path: tab.path, title: tab.title })),
        now
      )
      this.agentStore.replaceAll(agents)

      const tabs: StoredProjectTab[] = []
      for (const agent of agents) {
        if (tabs.some((item) => item.cwd === agent.cwd)) continue
        tabs.push({
          id: this.nextTabId(),
          cwd: agent.cwd,
          title: basename(agent.cwd) || agent.cwd,
          pane: 'agent',
          rightPanel: { open: false, kind: null },
          activeAgentId: agent.id
        })
      }
      this.tabStore.saveTabs(tabs)
      return
    }
    // agent 清单已经有内容 —— 上次迁到一半就崩了。丢掉旧数据，不重复建 agent
    this.tabStore.saveTabs([])
  }

  /**
   * 首次启动（没有任何标签）时的退路：接着最近的那个会话跑。
   *
   * 一条会话都没有的话，就在第一个项目里新建一个 agent。
   */
  private async openFallbackTab(): Promise<void> {
    const projects = this.projects.list()
    // 一个项目都没选 —— 不开标签，等用户「打开项目」
    if (projects.length === 0) return
    const latest = this.conversations[0]
    if (latest) {
      await this.openConversation(latest.path, latest.cwd)
      return
    }
    await this.createAgent({ cwd: projects[0].path })
  }

  // ---------------------------------------------------------------------
  // 项目标签与 agent（PLAN.md D50 / D53 / D58）
  // ---------------------------------------------------------------------

  private nextTabId(): string {
    this.tabSeq += 1
    return `tab-${Date.now().toString(36)}-${this.tabSeq}`
  }

  private nextAgentId(): string {
    this.agentSeq += 1
    return `agent-${Date.now().toString(36)}-${this.agentSeq}`
  }

  private tabById(id: string): StoredProjectTab | null {
    return this.tabs.find((tab) => tab.id === id) ?? null
  }

  private activeTab(): StoredProjectTab | null {
    return this.activeTabId ? this.tabById(this.activeTabId) : null
  }

  /** 当前活动 agent —— 项目标签里记的那个 */
  private activeAgent(): AgentRecord | null {
    const tab = this.activeTab()
    return tab?.activeAgentId ? this.agentStore.get(tab.activeAgentId) : null
  }

  private agentById(id: string): AgentRecord | null {
    return this.agentStore.get(id)
  }

  /** 惰性建一条 live 状态：没有就按会话文件当前的 mtime 起一条 */
  /**
   * 这个 agent 真的干了活 —— 把最后活动时间推到当下。
   *
   * 窄轨按它排序：点开一个 agent 不该让它跳到最前面，发消息才该（D53）。
   */
  private noteActivity(agentId: string): void {
    this.agentStore.update(agentId, { lastActiveAt: Date.now() })
  }

  private liveOf(agentId: string): AgentLiveState {
    const found = this.live.get(agentId)
    if (found) return found
    const agent = this.agentStore.get(agentId)
    const value: AgentLiveState = {
      error: null,
      seenMtime: mtimeOf(agent?.sessionPath ?? null),
      stale: false
    }
    this.live.set(agentId, value)
    return value
  }

  /** agent 属于哪个项目标签 */
  private tabOfAgent(agentId: string): StoredProjectTab | null {
    return this.tabs.find((tab) => tab.activeAgentId === agentId) ?? null
  }

  /**
   * 项目里一条 agent 都不剩时的退路。
   *
   * 左列没有可聊的东西，右栏落到代码 —— 至少有仉能看的，不让人对着一片空白。
   */
  private fallbackWhenNoAgent(tab: StoredProjectTab): void {
    if (tab.activeAgentId) return
    tab.pane = 'agent'
    tab.rightPanel = { open: true, kind: 'code' }
  }

  /** 找一个项目的标签；没有就建一条 */
  private ensureProjectTab(cwd: string): StoredProjectTab {
    const found = this.tabs.find((tab) => tab.cwd === cwd)
    if (found) return found
    const tab: StoredProjectTab = {
      id: this.nextTabId(),
      cwd,
      title: basename(cwd) || cwd,
      pane: 'agent',
      rightPanel: { open: false, kind: null },
      activeAgentId: null
    }
    this.tabs.push(tab)
    return tab
  }

  /**
   * 被归档 / 删除的那个 agent，位置该由谁来接。
   *
   * 取**相邻**的那一个（先看后面，没有再看前面）。不看相邻的话，归档掉第三个会跳回
   * 第一个，眼睛会跟丢。
   *
   * **必须在归档之前调用** —— 归档之后它就查不到自己了，也就不知道邻居是谁。
   */
  private neighborAgentFor(cwd: string, agentId: string): string | null {
    return this.successorAfterRemoval(cwd, new Set([agentId]), agentId)
  }

  /**
   * 一批 agent 要被拿掉时，`fromId` 这个位置该由谁接。
   *
   * 从后往前找第一个**没在 `removedIds` 里**的 —— 批量删会话时，
   * 相邻的那个可能也在这批里，直接取邻居会得到一个马上要消失的 id。
   */
  private successorAfterRemoval(cwd: string, removedIds: Set<string>, fromId: string | null): string | null {
    const list = this.agentStore.visible().filter((agent) => agent.cwd === cwd)
    const scan = (start: number, step: number): string | null => {
      for (let i = start; i >= 0 && i < list.length; i += step) {
        if (!removedIds.has(list[i].id)) return list[i].id
      }
      return null
    }
    const index = fromId ? list.findIndex((agent) => agent.id === fromId) : -1
    if (index < 0) return scan(0, 1)
    return scan(index + 1, 1) ?? scan(index - 1, -1)
  }

  /**
   * 建一个 agent：一套独立的 runtime + 一条会话。
   *
   * `from` 给了就按它的类型建（右键「以此 agent 新建实例」），实例序号自动取下一个。
   * 建完立刻把 Pi 算出来的会话路径记下来，不然重启时它会变回「没路径的空 agent」。
   */
  private async createAgent(options: {
    cwd: string
    type?: string
    name?: string
    sessionPath?: string | null
    from?: AgentRecord | null
    activate?: boolean
  }): Promise<AgentRecord> {
    const type = options.type ?? options.from?.type ?? 'general'
    const id = this.nextAgentId()
    await this.pi.openAgent(id, {
      cwd: options.cwd,
      ...(options.sessionPath ? { path: options.sessionPath } : {}),
      appendSystemPrompt: this.promptFragmentsFor({ type, cwd: options.cwd })
    })
    const sessionPath = options.sessionPath ?? this.pi.agentState(id).sessionFile
    const def = this.agentTypes.get(type)
    const record = newAgentRecord({
      id,
      type,
      ...(def ? { typeDef: def } : {}),
      instance: this.agentStore.nextInstance(type, options.cwd),
      cwd: options.cwd,
      sessionPath,
      now: Date.now(),
      ...(options.name ? { name: options.name } : {})
    })
    this.agentStore.add(record)
    this.live.set(id, { error: null, seenMtime: mtimeOf(sessionPath), stale: false })

    const tab = this.ensureProjectTab(options.cwd)
    if (options.activate !== false) {
      tab.activeAgentId = id
      tab.pane = 'agent'
      this.activeTabId = tab.id
    }
    this.persistTabs()
    this.readSession()
    this.push()
    return record
  }

  /** 打开项目（系统目录选择器）→ 加进清单 → 建项目标签 + 一个 agent */
  async openProject(): Promise<string | null> {
    const picked = await this.pickDirectory()
    if (!picked) return null
    const dir = normalize(picked)
    await this.addProject(dir)
    const tab = this.ensureProjectTab(dir)
    const existing = tab.activeAgentId ? this.agentById(tab.activeAgentId) : null
    if (existing) {
      // 这个项目已经有 agent 了 —— 激活它，不新开一条会话
      await this.activateAgent(existing.id)
      return dir
    }
    await this.createAgent({ cwd: dir })
    return dir
  }

  /**
   * 把一个项目加进清单，并重读它的会话。
   *
   * **必须重读** —— 会话清单只列清单里的项目，而清单是刚变的。
   */
  async addProject(path: string): Promise<void> {
    this.projects.add(path)
    await this.refreshConversations()
    this.push()
  }

  /**
   * 设置一个项目的原型图目录。
   *
   * 只改项目清单，**不创建目录** —— 目录由 agent 写文件时自然出现。
   * 已开着的产品 agent 的提示不会立刻变：`/reload` 或新开 agent 之后生效。
   */
  async setProjectPrototypeDir(cwd: string, input: string): Promise<void> {
    const checked = normalizePrototypeDir(cwd, input)
    if (checked.dir === undefined) throw new Error(checked.error)
    this.projects.setPrototypeDir(cwd, checked.dir)
    this.push()
  }

  /**
   * 从清单里移除一个项目。
   *
   * **Pi 存的对话一个字都不动** —— 只是这个目录不再出现在 Codelet 的清单里。
   * 已经打开的标签留着照常用，只是标记成「已移除」。
   */
  async removeProject(path: string): Promise<void> {
    this.projects.remove(path)
    await this.refreshConversations()
    this.push()
  }

  /** 把一条已有会话导入成通用 agent —— 会话文件不动，只是给它一个 agent */
  async importConversation(path: string): Promise<void> {
    const conversation = this.conversations.find((item) => item.path === path)
    if (!conversation) throw new Error(`不在当前会话列表里：${path}`)
    await this.openConversation(conversation.path, conversation.cwd)
  }

  /** 打开一条已有会话 —— 已经有 agent 管着它就激活那个 agent */
  async openConversation(path: string, cwd: string): Promise<void> {
    const existing = this.agentStore.list().find((agent) => agent.sessionPath === path)
    if (existing) {
      await this.activateAgent(existing.id)
      return
    }
    const conversation = this.conversations.find((c) => c.path === path)
    await this.createAgent({
      cwd,
      sessionPath: path,
      ...(conversation?.title ? { name: conversation.title } : {})
    })
  }

  /**
   * 在某个目录里新建会话 —— 一个会话就是一个 agent（D53）。
   *
   * name 是新建对话框里定的名字：写进 Pi 的会话文件（`session_info` 条目），
   * 也当 agent 名。名字在会话文件还没建的时候只存在内存里，
   * 等第一条消息落盘时一并写出去 —— Pi 就是这么设计的，不用额外处理。
   */
  async newConversation(cwd: string, name?: string, type?: string): Promise<void> {
    const trimmed = name?.trim() ?? ''
    const agent = await this.createAgent({
      cwd,
      ...(type ? { type } : {}),
      ...(trimmed ? { name: trimmed } : {})
    })
    if (!trimmed) return
    await this.pi.setSessionName(agent.id, trimmed)
    // 新建时写的 `session_info` 条目也算我们自己的写入
    this.markWritten(agent.id)
    this.readSession()
    this.push()
  }

  /** 新建一个 agent（默认基础） */
  async newAgent(cwd: string, type = 'general', name?: string): Promise<AgentRecord> {
    return this.createAgent({ cwd, type, ...(name ? { name } : {}) })
  }

  /** 以此 agent 新建实例：配置照搬，会话是新的 */
  async newAgentFrom(agentId: string): Promise<AgentRecord> {
    const source = this.agentById(agentId)
    if (!source) throw new Error(`agent 不存在：${agentId}`)
    return this.createAgent({ cwd: source.cwd, from: source })
  }

  /**
   * 激活一个 agent：切到它的项目标签 → 记成活动 agent → 建 runtime。
   *
   * **不动 lastActiveAt** —— 那会让头像每点一次就跳到最前面，
   * 排序应该跟着「真正干了活」走（见 `prompt()`）。
   */
  async activateAgent(agentId: string): Promise<void> {
    const agent = this.agentById(agentId)
    if (!agent) throw new Error(`agent 不存在：${agentId}`)
    const tab = this.ensureProjectTab(agent.cwd)
    tab.activeAgentId = agentId
    tab.pane = 'agent'
    this.activeTabId = tab.id
    // 没登记过就先登记 —— 启动只登记未归档的，归档后恢复、或者中途新建的都走这条
    if (!this.pi.hasAgent(agentId)) await this.registerAgent(agent)
    await this.pi.activateAgent(agentId)
    // 懒加载的 agent 这时候才真的有会话 —— 把文件路径补上
    if (!agent.sessionPath) {
      const path = this.pi.agentState(agentId).sessionFile
      if (path) this.agentStore.update(agentId, { sessionPath: path })
    }
    this.persistTabs()
    this.readSession()
    this.push()
  }

  /**
   * 给 agent 改名 —— **只改 agents.json 里的名字**，不碰会话文件。
   *
   * agent 名是窄轨里的本地名字；会话名在会话文件的 `session_info` 里，由 `/rename`
   * 或裸 pi 改。两个名字分开维护（D53 的补充），理由：
   * - 它们是两个所有者不同的东西：一个属于应用，一个属于 Pi 会话文件；
   * - 改会话文件会动 mtime，而 mtime 是「在别处被改过」的判据 —— 改完名字输入框反而被禁用。
   *
   * 所以这里没有「文件在不在」的分支，也不需要往 Pi 的内存会话里塞名字。
   */
  async renameAgent(agentId: string, name: string): Promise<void> {
    const agent = this.agentById(agentId)
    if (!agent) throw new Error(`agent 不存在：${agentId}`)
    const trimmed = name.trim()
    if (!trimmed) throw new Error('名字不能为空')
    this.agentStore.update(agentId, { name: trimmed })
    this.push()
  }

  /**
   * 归档：**只改状态**，会话文件原地不动。正在跑的不许归档（D53）。
   *
   * 归档完把项目标签指向同目录的下一个 agent；一条都不剩就退回「代码」入口。
   */
  async archiveAgent(agentId: string): Promise<void> {
    const agent = this.agentById(agentId)
    if (!agent) return
    if (this.pi.agentState(agentId).streaming) throw new Error('这个 agent 正在跑，先停下来再归档')
    await this.doArchive(agent, this.neighborAgentFor(agent.cwd, agentId))
  }

  /** 归档的落地部分 —— 调用方已经确认过「没在跑」，也把邻居算好了 */
  private async doArchive(agent: AgentRecord, successor: string | null): Promise<void> {
    const agentId = agent.id
    await this.pi.closeAgent(agentId)
    this.agentStore.update(agentId, { archivedAt: Date.now() })
    this.live.delete(agentId)
    const tab = this.tabOfAgent(agentId)
    if (tab) {
      tab.activeAgentId = successor
      this.fallbackWhenNoAgent(tab)
      this.persistTabs()
      // 活动标签换了人 —— 懒加载的这时才建 runtime，否则切过去是一块空白
      if (successor && tab.id === this.activeTabId) await this.pi.activateAgent(successor)
    }
    this.readSession()
    this.push()
  }

  /** 从归档里恢复：挂回窄轨，并激活它 */
  async restoreAgent(agentId: string): Promise<void> {
    const agent = this.agentById(agentId)
    if (!agent) return
    this.agentStore.update(agentId, { ...restoreRecord(agent), lastActiveAt: Date.now() })
    await this.activateAgent(agentId)
  }

  /** 删除一个 agent：会话文件移入系统废纸篓（底线 2），runtime 先关 */
  async deleteAgent(agentId: string): Promise<void> {
    const agent = this.agentById(agentId)
    if (!agent) return
    await this.pi.closeAgent(agentId)
    if (agent.sessionPath && existsSync(agent.sessionPath)) {
      await moveSessionFilesToTrash([agent.sessionPath], this.trashFile)
    }
    const successor = this.neighborAgentFor(agent.cwd, agentId)
    this.agentStore.remove(agentId)
    this.live.delete(agentId)
    const tab = this.tabOfAgent(agentId)
    if (tab) {
      tab.activeAgentId = successor
      this.fallbackWhenNoAgent(tab)
      this.persistTabs()
    }
    await this.refreshConversations()
    this.readSession()
    this.push()
  }

  /**
   * 自动归档（D55）：把超过天数没活动的**通用** agent 归档。
   *
   * 天数由调用方给（应用级设置），这里只做判定和落地。
   * 正在跑的跳过 —— 它显然还有活动。
   */
  async runAutoArchive(days: number): Promise<number> {
    const due = dueForArchive(this.agentStore.list(), Date.now(), days)
    let archived = 0
    for (const agent of due) {
      if (this.pi.agentState(agent.id).streaming) continue
      await this.archiveAgent(agent.id)
      archived += 1
    }
    return archived
  }

  /** 切到某个项目标签 */
  async activateProjectTab(tabId: string): Promise<void> {
    const tab = this.tabById(tabId)
    if (!tab) throw new Error(`标签不存在：${tabId}`)
    this.activeTabId = tabId
    if (tab.activeAgentId) await this.pi.activateAgent(tab.activeAgentId)
    this.readSession()
    this.push()
  }

  /** 切某个项目标签的左列（看对话 / 项目设置） */
  async setPane(tabId: string, pane: ProjectPaneView): Promise<void> {
    const tab = this.tabById(tabId)
    if (!tab) return
    tab.pane = pane
    this.persistTabs()
    if (pane === 'agent' && tab.activeAgentId) await this.pi.activateAgent(tab.activeAgentId)
    this.readSession()
    this.push()
  }

  /**
   * 改某个项目标签的右栏状态。
   *
   * **不碰任何 agent**：不激活、不中止正在跑的一轮 —— 展开右栏不该打断工作。
   */
  async setRightPanel(tabId: string, panel: RightPanelState): Promise<void> {
    const tab = this.tabById(tabId)
    if (!tab) return
    tab.rightPanel = { open: panel.open, kind: panel.kind }
    this.persistTabs()
    this.push()
  }

  /** 关一条项目标签：只收起页面，**不碰任何 agent**（R44） */
  async closeProjectTab(tabId: string): Promise<void> {
    const index = this.tabs.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const wasActive = this.activeTabId === tabId
    this.tabs.splice(index, 1)
    if (wasActive) {
      const next = this.tabs[Math.min(index, this.tabs.length - 1)]
      this.activeTabId = next ? next.id : null
    }
    this.persistTabs()
    const tab = this.activeTab()
    if (tab?.activeAgentId) await this.pi.activateAgent(tab.activeAgentId)
    this.readSession()
    this.push()
  }

  /**
   * 删除一批会话（PLAN.md D23）。
   *
   * 顺序是硬约束：
   * 1. 先确认路径都在当前会话列表里 —— 会话文件在 `~/.pi/agent/sessions/` 下，
   *    不在项目目录里，白名单是唯一可靠的校验。
   * 2. 摘掉引用它们的文件标签。
   * 3. 关掉管着这些会话的 agent 的 runtime（`closeAgent` 内部先 abort 等结算，再 dispose）。
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

      const agents = this.agentStore
        .list()
        .filter((agent) => agent.sessionPath && targetSet.has(normalize(agent.sessionPath)))
      const removedIds = new Set(agents.map((agent) => agent.id))

      // 先算好「每个标签的活动 agent 被删之后由谁接」——必须在这批 agent 还在的时候算
      const successors = new Map<string, string | null>()
      for (const tab of this.tabs) {
        if (tab.activeAgentId && removedIds.has(tab.activeAgentId)) {
          successors.set(tab.id, this.successorAfterRemoval(tab.cwd, removedIds, tab.activeAgentId))
        }
      }

      // 先关 runtime 再动文件 —— runtime 里还拿着这个会话文件路径
      for (const agent of agents) await this.pi.closeAgent(agent.id)
      for (const agent of agents) {
        this.agentStore.remove(agent.id)
        this.live.delete(agent.id)
      }

      let tabsChanged = false
      for (const tab of this.tabs) {
        if (!successors.has(tab.id)) continue
        tab.activeAgentId = successors.get(tab.id) ?? null
        this.fallbackWhenNoAgent(tab)
        tabsChanged = true
      }
      if (tabsChanged) this.persistTabs()

      const outcome = await moveSessionFilesToTrash(targets, this.trashFile)
      await this.refreshConversations()
      this.readSession()
      this.push()
      return outcome
    } finally {
      this.deleting = false
    }
  }

  /** 把当前的项目标签落盘（顺序即标签栏的顺序） */
  private persistTabs(): void {
    this.tabStore.saveTabs(this.tabs)
  }

  // ---------------------------------------------------------------------
  // 对话列表（全部项目）
  // ---------------------------------------------------------------------

  /**
   * 重读对话列表（磁盘上的会话文件是权威）。
   *
   * 现在列的是**全部项目**的会话（`SessionManager.listAll()`）。
   * 它要读并解析每一个 jsonl —— 实测 38 个会话 212ms，随会话数线性增长。
   * 所以用 `onProgress` 分段出结果：先给一部分，别让界面干等。
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
      // agent 的名字要跟着变，不然窄轨上一直写着「通用 1」
      /*
       * 只更新轮数 —— **agent 名不跟着会话标题走**（两个名字分开维护）。
       *
       * 以前这里是「没起过名的 agent 跟着会话标题变」，结果是同一个会话有两个名字
       * 互相打架：应用里改的叫 agent 名，终端里改的叫会话名，谁赢取决于同步规则。
       * 现在 agent 名只由「新建时的默认名 / 你手动改名」决定，会话标题只用来显示。
       */
      for (const agent of this.agentStore.list()) {
        if (!agent.sessionPath) continue
        const conversation = list.find((c) => c.path === agent.sessionPath)
        if (!conversation) continue
        if (conversation.messageCount === agent.turns) continue
        this.agentStore.update(agent.id, { turns: conversation.messageCount })
      }
      // 顺便看看有没有 agent 的会话文件在别处被改过
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
    for (const agent of this.agentStore.list()) {
      if (!agent.sessionPath) continue
      /*
       * 这个 agent 正在跑 —— 文件是我们自己在写，不算「别处改过」。
       *
       * 不跳过会误报：用户消息落盘之后 mtime 就变了，而 `markWritten` 要等
       * `agent_settled` 才更新 seenMtime。这一整轮里 agent 都会被标成 stale，
       * 输入框跟着被禁用 —— AI 回复期间用户就打不了字了。
       */
      if (this.pi.agentState(agent.id).streaming) continue
      const live = this.liveOf(agent.id)
      const stale = mtimeOf(agent.sessionPath) > live.seenMtime
      if (stale !== live.stale) {
        live.stale = stale
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
  private markWritten(agentId: string): void {
    const agent = this.agentStore.get(agentId)
    if (!agent?.sessionPath) return
    const live = this.liveOf(agentId)
    const wasStale = live.stale
    live.seenMtime = mtimeOf(agent.sessionPath)
    live.stale = false
    // 刚才如果已经被标成「别处改过」，现在要把它收回 —— 只改状态不推，界面会一直挂着
    if (wasStale) this.push()
  }

  /**
   * 重新加载某个标签：重建 runtime，从磁盘重新读会话。
   *
   * 用于「这个会话在别处被改过」（stale）之后。
   */
  async reloadTab(agentId: string): Promise<void> {
    const agent = this.agentStore.get(agentId)
    if (!agent) return
    if (!this.pi.hasAgent(agentId)) await this.registerAgent(agent)
    // 重建时按当前项目设置刷新提示片段 —— 这样 /reload 就能吃到改过的原型目录
    await this.trackRefresh(() =>
      this.pi.reloadAgent(agentId, { appendSystemPrompt: this.promptFragmentsFor(agent) })
    )
    // 重建后路径可能变了（原来是「没说过话的空 agent」的话）
    const state = this.pi.agentState(agentId)
    if (state.sessionFile) this.agentStore.update(agentId, { sessionPath: state.sessionFile })
    const live = this.liveOf(agentId)
    live.seenMtime = mtimeOf(state.sessionFile ?? agent.sessionPath)
    live.stale = false
    this.readSession()
    this.push()
  }

  // ---------------------------------------------------------------------
  // 文件（PLAN.md D20 / D22）
  // ---------------------------------------------------------------------

  /**
   * 列一个目录下的条目。
   *
   * **越界的符号链接不当异常处理**：`node_modules` 里 link 依赖指向项目外很常见
   * （Pi 自己的 install 目录就是这样）。主进程拒绝读它，是守住「渲染进程不能点名
   * 读项目外的路径」这条；但界面要能说清为什么没展开。
   */
  async listFiles(cwd: string, dir: string): Promise<FileListResult> {
    try {
      return { entries: await listDirectory(cwd, dir), error: null }
    } catch (caught) {
      if (caught instanceof PathOutsideCwdError) {
        return { entries: [], error: '这个目录指向项目外（符号链接），没有展开' }
      }
      return {
        entries: [],
        error: caught instanceof Error ? caught.message : String(caught)
      }
    }
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
      return
    }
    const agent = this.activeAgent()
    const state = this.pi.agentState(agent?.id ?? '')
    this.session = {
      ready: state.ready,
      cwd: agent?.cwd ?? this.activeTab()?.cwd ?? null,
      sessionId: state.sessionId,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      modelFallback: state.modelFallback,
      error: agent ? this.liveOf(agent.id).error : null
    }
  }

  // ---------------------------------------------------------------------
  // 会话
  // ---------------------------------------------------------------------

  /** 某个标签已经说过的话（R1 R5） */
  readEntries(tabId: string): StreamItem[] {
    return this.pi.readEntries(tabId)
  }

  /** 某个 agent 的整棵会话树（条目级） */
  readTree(agentId: string): FlatSessionTree {
    return this.pi.readTree(agentId)
  }

  /** 切支线 / 截断：把当前叶移到某个条目 */
  async navigateTree(
    agentId: string,
    targetId: string,
    options?: { summarize?: boolean }
  ): Promise<TreeNavigateResult> {
    return this.pi.navigateTree(agentId, targetId, options)
  }

  /** 另开一个会话：把一条路径复制成新会话文件，返回路径 */
  async forkTree(agentId: string, targetId: string): Promise<string> {
    return this.pi.forkTree(agentId, targetId)
  }

  /**
   * 加标签（书签）；空串等于清掉。
   *
   * 标签是**我们自己**往会话文件里追加的条目，写完要把「已看到」的时间推到当下 ——
   * 不推的话，下一次对话列表刷新会把这条标签当成「在别处改过」，
   * 输入框突然被禁用、冒出一条「重新加载」。
   */
  async labelTree(agentId: string, targetId: string, label: string): Promise<void> {
    await this.pi.labelTree(agentId, targetId, label)
    this.markWritten(agentId)
  }

  /** 已配置凭据的模型清单（选择器用） */
  /**
   * 某个目录的 Git 状态；只读。
   *
   * 按 **cwd** 取而不是按 agent —— Git 是项目级的东西，同一个目录里的 agent 看的是
   * 同一个仓库。以前按标签取，改造后标签和 agent 不是一回事了，再按 id 查会查不到。
   */
  async getGitStatus(cwd: string): Promise<GitStatus> {
    if (!cwd) return emptyGitStatus('没有活动项目')
    return readGitStatus(cwd)
  }

  /** 单个文件的 Git diff；路径必须由 Git 面板传来 */
  async getGitDiff(cwd: string, path: string, scope: GitDiffScope): Promise<GitDiff> {
    if (!cwd) {
      return {
        path,
        scope,
        patch: '',
        binary: false,
        truncated: false,
        error: '没有活动项目'
      }
    }
    return readGitDiff(cwd, path, scope)
  }

  /** 某个标签可用模型清单 */
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
    // 思考等级写进会话文件（`thinking_level_change` 条目）—— 自己写的不算外部更新
    this.markWritten(tabId)
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

  /** 打开或恢复临时对话；已有会话时不新建 */
  async openTemporaryChat(): Promise<HostSnapshot> {
    if (this.temporaryChat) return this.snapshot()

    const active = this.activeAgent()
    if (!active) throw new Error('先打开一个项目再使用临时对话')
    const activeModel = this.pi.agentState(active.id).model
    const id = `temp-${++this.temporarySeq}`

    await this.pi.openAgent(id, { cwd: active.cwd, inMemory: true })
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
    await this.pi.closeAgent(temp.id)
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
    await this.pi.abortAgent(id)
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
    const state = this.pi.agentState(this.temporaryChat.id)
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

  /** 压缩某个 agent 的上下文 */
  /**
   * 压缩某个 agent 的上下文。
   *
   * 压缩会往会话文件里追加压缩条目 —— 跟标签一样是自己写的，
   * 写完把「已看到」推到当下，否则压缩完界面会冒出「在别处有更新」。
   */
  async compactAgent(agentId: string): Promise<void> {
    await this.pi.compactAgent(agentId)
    this.markWritten(agentId)
  }

  /** 切某个标签的模型 */
  async selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void> {
    await this.pi.selectModel(tabId, provider, id, persist)
    /*
     * 换模型也会往会话文件里追加 `model_change` 条目。不推 seenMtime 的话，
     * 之后任意一次对话列表刷新都会把这次换模型当成「在别处改过」，
     * 输入框被禁用、挂着一条「重新加载」—— 而这个状态会一直挂到下一轮结束。
     */
    this.markWritten(tabId)
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
    /*
     * 改名也是我们自己往会话文件里写东西 —— 把「已看到」推到当下。
     * 不推的话，紧接着的刷新会把这次改名当成「在别处改过」，
     * 输入框会突然被禁用，还冒出一条重新加载的提示。
     */
    for (const agent of this.agentStore.list()) {
      if (agent.sessionPath && normalize(agent.sessionPath) === target) this.markWritten(agent.id)
    }
    /*
     * **不顺手改 agent 名**（两个名字分开维护）。
     *
     * 这里改的是会话名 —— 写进会话文件、裸 pi 也看得到。agent 名是窄轨里的本地名字，
     * 由「重命名 agent」改。混在一起改的后果是：改一次会话名就动了会话文件的 mtime，
     * 而 mtime 是「在别处被改过」的判据 —— 改完名字输入框反而被禁用了。
     */
    // 不等去抖：改名要立刻反映到会话清单的标题上
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
    agentId: string,
    text: string,
    attachments?: string[],
    uploadIds?: string[]
  ): Promise<void> {
    const agent = this.agentById(agentId)
    if (!agent) throw new Error(`agent 不存在：${agentId}`)

    const external = this.resolveUploads(uploadIds)

    if ((!attachments || attachments.length === 0) && external.length === 0) {
      await this.pi.prompt(agentId, text)
      this.noteActivity(agentId)
      return
    }

    const prepared = await prepareAttachments(agent.cwd, attachments ?? [], external)
    const merged = prepared.text ? `${text}\n\n${prepared.text}` : text
    await this.pi.prompt(agentId, merged, prepared.images)
    this.noteActivity(agentId)

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
      await this.pi.abortAgent(tabId)
    } finally {
      this.aborting.delete(tabId)
      this.emit('snapshot', this.snapshot())
    }
  }

  /**
   * 记一条扩展错误。同一个错误（同标签、同类型、同路径、同事件、同正文）只保留一条，
   * 重复发生时把它挪到末尾；最多留 20 条，避免刷屏。
   */
  private recordExtensionError(agentId: string, error: Omit<ExtensionErrorInfo, 'agentId'>): void {
    const entry: ExtensionErrorInfo = { ...error, agentId }
    const keyOf = (item: ExtensionErrorInfo): string =>
      `${item.agentId}|${item.kind}|${item.path}|${item.event ?? ''}|${item.message}`
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
