import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createEventBus,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type EventBus,
  type ToolInfo
} from '@earendil-works/pi-coding-agent'
import { existsSync, readdirSync } from 'node:fs'
import { join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  CommandArgumentOption,
  CommandOption,
  ConversationInfo,
  ExtensionErrorInfo,
  ModelOption,
  StreamItem,
  ThinkingLevel
} from '@contract/index'
import type { PromptImage } from '../attachments'
import { entriesToItems } from '@contract/stream'
import { thumbnailStreamImage } from '../imageResize'

/** 一条会话流事件 —— 带它属于哪个标签 */
export interface PiEvent {
  type: string
  data: unknown
  /** 事件属于哪个标签 */
  tabId: string
}

export type PiEventListener = (event: PiEvent) => void

/** 某个标签的运行时状态 */
export interface TabRuntimeState {
  /** runtime 建好了没 */
  ready: boolean
  /** 当前会话的 id */
  sessionId: string | null
  /**
   * 会话文件路径。
   *
   * Pi 在创建会话时就算出来了，**但文件要等第一条用户消息才真的建** ——
   * 所以非 null 不代表磁盘上有这个文件。标签靠它落盘，重启时按它找回会话。
   */
  sessionFile: string | null
  /** agent 是不是正在跑 */
  streaming: boolean
  /** 这个标签用的模型 */
  model: ModelOption | null
  /** 当前思考等级 */
  thinkingLevel: ThinkingLevel | null
  /** 恢复会话时没能恢复原模型的原因 */
  modelFallback: string | null
}

/**
 * 宿主状态用到的运行时能力（PLAN.md D7 / D4 修订）。
 *
 * 单独拎出来是为了让宿主状态能拿假实现跑测试 ——
 * 真实运行时要模型、要凭据，测不动。
 *
 * **一个标签一个 runtime**（D4 修订）：`createAgentSessionRuntime()` 可以调用多次，
 * 每次产出互相独立的 runtime。切标签不调 `switchSession` ——
 * 那条路径会先 `teardownCurrent()`，里面 `await this.session.abort()` 把正在跑的那轮结算掉。
 */
export interface PiRuntimePort {
  /** 订阅会话流事件（事件带 tabId），返回退订函数 */
  onEvent(listener: PiEventListener): () => void
  /**
   * 登记一个标签。
   *
   * lazy = true 时先不建 runtime（恢复出来的标签用），点了再 `activateTab`。
   * 给了 path 但文件不在 → 抛 `TabSessionMissingError`。
   */
  openTab(
    tabId: string,
    options: { cwd: string; path?: string; lazy?: boolean; inMemory?: boolean }
  ): Promise<void>
  /** 关掉一个标签：先 abort 等那一轮结算，再 dispose */
  closeTab(tabId: string): Promise<void>
  /** 激活一个标签：runtime 还没建就建 */
  activateTab(tabId: string): Promise<void>
  /** 重建某个标签的 runtime —— 从磁盘重新读会话 */
  reloadTab(tabId: string): Promise<void>
  /** 某个标签的运行时状态 */
  tabState(tabId: string): TabRuntimeState
  /** 某个标签的会话条目 */
  readEntries(tabId: string): StreamItem[]
  /** 接上浏览器工具桥 */
  setBrowserToolHandler?(handler: (tabId: string, request: unknown) => Promise<unknown>): void
  /** 某个标签的可用模型清单 */
  listModels(tabId: string): Promise<ModelOption[]>
  /** 切某个标签的模型（persist 时同时设为新会话默认） */
  selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void>
  /**
   * 给某个会话改名。
   *
   * 有活着的 runtime 就走它（`setSessionName` 会同时更新内存、写文件、发事件）；
   * 没有就打开会话文件追加一条 `session_info`。
   */
  renameSession(path: string, name: string): Promise<void>
  /** 给某个标签的会话起名（新建时用 —— 那时还没有会话文件路径） */
  setSessionName(tabId: string, name: string): Promise<void>
  /** 列某个标签可用的 `/` 命令（Pi 模板、扩展、技能） */
  listCommands(tabId: string): Promise<CommandOption[]>
  /** 列某个扩展命令的参数候选 */
  completeCommand(tabId: string, name: string, prefix: string): Promise<CommandArgumentOption[]>
  /** 当前模型支持的思考等级 */
  thinkingLevels(tabId: string): ThinkingLevel[]
  /** 设置思考等级（只影响当前会话） */
  setThinkingLevel(tabId: string, level: ThinkingLevel): void
  /** 压缩某个标签的上下文 */
  compactTab(tabId: string): Promise<void>
  /** 往某个标签发一条用户消息；expandPromptTemplates=false 时把 / 当普通文字 */
  prompt(
    tabId: string,
    text: string,
    images?: PromptImage[],
    options?: { expandPromptTemplates?: boolean }
  ): Promise<void>
  /**
   * 中止某个标签正在跑的那一轮（用户主动停，标签留着）。
   *
   * 返回时已经停稳；没在跑就直接返回。
   */
  abortTab(tabId: string): Promise<void>
  /** 收摊 */
  stop(): Promise<void>
}

/** 会话文件不在了（被删了，或者从没落盘过） */
export class TabSessionMissingError extends Error {
  constructor(readonly path: string) {
    super(`会话文件不存在：${path}`)
    this.name = 'TabSessionMissingError'
  }
}

/** 编译后的项目内扩展目录：out/main/index.mjs → out/ext */
function defaultExtensionsDir(): string | null {
  try {
    const dir = fileURLToPath(new URL('../ext', import.meta.url))
    return existsSync(dir) ? dir : null
  } catch {
    return null
  }
}

/**
 * 列出扩展目录里的入口文件。
 *
 * Pi 的 `additionalExtensionPaths` 对目录的处理是「当成一个包」：要么有 package.json
 * 的 pi.extensions，要么目录里有 index（Node 解析），不会把顶层每个 js 都当扩展。
 * 所以这里自己枚举顶层 `.js`，逐个传文件路径；子目录留给辅助代码，不作为入口。
 */
function listExtensionFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.js') && !name.startsWith('.'))
      .sort()
      .map((name) => join(dir, name))
  } catch {
    return []
  }
}

/**
 * 找出「本项目扩展已注册、但没被激活」的工具。
 *
 * 只认 `sourceInfo.path` 落在扩展目录里的工具，别把 tool_search、codemode
 * 之类自己收起来的工具一起拉回来；不可声明的（codemode/deferred/hidden）也不碰。
 */
export function missingExtensionTools(
  tools: readonly ToolInfo[],
  active: readonly string[],
  extensionsDir: string
): string[] {
  const activeNames = new Set(active)
  const prefix = extensionsDir.endsWith(sep) ? extensionsDir : `${extensionsDir}${sep}`
  return tools
    .filter((tool) => !activeNames.has(tool.name))
    .filter((tool) => tool.sourceInfo.path.startsWith(prefix))
    .filter((tool) => tool.exposure === 'direct' || tool.exposure === 'model-only')
    .map((tool) => tool.name)
}

/** 一个标签背后的一套运行时 */
interface TabRecord {
  tabId: string
  cwd: string
  /** 会话文件路径（新会话在第一条用户消息之前还没有文件） */
  path: string | null
  /** 临时对话：用内存 SessionManager，不落盘 */
  inMemory: boolean
  /** 这个标签自己的 EventBus —— 共享一个会串台 */
  bus: EventBus
  runtime: AgentSessionRuntime | null
  unbind: (() => void) | null
  /** 内置 context-diff 扩展通过 EventBus 发来的快照 */
  contextDiffUnsub: (() => void) | null
  /** 内置 debug-console 扩展通过 EventBus 发来的请求记录 */
  consoleUnsub: (() => void) | null
  /** 浏览器工具请求的 EventBus 监听 */
  browserUnsub: (() => void) | null
  sessionManager: SessionManager | null
}

/**
 * Pi 运行时的宿主封装。
 *
 * 只做三件事：把 runtime 起在某个目录上、把会话流事件转出去、把会话列表读出来。
 * Pi 自己的 API 一律不外泄到渲染进程（D5 / 边界 1）。
 */
export class PiRuntime implements PiRuntimePort {
  private tabs = new Map<string, TabRecord>()
  private listeners = new Set<PiEventListener>()
  /** 已经打过日志的扩展加载错误 —— 每个标签都会建 runtime，别重复刷屏 */
  private readonly reportedExtensionErrors = new Set<string>()
  private browserToolHandler: ((tabId: string, request: unknown) => Promise<unknown>) | null = null

  constructor(private readonly extensionsDir: string | null = defaultExtensionsDir()) {}

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** HostState 把浏览器工具接到当前运行时 */
  setBrowserToolHandler(handler: (tabId: string, request: unknown) => Promise<unknown>): void {
    this.browserToolHandler = handler
  }

  private emit(event: PiEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个订阅者出错不能拖垮整条流
      }
    }
  }

  /** 把扩展错误作为一条宿主事件送出去；HostState 会把它收进快照 */
  private emitExtensionError(tabId: string, error: Omit<ExtensionErrorInfo, 'tabId'>): void {
    this.emit({ type: 'extension_error', data: error, tabId })
  }

  private record(tabId: string): TabRecord {
    const found = this.tabs.get(tabId)
    if (!found) throw new Error(`标签不存在：${tabId}`)
    return found
  }

  /**
   * 登记一个标签。
   *
   * lazy = true 时**不建 runtime** —— 恢复出来的标签用它：
   * 标签栏立刻能显示，runtime 等用户点它的时候再建（起一个约 15–25ms）。
   */
  async openTab(
    tabId: string,
    options: { cwd: string; path?: string; lazy?: boolean; inMemory?: boolean }
  ): Promise<void> {
    const path = options.path ?? null
    // 文件不在就别登记了 —— 恢复时靠这个把没落盘的标签挑出去
    if (path && !existsSync(path)) throw new TabSessionMissingError(path)

    const record: TabRecord = {
      tabId,
      cwd: options.cwd,
      path,
      inMemory: options.inMemory === true,
      bus: createEventBus(),
      runtime: null,
      unbind: null,
      contextDiffUnsub: null,
      consoleUnsub: null,
      browserUnsub: null,
      sessionManager: null
    }
    record.contextDiffUnsub = record.bus.on('context-diff:snapshot', (data) => {
      this.emit({ type: 'context_diff_snapshot', data, tabId })
    })
    record.consoleUnsub = record.bus.on('debug-console:record', (data) => {
      // 正文很大 —— 只在主进程里转给存储，不往渲染进程送
      this.emit({ type: 'debug_console_record', data, tabId })
    })
    record.browserUnsub = record.bus.on('browser:request', (data) => {
      const request = data as { id?: unknown }
      const id = typeof request.id === 'string' ? request.id : ''
      const respond = (payload: unknown): void => {
        record.bus.emit('browser:response', payload)
      }
      if (!this.browserToolHandler) {
        respond({ id, ok: false, error: '浏览器工具不可用' })
        return
      }
      void this.browserToolHandler(tabId, request).then(
        (result) => respond({ id, ok: true, result }),
        (error) => respond({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
      )
    })
    this.tabs.set(tabId, record)
    if (options.lazy) return
    await this.buildRuntime(record)
  }

  /**
   * 给这个标签建 runtime。
   *
   * 每个标签一套 services、一套 EventBus、一套扩展上下文。
   */
  private async buildRuntime(record: TabRecord): Promise<void> {
    const agentDir = getAgentDir()

    // 工厂由这个标签持有，换会话时会被再次调用，所以事件订阅在这里重绑
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
      // 这个标签自己的 EventBus。共享一个的话，N 个标签的扩展实例都注册在
      // 同一个 emitter 上，一个标签发消息其他标签也收得到（D4 修订）。
      const resourceLoaderOptions: {
        eventBus: EventBus
        additionalExtensionPaths?: string[]
      } = { eventBus: record.bus }
      // 项目内扩展（ext/ 编译到 out/ext）。逐个传文件，不传目录 —— 目录会被 Pi 当成一个包。
      const extensionPaths = this.extensionsDir ? listExtensionFiles(this.extensionsDir) : []
      if (extensionPaths.length > 0) {
        resourceLoaderOptions.additionalExtensionPaths = extensionPaths
      }
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        resourceLoaderOptions
      })
      // 加载失败：日志留一条，同时作为宿主事件送到界面；同一个错误只报一次
      for (const error of services.resourceLoader.getExtensions().errors) {
        const key = `load|${error.path}\u0000${error.error}`
        if (this.reportedExtensionErrors.has(key)) continue
        this.reportedExtensionErrors.add(key)
        console.error(`扩展加载失败（${error.path}）：${error.error}`)
        this.emitExtensionError(record.tabId, {
          kind: 'load',
          path: error.path,
          message: error.error,
          at: Date.now()
        })
      }
      const { session, extensionsResult, modelFallbackMessage } = await createAgentSessionFromServices({
        services,
        sessionManager
      })
      record.unbind = this.bind(record.tabId, session)

      /*
       * 绑定扩展的命令上下文和错误监听。
       *
       * 不调 bindExtensions 的话：扩展的 session_start 不触发、ctx.waitForIdle 是空操作、
       * ctx.reload 不生效、handler 的错误也没有出口。模式（TUI/RPC/print）都调这一步。
       */
      try {
        await session.bindExtensions({
          // Codelet 没有扩展 UI；print 模式让 hasUI 为 false
          mode: 'print',
          commandContextActions: {
            waitForIdle: () => session.waitForIdle(),
            // 换会话目前走标签/运行时，不由扩展命令发起
            newSession: async () => ({ cancelled: true }),
            fork: async () => ({ cancelled: true }),
            navigateTree: async () => ({ cancelled: true }),
            switchSession: async () => ({ cancelled: true }),
            reload: async () => {
              await session.reload()
            }
          },
          onError: (error) => {
            this.emitExtensionError(record.tabId, {
              kind: 'runtime',
              path: error.extensionPath,
              event: error.event,
              message: error.error,
              at: Date.now()
            })
          }
        })
      } catch (error) {
        this.emitExtensionError(record.tabId, {
          kind: 'runtime',
          path: '<session_start>',
          event: 'session_start',
          message: error instanceof Error ? error.message : String(error),
          at: Date.now()
        })
      }

      // 扩展加载完了才补 —— 名字不在 registry 里的话 setActiveToolsByName 会直接忽略
      this.reactivateExtensionTools(session)

      return { session, extensionsResult, modelFallbackMessage, services, diagnostics: services.diagnostics }
    }

    const sessionManager = record.inMemory
      ? SessionManager.inMemory(record.cwd)
      : record.path
        ? SessionManager.open(record.path, undefined, record.cwd)
        : SessionManager.create(record.cwd)
    record.sessionManager = sessionManager
    record.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: record.cwd,
      agentDir,
      sessionManager
    })
  }

  /**
   * 把掉队的扩展工具补回 active 集合。
   *
   * `out/ext` 是易变目录：构建期间或编译失败时重建 runtime 会读不到扩展，
   * Pi 在下一轮请求前把差集写成 `toolsRemoved` 落进会话文件；而
   * `_restoreToolsFromTranscript()` 只把「从未被提过」的扩展工具当新工具激活，
   * 于是这些工具在这个分支上就永久不可用了。
   *
   * `setActiveToolsByName()` 只改内存，下一轮请求前 `declareToolChanges()` 会
   * 写出 `toolsAdded`，会话因此自愈 —— 不用改写会话文件，也不用重开标签。
   */
  private reactivateExtensionTools(session: AgentSession): void {
    if (!this.extensionsDir) return
    const missing = missingExtensionTools(
      session.getAllTools(),
      session.getActiveToolNames(),
      this.extensionsDir
    )
    if (missing.length === 0) return
    // 传并集：这是「设置」不是「添加」，只传差集会把内置工具踢掉
    session.setActiveToolsByName([...session.getActiveToolNames(), ...missing])
  }

  private bind(tabId: string, session: AgentSession): () => void {
    return session.subscribe((event) => {
      const { type, ...rest } = event as unknown as { type: string } & Record<string, unknown>
      this.emit(this.withImageThumbnails({ type, data: rest, tabId }))
    })
  }

  /** 把实时用户消息里的原图换成缩略图；原图只留在 Pi 的模型请求里 */
  private withImageThumbnails(event: PiEvent): PiEvent {
    if (event.type !== 'message_start' && event.type !== 'message_end') return event
    const data = event.data as { message?: { content?: unknown } }
    const content = data.message?.content
    if (!Array.isArray(content)) return event

    let changed = false
    const next = content.map((block) => {
      if (!block || typeof block !== 'object') return block
      const image = block as { type?: string; data?: string; mimeType?: string }
      if (image.type !== 'image' || typeof image.data !== 'string') return block
      const thumb = thumbnailStreamImage({
        data: image.data,
        mimeType: image.mimeType ?? 'image/png'
      })
      if (!thumb) return block
      changed = true
      return { ...block, data: thumb.data, mimeType: thumb.mimeType }
    })

    if (!changed) return event
    return {
      ...event,
      data: { ...data, message: { ...data.message, content: next } }
    }
  }

  /** 激活一个标签：runtime 还没建就建（懒加载） */
  async activateTab(tabId: string): Promise<void> {
    const record = this.record(tabId)
    if (record.runtime) return
    await this.buildRuntime(record)
  }

  /**
   * 重建某个标签的 runtime，从磁盘重新读会话。
   *
   * 用于「这个会话文件在别处被改过」之后。**不自动调用** ——
   * 重建会丢掉当前 runtime 的状态，而且如果别处还在写，重建完很快又会落后。
   *
   * 正在跑的话先 abort 等结算（跟关标签同一个道理：别丢半截轮次）。
   */
  async reloadTab(tabId: string): Promise<void> {
    const record = this.record(tabId)
    const runtime = record.runtime
    if (runtime) {
      record.unbind?.()
      record.unbind = null
      record.runtime = null
      const session = runtime.session
      if (session.isStreaming) await session.abort()
      await runtime.dispose()
    }
    await this.buildRuntime(record)
  }

  /**
   * 关掉一个标签。
   *
   * 先 `abort()` 等正在跑的那一轮结算掉，再 `dispose()` ——
   * `AgentSessionRuntime.dispose()` **不 await** 那一轮（它只调同步的
   * `AgentSession.dispose()`，里面的 `agent.abort()` 是 fire-and-forget），
   * 照它直接关，半截轮次可能没落盘。
   */
  async closeTab(tabId: string): Promise<void> {
    const record = this.tabs.get(tabId)
    if (!record) return
    this.tabs.delete(tabId)
    record.unbind?.()
    record.unbind = null
    record.contextDiffUnsub?.()
    record.contextDiffUnsub = null
    record.consoleUnsub?.()
    record.consoleUnsub = null
    record.browserUnsub?.()
    record.browserUnsub = null
    const runtime = record.runtime
    record.runtime = null
    if (!runtime) return
    const session = runtime.session
    if (session.isStreaming) await session.abort()
    await runtime.dispose()
  }

  tabState(tabId: string): TabRuntimeState {
    const record = this.tabs.get(tabId)
    const runtime = record?.runtime
    if (!record || !runtime) {
      return {
        ready: false,
        sessionId: null,
        sessionFile: null,
        streaming: false,
        model: null,
        thinkingLevel: null,
        modelFallback: null
      }
    }
    return {
      ready: true,
      sessionId: runtime.session.sessionId ?? null,
      sessionFile: runtime.session.sessionFile ?? null,
      streaming: runtime.session.isStreaming,
      model: runtime.session.model ? toOption(runtime.session.model) : null,
      thinkingLevel: runtime.session.thinkingLevel ?? null,
      modelFallback: runtime.modelFallbackMessage ?? null
    }
  }

  /**
   * 读某个标签已经说过的话（R1 R5）。
   *
   * 持久态不用另存 —— Pi 的会话文件就是权威，这里只是把它读出来。
   * 取的是**当前分支**（getBranch）：压缩前的旧话也要在，压缩是为了给模型看，
   * 不是为了让人忘掉。
   */
  readEntries(tabId: string): StreamItem[] {
    const sessionManager = this.tabs.get(tabId)?.runtime?.session.sessionManager
    if (!sessionManager) return []
    const branch = sessionManager.getBranch()
    const entries = branch.length > 0 ? branch : sessionManager.getEntries()
    return entriesToItems(entries).map((item) => {
      if (item.kind !== 'message' || item.role !== 'user' || !item.images?.length) return item
      const images = item.images
        .map((image) => thumbnailStreamImage(image))
        .filter((image): image is NonNullable<typeof image> => image !== null)
      return { ...item, ...(images.length > 0 ? { images } : { images: undefined }) }
    })
  }

  // -------------------------------------------------------------------------
  // 模型（绑在会话上）
  // -------------------------------------------------------------------------

  /** 某个标签用的模型 */
  currentModel(tabId: string): ModelOption | null {
    const model = this.tabs.get(tabId)?.runtime?.session.model
    return model ? toOption(model) : null
  }

  /**
   * 恢复会话时没能恢复原模型的原因。
   *
   * Pi 会退回全局默认而不报错，原因只放在这个字段里 —— 不显示出来，
   * 用户就只会看到「我明明选了 X，打开却是 Y」。
   */
  modelFallback(tabId: string): string | null {
    return this.tabs.get(tabId)?.runtime?.modelFallbackMessage ?? null
  }

  /** 已配置凭据的模型清单（没凭据的选了也是报错，不列） */
  async listModels(tabId: string): Promise<ModelOption[]> {
    const modelRuntime = this.tabs.get(tabId)?.runtime?.session.modelRuntime
    if (!modelRuntime) return []
    try {
      return (await modelRuntime.getAvailable()).map(toOption)
    } catch {
      // 取不到就退回上一次的快照，总比空白强
      return modelRuntime.getAvailableSnapshot().map(toOption)
    }
  }

  /** 切某个标签的模型 */
  async selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void> {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) throw new Error('runtime 尚未启动')
    const model = session.modelRuntime.getModel(provider, id)
    if (!model) throw new Error(`模型不存在：${provider}/${id}`)
    await session.setModel(model, { persist })
  }

  /**
   * 列某个标签可用的 `/` 命令。
   *
   * 三类来源：Pi 的 prompt 模板、扩展命令、技能命令。同名时按 Pi 的实际分发顺序
   * 覆盖：扩展 > 技能 > 模板（`prompt()` 先试扩展命令，再展开技能，最后展开模板）。
   */
  async listCommands(tabId: string): Promise<CommandOption[]> {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) return []
    const byName = new Map<string, CommandOption>()

    for (const template of session.promptTemplates) {
      byName.set(template.name, {
        name: template.name,
        description: template.description,
        argumentHint: template.argumentHint,
        source: 'template'
      })
    }

    if (session.settingsManager.getEnableSkillCommands()) {
      for (const skill of session.resourceLoader.getSkills().skills) {
        const name = `skill:${skill.name}`
        byName.set(name, { name, description: skill.description, source: 'skill' })
      }
    }

    for (const command of session.extensionRunner.getRegisteredCommands()) {
      byName.set(command.invocationName, {
        name: command.invocationName,
        description: command.description,
        source: 'extension',
        hasArgumentCompletions: typeof command.getArgumentCompletions === 'function'
      })
    }

    return [...byName.values()]
  }

  /** 列某个扩展命令的参数候选 */
  async completeCommand(tabId: string, name: string, prefix: string): Promise<CommandArgumentOption[]> {
    const command = this.tabs.get(tabId)?.runtime?.session.extensionRunner.getCommand(name)
    if (!command?.getArgumentCompletions) return []
    try {
      const items = await command.getArgumentCompletions(prefix)
      return (items ?? []).map((item) => ({
        value: item.value,
        label: item.label,
        ...(item.description ? { description: item.description } : {})
      }))
    } catch {
      // 参数候选取不到不影响正常输入，静默回落
      return []
    }
  }

  /** 当前模型支持的思考等级 */
  thinkingLevels(tabId: string): ThinkingLevel[] {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) return []
    try {
      return [...session.getAvailableThinkingLevels()]
    } catch {
      // 取不到可用等级时按没有处理，界面会提示当前模型不支持
      return []
    }
  }

  /** 设置思考等级（只影响当前会话） */
  setThinkingLevel(tabId: string, level: ThinkingLevel): void {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) throw new Error('runtime 尚未启动')
    session.setThinkingLevel(level)
  }

  /** 压缩某个标签的上下文 */
  async compactTab(tabId: string): Promise<void> {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) throw new Error('runtime 尚未启动')
    await session.compact()
  }

  /**
   * 给某个会话改名。
   *
   * 优先走已经活着的 runtime：`AgentSession.setSessionName()` 会同时把新名字写进
   * 内存里的 SessionManager、追加到会话文件、发 `session_info_changed` 事件。
   * 只打开文件写一条的话，runtime 内存里没有这条，之后压缩重写文件时可能丢。
   */
  async renameSession(path: string, name: string): Promise<void> {
    const target = normalize(path)
    const record = [...this.tabs.values()].find((tab) => tab.path && normalize(tab.path) === target)
    const session = record?.runtime?.session
    if (session) {
      session.setSessionName(name)
      return
    }
    // 没有 runtime：文件必须还在 —— open() 遇到不存在的路径会新建一个会话，改错文件
    if (!existsSync(path)) throw new TabSessionMissingError(path)
    SessionManager.open(path).appendSessionInfo(name)
  }

  async setSessionName(tabId: string, name: string): Promise<void> {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) throw new Error('runtime 尚未启动')
    session.setSessionName(name)
  }

  /** 往某个标签发一条用户消息 */
  async prompt(tabId: string, text: string, images?: PromptImage[]): Promise<void> {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) throw new Error('runtime 尚未启动')
    await session.prompt(text, images && images.length > 0 ? { images } : undefined)
  }

  /**
   * 中止某个标签正在跑的那一轮。
   *
   * 跟 `closeTab` 里那次 `abort()` 不是一回事：那个是关标签前的收尾，
   * 这里是用户主动停 —— 停完标签还在、runtime 不动，接着还能发下一条。
   *
   * `abort()` 内部会 `await waitForIdle()`：工具正在执行时要等它响应 abort signal，
   * 可能几秒。所以这个方法会等，调用方要知道它不是瞬时的。
   */
  async abortTab(tabId: string): Promise<void> {
    const session = this.tabs.get(tabId)?.runtime?.session
    // 没在跑就直接返回 —— 按钮可能连着点了两下，第二次什么都不该发生
    if (!session || !session.isStreaming) return
    await session.abort()
  }

  async stop(): Promise<void> {
    const ids = [...this.tabs.keys()]
    for (const id of ids) await this.closeTab(id)
  }

  /**
   * 列出**指定这几个项目**的会话。
   *
   * 不再全量扫 `listAll()` —— 那是 Pi 聊过的所有项目（包括历史遗留的），
   * 侧栏只该列用户选中的那几个。顺带也快了：只读选中的目录。
   */
  static async listConversations(cwds: string[]): Promise<ConversationInfo[]> {
    const lists = await Promise.all(
      cwds.map(async (cwd) => {
        const sessions = await SessionManager.list(cwd)
        return sessions.map(toConversationInfo)
      })
    )
    return lists.flat().sort(byModifiedDesc)
  }
}

/** Pi 的会话信息 → 渲染进程能吃的形状 */
function toConversationInfo(info: {
  id: string
  path: string
  name?: string
  firstMessage: string
  modified: Date
  messageCount: number
  cwd: string
}): ConversationInfo {
  return {
    id: info.id,
    path: info.path,
    title: pickTitle(info.name, info.firstMessage),
    name: info.name?.trim() || null,
    modified: new Date(info.modified).toISOString(),
    messageCount: info.messageCount,
    cwd: info.cwd
  }
}

/** 按修改时间倒序（新的在前） */
function byModifiedDesc(a: ConversationInfo, b: ConversationInfo): number {
  return b.modified.localeCompare(a.modified)
}

/**
 * Pi 的模型对象 → 渲染进程能吃的形状。
 *
 * 只给选择器要用的四个量：名字、上下文长度、支不支持思考、价格（每百万 token）。
 * 完整模型对象不往渲染进程送 —— Pi 的类型不该跨过 IPC。
 */
function toOption(model: {
  provider: string
  id: string
  name: string
  contextWindow: number
  reasoning: boolean
  cost: { input: number; output: number }
}): ModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    reasoning: model.reasoning,
    cost: { input: model.cost.input, output: model.cost.output }
  }
}

function pickTitle(name: string | undefined, firstMessage: string | undefined): string {
  // 会话名优先；没有名字（或空名字）就退回首条用户消息
  const raw = (name?.trim() ? name : (firstMessage ?? '')).trim()
  if (!raw) return '未命名对话'
  const oneLine = raw.replace(/\s+/g, ' ')
  return oneLine.length > 60 ? `${oneLine.slice(0, 60)}…` : oneLine
}
