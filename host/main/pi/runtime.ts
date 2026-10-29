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
import type { ConversationInfo, ModelOption, StreamItem } from '@contract/index'
import { entriesToItems } from '@contract/stream'

export type PiEventListener = (event: { type: string; data: unknown }) => void

/**
 * 宿主状态用到的运行时能力（PLAN.md D7）。
 *
 * 单独拎出来是为了让宿主状态能拿假实现跑测试 ——
 * 真实运行时要模型、要凭据，测不动。
 */
export interface PiRuntimePort {
  /** runtime 起来了吗 */
  readonly ready: boolean
  /** 当前 runtime 所在的目录 */
  readonly cwd: string | null
  /** 当前会话的 id */
  readonly currentSessionId: string | null
  /** 订阅会话流事件，返回退订函数 */
  onEvent(listener: PiEventListener): () => void
  /** 在某个目录上起（或重起）runtime */
  start(cwd: string, options?: { resume?: boolean }): Promise<void>
  /** 在当前目录开一个新会话 */
  newSession(): Promise<void>
  /** 切到另一个会话 */
  switchSession(sessionPath: string): Promise<void>
  /** 往当前会话发一条用户消息 */
  prompt(text: string): Promise<void>
  /** 当前会话已经说过的话 */
  readEntries(): StreamItem[]
  /** 当前会话用的模型 */
  currentModel(): ModelOption | null
  /** 恢复会话时没能恢复原模型的原因 */
  modelFallback(): string | null
  /** 已配置凭据的模型清单 */
  listModels(): Promise<ModelOption[]>
  /** 切当前会话的模型（persist 时同时设为新会话默认） */
  selectModel(provider: string, id: string, persist: boolean): Promise<void>
  /** 收摊 */
  stop(): Promise<void>
}

/**
 * Pi 运行时的宿主封装。
 *
 * 只做三件事：把 runtime 起在某个 cwd 上、把会话流事件转出去、把会话列表读出来。
 * Pi 自己的 API 一律不外泄到渲染进程（D5 / 边界 1）。
 */
export class PiRuntime implements PiRuntimePort {
  /** 扩展与宿主之间的唯一通道（PLAN.md D6） */
  readonly bus: EventBus = createEventBus()

  private runtime: AgentSessionRuntime | null = null
  private unbind: (() => void) | null = null
  private listeners = new Set<PiEventListener>()
  private sessionId: string | null = null

  /** 当前 runtime 所在的目录 */
  get cwd(): string | null {
    return this.runtime?.cwd ?? null
  }

  get currentSessionId(): string | null {
    return this.sessionId
  }

  get ready(): boolean {
    return this.runtime !== null
  }

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: { type: string; data: unknown }): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个订阅者出错不能拖垮整条流
      }
    }
  }

  private bind(session: AgentSession): void {
    this.unbind?.()
    this.unbind = session.subscribe((event) => {
      const { type, ...rest } = event as unknown as { type: string } & Record<string, unknown>
      this.emit({ type, data: rest })
    })
    this.sessionId = session.sessionId ?? null
  }

  /**
   * 在指定目录上起（或重起）runtime。
   * 换项目、换会话都走这里 —— 同一时刻只有一个活动会话（D4）。
   *
   * resume = 接着这个目录上一次的会话跑；否则起一个新会话。
   */
  async start(cwd: string, options?: { resume?: boolean }): Promise<void> {
    await this.stop()

    const agentDir = getAgentDir()

    // 工厂由 runtime 持有，换会话时会被再次调用，所以事件订阅在这里重绑
    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        // 扩展与宿主之间的唯一通道（PLAN.md D6）
        resourceLoaderOptions: { eventBus: this.bus }
      })
      const { session, extensionsResult, modelFallbackMessage } = await createAgentSessionFromServices({
        services,
        sessionManager
      })
      this.bind(session)
      return { session, extensionsResult, modelFallbackMessage, services, diagnostics: services.diagnostics }
    }

    this.runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: options?.resume ? SessionManager.continueRecent(cwd) : SessionManager.create(cwd)
    })
  }

  /** 切到另一个目录下的会话（跨项目） */
  async switchSession(sessionPath: string, cwdOverride?: string): Promise<void> {
    if (!this.runtime) throw new Error('runtime 尚未启动')
    await this.runtime.switchSession(sessionPath, { cwdOverride })
  }

  /** 在当前目录开一个新会话 */
  async newSession(): Promise<void> {
    if (!this.runtime) throw new Error('runtime 尚未启动')
    await this.runtime.newSession()
  }

  /** 往当前会话发一条用户消息 */
  async prompt(text: string): Promise<void> {
    if (!this.runtime) throw new Error('runtime 尚未启动')
    await this.runtime.session.prompt(text)
  }

  async stop(): Promise<void> {
    this.unbind?.()
    this.unbind = null
    this.sessionId = null
    const runtime = this.runtime
    this.runtime = null
    if (runtime) await runtime.dispose()
  }

  /**
   * 读当前会话已经说过的话（R1 R5）。
   *
   * 持久态不用另存 —— Pi 的会话文件就是权威，这里只是把它读出来。
   * 取的是**当前分支**（getBranch）：压缩前的旧话也要在，压缩是为了给模型看，
   * 不是为了让人忘掉。
   */
  readEntries(): StreamItem[] {
    const sessionManager = this.runtime?.session.sessionManager
    if (!sessionManager) return []
    const branch = sessionManager.getBranch()
    const entries = branch.length > 0 ? branch : sessionManager.getEntries()
    return entriesToItems(entries)
  }

  // -------------------------------------------------------------------------
  // 模型（绑在会话上）
  // -------------------------------------------------------------------------

  /** 当前会话用的模型 */
  currentModel(): ModelOption | null {
    const model = this.runtime?.session.model
    return model ? toOption(model) : null
  }

  /**
   * 恢复会话时没能恢复原模型的原因。
   *
   * Pi 会退回全局默认而不报错，原因只放在这个字段里 —— 不显示出来，
   * 用户就只会看到「我明明选了 X，打开却是 Y」。
   */
  modelFallback(): string | null {
    return this.runtime?.modelFallbackMessage ?? null
  }

  /** 已配置凭据的模型清单（没凭据的选了也是报错，不列） */
  async listModels(): Promise<ModelOption[]> {
    const modelRuntime = this.runtime?.session.modelRuntime
    if (!modelRuntime) return []
    try {
      return (await modelRuntime.getAvailable()).map(toOption)
    } catch {
      // 取不到就退回上一次的快照，总比空白强
      return modelRuntime.getAvailableSnapshot().map(toOption)
    }
  }

  /** 切当前会话的模型 */
  async selectModel(provider: string, id: string, persist: boolean): Promise<void> {
    const session = this.runtime?.session
    if (!session) throw new Error('runtime 尚未启动')
    const model = session.modelRuntime.getModel(provider, id)
    if (!model) throw new Error(`模型不存在：${provider}/${id}`)
    await session.setModel(model, { persist })
  }

  /** 列出某个目录下的会话 */
  static async listConversations(cwd: string): Promise<ConversationInfo[]> {
    const sessions = await SessionManager.list(cwd)
    return sessions
      .map((info) => ({
        id: info.id,
        path: info.path,
        title: pickTitle(info.name, info.firstMessage),
        modified: new Date(info.modified).toISOString(),
        messageCount: info.messageCount,
        cwd: info.cwd
      }))
      .sort((a, b) => b.modified.localeCompare(a.modified))
  }
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
