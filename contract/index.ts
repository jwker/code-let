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
  /** 系统目录选择器：打开新项目（加进清单 + 在那儿开一个新标签） */
  projectsOpen: 'host:projects:open',
  /** 从清单里移除一个项目（对话文件不动） */
  projectsRemove: 'host:projects:remove',
  /** 打开一个已有会话 → 开成新标签 */
  tabsOpen: 'host:tabs:open',
  /** 在某个目录里新建会话 → 开成新标签 */
  tabsNew: 'host:tabs:new',
  /** 切到某个标签 */
  tabsActivate: 'host:tabs:activate',
  /** 关掉某个标签 */
  tabsClose: 'host:tabs:close',
  /** 重新加载某个标签（外部改过这个会话文件之后） */
  tabsReload: 'host:tabs:reload',
  /** 读某个标签的内容流（历史重建） */
  tabsEntries: 'host:tabs:entries',
  /** 往某个标签发一条用户消息 */
  promptSend: 'host:prompt:send',
  /** 把一段文字写入系统剪贴板 */
  clipboardWrite: 'host:clipboard:write',
  /** 列出已配置凭据的模型 */
  modelsList: 'host:models:list',
  /** 切换某个标签的模型 */
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

/**
 * 一个标签 = 一个会话（PLAN.md D4）。
 *
 * 标签可以跨项目 —— 每个标签自带自己的 cwd。标签 id 由宿主发，
 * 与会话 id 分开：`SessionManager.open()` 打开一个不存在的文件会生成新的会话 id，
 * 绑死的话重启后认不出这个标签。
 */
export interface TabInfo {
  /** 标签自己的 id —— 宿主发的，稳定的身份 */
  id: string
  /** 会话 id（当前会话的）。runtime 还没建时是 null */
  sessionId: string | null
  /**
   * 会话文件路径。
   *
   * Pi 在创建会话时就算出了这个路径，但**文件要等第一条用户消息才真的建** ——
   * 所以这里非 null 不代表磁盘上有这个文件。
   */
  path: string | null
  /** 会话所在目录 */
  cwd: string
  /** 标签显示的标题 */
  title: string
  /** 目录名 —— 标签要能看出属于哪个项目 */
  projectName: string
  /** 这个标签的 agent 是不是正在跑 */
  streaming: boolean
  /** runtime 建好了没（懒加载：恢复出来的标签先不建） */
  ready: boolean
  /**
   * 这个标签所属的项目已经从 Codelet 的项目清单里移除了。
   *
   * 标签还能点开、还能用 —— 移走的只是「这个项目出现在清单里」这件事，
   * Pi 存的对话一个字都没动。
   */
  removed: boolean
  /**
   * 这个会话文件在**别处**被改过（比如在裸 pi 的 TUI 里聊了几句）。
   *
   * Pi 的 `SessionManager.open()` 只在构造时把文件读进内存，之后不再重读 ——
   * 所以别的进程写了，这个标签的内容流不知道。标出来让用户决定要不要重新加载，
   * 不自动同步：Codelet 这边如果还基于旧上下文写，两边会冲突。
   */
  stale: boolean
  /** 这个标签用的模型 */
  model: ModelOption | null
  /** 恢复会话时没能恢复原模型的原因 */
  modelFallback: string | null
  /** 创建失败时的原因 */
  error: string | null
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
  /** 打开的标签（按标签栏的顺序） */
  tabs: TabInfo[]
  /** 当前活动的标签 */
  activeTabId: string | null
  /**
   * 用户选的项目清单（PLAN.md D4 修订）。
   *
   * 侧栏只列这些项目的会话 —— 不是 Pi 聊过的所有项目。
   */
  projects: ProjectInfo[]
  /** 清单里这些项目的对话列表（按修改时间倒序） */
  conversations: ConversationInfo[]
  /**
   * **活动标签**的会话状态。
   *
   * 形状跟以前一样 —— 状态栏和模型选择器读的就是它，不用因为多标签而改。
   */
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
  /**
   * 这条事件属于哪个标签。
   *
   * 多标签之后事件不再是「无主」的（PLAN.md D4 修订）——
   * 渲染进程按它把事件分发到对应的内容流。
   */
  tabId: string
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
  /** 打开项目（系统目录选择器）→ 加进清单 → 在那儿开一个新标签 */
  openProject(): Promise<HostSnapshot>
  /**
   * 从清单里移除一个项目。
   *
   * **Pi 存的对话不动** —— 只是这个目录不再出现在清单里。
   */
  removeProject(path: string): Promise<HostSnapshot>
  /** 打开一个已有会话 → 开成新标签 */
  openConversation(path: string, cwd: string): Promise<HostSnapshot>
  /** 在某个目录里新建会话 → 开成新标签 */
  newConversation(cwd: string): Promise<HostSnapshot>
  /** 切到某个标签 */
  activateTab(tabId: string): Promise<HostSnapshot>
  /** 关掉某个标签 */
  closeTab(tabId: string): Promise<HostSnapshot>
  /**
   * 重新加载某个标签：重建它的 runtime，从磁盘重新读会话。
   *
   * 用于「这个会话在别处被改过」（`stale`）之后 —— 不自动做，因为重建会丢掉
   * 当前 runtime 的状态，而且如果别处还在写，重建完很快又会落后。
   */
  reloadTab(tabId: string): Promise<HostSnapshot>
  /** 读某个标签的内容流（历史重建，R1 R5） */
  getTabEntries(tabId: string): Promise<StreamItem[]>
  /** 往某个标签发一条消息 */
  prompt(tabId: string, text: string): Promise<void>
  /** 把一段文字写入系统剪贴板（复制回复正文） */
  copyText(text: string): Promise<void>
  /** 列出已配置凭据的模型（选择器用） */
  listModels(tabId: string): Promise<ModelOption[]>
  /** 切某个标签的模型；persist 为真时同时设为新会话默认 */
  selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void>
  /** 订阅快照推送，返回取消订阅的函数 */
  onSnapshot(listener: (snapshot: HostSnapshot) => void): () => void
  /** 订阅会话流增量事件 */
  onSessionEvent(listener: (events: SessionEvent[]) => void): () => void
}
