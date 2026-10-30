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
  type EventBus
} from '@earendil-works/pi-coding-agent'
import { existsSync } from 'node:fs'
import type { ConversationInfo, ModelOption, StreamItem } from '@contract/index'
import { entriesToItems } from '@contract/stream'

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
  openTab(tabId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void>
  /** 关掉一个标签：先 abort 等那一轮结算，再 dispose */
  closeTab(tabId: string): Promise<void>
  /** 激活一个标签：runtime 还没建就建 */
  activateTab(tabId: string): Promise<void>
  /** 某个标签的运行时状态 */
  tabState(tabId: string): TabRuntimeState
  /** 某个标签的会话条目 */
  readEntries(tabId: string): StreamItem[]
  /** 某个标签的可用模型清单 */
  listModels(tabId: string): Promise<ModelOption[]>
  /** 切某个标签的模型（persist 时同时设为新会话默认） */
  selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void>
  /** 往某个标签发一条用户消息 */
  prompt(tabId: string, text: string): Promise<void>
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

/** 一个标签背后的一套运行时 */
interface TabRecord {
  tabId: string
  cwd: string
  /** 会话文件路径（新会话在第一条用户消息之前还没有文件） */
  path: string | null
  /** 这个标签自己的 EventBus —— 共享一个会串台 */
  bus: EventBus
  runtime: AgentSessionRuntime | null
  unbind: (() => void) | null
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

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
  async openTab(tabId: string, options: { cwd: string; path?: string; lazy?: boolean }): Promise<void> {
    const path = options.path ?? null
    // 文件不在就别登记了 —— 恢复时靠这个把没落盘的标签挑出去
    if (path && !existsSync(path)) throw new TabSessionMissingError(path)

    const record: TabRecord = {
      tabId,
      cwd: options.cwd,
      path,
      bus: createEventBus(),
      runtime: null,
      unbind: null,
      sessionManager: null
    }
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
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        // 这个标签自己的 EventBus。共享一个的话，N 个标签的扩展实例都注册在
        // 同一个 emitter 上，一个标签发消息其他标签也收得到（D4 修订）。
        resourceLoaderOptions: { eventBus: record.bus }
      })
      const { session, extensionsResult, modelFallbackMessage } = await createAgentSessionFromServices({
        services,
        sessionManager
      })
      record.unbind = this.bind(record.tabId, session)
      return { session, extensionsResult, modelFallbackMessage, services, diagnostics: services.diagnostics }
    }

    const sessionManager = record.path
      ? SessionManager.open(record.path, undefined, record.cwd)
      : SessionManager.create(record.cwd)
    record.sessionManager = sessionManager
    record.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: record.cwd,
      agentDir,
      sessionManager
    })
  }

  private bind(tabId: string, session: AgentSession): () => void {
    return session.subscribe((event) => {
      const { type, ...rest } = event as unknown as { type: string } & Record<string, unknown>
      this.emit({ type, data: rest, tabId })
    })
  }

  /** 激活一个标签：runtime 还没建就建（懒加载） */
  async activateTab(tabId: string): Promise<void> {
    const record = this.record(tabId)
    if (record.runtime) return
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
      return { ready: false, sessionId: null, sessionFile: null, streaming: false, model: null, modelFallback: null }
    }
    return {
      ready: true,
      sessionId: runtime.session.sessionId ?? null,
      sessionFile: runtime.session.sessionFile ?? null,
      streaming: runtime.session.isStreaming,
      model: runtime.session.model ? toOption(runtime.session.model) : null,
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
    return entriesToItems(entries)
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

  /** 往某个标签发一条用户消息 */
  async prompt(tabId: string, text: string): Promise<void> {
    const session = this.tabs.get(tabId)?.runtime?.session
    if (!session) throw new Error('runtime 尚未启动')
    await session.prompt(text)
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
