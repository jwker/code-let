/**
 * contract/ —— ext / view / host 三方共享的纯类型与 IPC 规格。
 *
 * 这里不放任何实现，也不 import 渲染层或 Node 专有模块：
 * 主进程、preload、渲染进程都从这里取同一份定义。
 *
 * 本文件刻意 **不 import 任何运行时依赖**：preload 是 sandbox 的，
 * 只能 require electron 本身，带进来一个 npm 包就会在运行时炸掉。
 * 需要 zod 校验的载荷规格放在 ./schemas.ts，主进程单独引。
 * 纯映射函数放在 ./stream.ts —— 同样不 import 任何东西。
 */

// ---------------------------------------------------------------------------
// IPC 通道
// ---------------------------------------------------------------------------

/** 请求 - 响应型通道（ipcMain.handle / ipcRenderer.invoke） */
export const IPC = {
  /** 取一次完整快照 */
  snapshotGet: 'host:snapshot:get',
  /** 系统目录选择器：打开新项目 */
  projectsOpen: 'host:projects:open',
  /** 切到某个项目（目录） */
  projectsSwitch: 'host:projects:switch',
  /** 在当前项目下新建会话 */
  conversationsNew: 'host:conversations:new',
  /** 切到某个已有会话 */
  conversationsSwitch: 'host:conversations:switch',
  /** 读当前会话的内容流（历史） */
  sessionEntries: 'host:session:entries',
  /** 往当前会话发一条用户消息 */
  promptSend: 'host:prompt:send',
  /** 把一段文字写入系统剪贴板 */
  clipboardWrite: 'host:clipboard:write',
  /** 列出已配置凭据的模型 */
  modelsList: 'host:models:list',
  /** 切换当前会话的模型 */
  modelsSelect: 'host:models:select'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** 主进程 → 渲染进程的单向事件通道 */
export const IPC_EVENTS = {
  /** 宿主状态快照（项目 / 对话列表 / 会话状态） */
  snapshot: 'host:event:snapshot',
  /** Pi 会话流的增量事件 */
  session: 'host:event:session'
} as const

export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]

// ---------------------------------------------------------------------------
// 载荷上限
// ---------------------------------------------------------------------------

/** 单条 IPC 载荷上限（字节）。超出的内容在主进程截断，不静默丢弃。 */
export const MAX_PAYLOAD_BYTES = 256 * 1024

/** 增量事件的合并窗口（毫秒）。同一窗口内的事件攒成一批再下行。 */
export const EVENT_COALESCE_MS = 16

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

/** 对话区的三种排版模式（PLAN.md D10） */
export type ConversationMode = 'normal' | 'terminal' | 'html'

/** 导航轨入口 */
export type NavEntry = 'session' | 'board' | 'memory' | 'code' | 'terminal'

/** 一个项目 = 一个目录 */
export interface ProjectInfo {
  /** 绝对路径 */
  path: string
  /** 目录名，作为显示名 */
  name: string
}

/** 一条对话 = 一个 Pi 会话 */
export interface ConversationInfo {
  id: string
  /** 会话文件路径 */
  path: string
  /** 显示标题：会话名，没有就退回首条用户消息 */
  title: string
  /** ISO 时间串 */
  modified: string
  messageCount: number
  /** 所属目录 */
  cwd: string
}

/** 一个可选的模型（选择器里的一项） */
export interface ModelOption {
  provider: string
  id: string
  /** 显示名 */
  name: string
  /** 上下文窗口（token） */
  contextWindow: number
  /** 支不支持思考强度 */
  reasoning: boolean
  /** 每百万 token 的价格（美元） */
  cost: { input: number; output: number }
}

/** 当前 Pi 会话的状态 */
export interface SessionState {
  /** runtime 是否就绪 */
  ready: boolean
  /** 当前会话所在目录 */
  cwd: string | null
  sessionId: string | null
  /**
   * 当前会话用的模型。
   *
   * 模型是绑在会话上的（Pi 的会话文件里有 model_change 与助手消息自带的模型），
   * 换会话就换模型。
   */
  model: ModelOption | null
  /** 恢复会话时没能恢复原模型的原因（没有就为 null） */
  modelFallback: string | null
  /** 创建失败时的原因 */
  error: string | null
}

/** 宿主权威状态的完整快照 */
export interface HostSnapshot {
  /** 最近项目，当前项目排在最前 */
  projects: ProjectInfo[]
  /** 当前项目 */
  currentProject: ProjectInfo | null
  /** 当前项目的对话列表 */
  conversations: ConversationInfo[]
  /** 当前会话状态 */
  session: SessionState
}

/** 一条 Pi 会话流的增量事件（原样透传，渲染进程按类型分派） */
export interface SessionEvent {
  /** Pi 事件类型 */
  type: string
  /** 事件负载 */
  data: unknown
  /** 主进程产生时刻 */
  at: number
}

// ---------------------------------------------------------------------------
// 内容流
// ---------------------------------------------------------------------------

/**
 * 一条助手回复的计量：token 与耗时。
 *
 * 数字直接取自 Pi 的助手消息（usage / durationMs / timestamp）——
 * 历史 jsonl 与实时事件给的是同一份，所以两条来源收敛（R3）。
 *
 * token 为 0 表示「这一家没报这个数」—— 不是「真的没用」。
 */
export interface ReplyStats {
  /** 输入 token（未命中缓存的那部分） */
  input: number
  /** 输出 token */
  output: number
  /** 缓存命中的 token */
  cacheRead: number
  /** 写入缓存的 token */
  cacheWrite: number
  /** 本次请求的耗时（毫秒）—— 回复结束才有 */
  durationMs?: number
  /** 请求发出的时刻（Unix 毫秒）—— 流式期间用来算已用时间 */
  startedAt?: number
}

/**
 * 对话区内容流里的一行。
 *
 * 普通模式和终端模式读的是**同一个数组**，只是画法不同（R3）。
 * 工具不是消息 —— 它是消息之间的动作，所以单独一种。
 */
export type StreamItem =
  | {
      kind: 'message'
      role: 'user' | 'assistant' | 'toolResult'
      text: string
      /**
       * 工具输出属于哪一次调用（只有 toolResult 有）。
       * 用来把「工具跑到一半的输出」和「工具跑完的最终输出」对上同一项 —— R4。
       */
      callId?: string
      /**
       * 这条助手回复的计量（只有助手消息有）。
       *
       * 工具调用那一轮没有正文，就没有这一项 —— 两条来源一致。
       */
      stats?: ReplyStats
    }
  | {
      kind: 'tool'
      callId: string
      name: string
      status: 'running' | 'ok' | 'error'
      /**
       * 工具行上显示的摘要 —— bash 的命令那一类。
       * 没有就只显示工具名。
       */
      label?: string
    }

// ---------------------------------------------------------------------------
// 渲染进程看到的宿主 API
// ---------------------------------------------------------------------------

/**
 * preload 通过 contextBridge 暴露的全部能力。
 *
 * 渲染进程不 import Pi，也不碰 node —— 只有这几个方法。
 */
export interface CodeletApi {
  /** 宿主平台（'darwin' / 'win32' / 'linux'），用来避开 macOS 的红绿灯 */
  readonly platform: string
  /** 取一次完整快照 */
  getSnapshot(): Promise<HostSnapshot>
  /** 打开新项目（系统目录选择器） */
  openProject(): Promise<HostSnapshot>
  /** 切到某个项目 */
  switchProject(path: string): Promise<HostSnapshot>
  /** 在当前项目下新建对话 */
  newConversation(): Promise<HostSnapshot>
  /** 切到某个已有对话 */
  switchConversation(path: string): Promise<HostSnapshot>
  /** 读当前会话的内容流（历史重建，R1 R5） */
  getSessionEntries(): Promise<StreamItem[]>
  /** 往当前会话发一条消息 */
  prompt(text: string): Promise<void>
  /** 把一段文字写入系统剪贴板（复制回复正文） */
  copyText(text: string): Promise<void>
  /** 列出已配置凭据的模型（选择器用） */
  listModels(): Promise<ModelOption[]>
  /** 切当前会话的模型；persist 为真时同时设为新会话默认 */
  selectModel(provider: string, id: string, persist: boolean): Promise<void>
  /** 订阅快照推送，返回取消订阅的函数 */
  onSnapshot(listener: (snapshot: HostSnapshot) => void): () => void
  /** 订阅会话流增量事件 */
  onSessionEvent(listener: (events: SessionEvent[]) => void): () => void
}
