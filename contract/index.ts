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
  /** 删除会话（会话文件移入系统废纸篓，顺带关掉引用它的标签） */
  conversationsDelete: 'host:conversations:delete',
  /** 给会话改名（写进会话文件的 session_info 条目） */
  conversationsRename: 'host:conversations:rename',
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
  /** 中止某个标签正在跑的那一轮 */
  promptAbort: 'host:prompt:abort',
  /** 压缩某个标签的上下文 */
  promptCompact: 'host:prompt:compact',
  /** 把一段文字写入系统剪贴板 */
  clipboardWrite: 'host:clipboard:write',
  /** 列一个目录下的条目（文件树） */
  filesList: 'host:files:list',
  /** 按名字搜索项目里的文件（@ 引用） */
  filesSearch: 'host:files:search',
  /** 取消一个还没返回的文件搜索 */
  filesSearchCancel: 'host:files:search-cancel',
  /** 读一个文件的内容 */
  filesRead: 'host:files:read',
  /** 打开一个文件（进文件标签栏） */
  filesOpen: 'host:files:open',
  /** 关掉一个文件标签 */
  filesClose: 'host:files:close',
  /** 切到某个文件标签 */
  filesActivate: 'host:files:activate',
  /** 用系统默认程序打开一个文件（预览不了时的出路） */
  filesOpenExternal: 'host:files:openExternal',
  /** 文件被外部改过之后，重新加载 */
  filesReload: 'host:files:reload',
  /** 列出已配置凭据的模型 */
  modelsList: 'host:models:list',
  /** 列出某个标签可用的 `/` 命令 */
  commandsList: 'host:commands:list',
  /** 列某个扩展命令的参数候选 */
  commandsComplete: 'host:commands:complete',
  /** 打开系统文件选择器，选择要上传的附件 */
  attachmentsPick: 'host:attachments:pick',
  /** 临时对话：打开/恢复 */
  temporaryOpen: 'host:temporary:open',
  /** 临时对话：彻底关闭 */
  temporaryClose: 'host:temporary:close',
  /** 临时对话：发送 */
  temporaryPrompt: 'host:temporary:prompt',
  /** 临时对话：中止当前轮 */
  temporaryAbort: 'host:temporary:abort',
  /** 临时对话：模型列表 */
  temporaryModels: 'host:temporary:models',
  /** 临时对话：切换模型 */
  temporaryModelSelect: 'host:temporary:model-select',
  /** 上下文 Diff：取当前对比摘要 */
  contextDiffGet: 'host:context-diff:get',
  /** 上下文 Diff：取截至某一轮的最后两次请求 */
  contextDiffTurn: 'host:context-diff:turn',
  /** 上下文 Diff：列出可比较的会话快照 */
  contextDiffSessions: 'host:context-diff:sessions',
  /** 上下文 Diff：列出某个标签的请求快照 */
  contextDiffSnapshots: 'host:context-diff:snapshots',
  /** 上下文 Diff：取一条消息详情 */
  contextDiffDetail: 'host:context-diff:detail',
  /** 列当前模型可用的思考等级 */
  thinkingLevels: 'host:thinking:levels',
  /** 设置某个标签的思考等级 */
  thinkingSelect: 'host:thinking:select',
  /** 清掉已经显示的扩展错误 */
  extensionErrorsDismiss: 'host:extension-errors:dismiss',
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

/**
 * `@` 内容附件的上限。
 *
 * 文本按字节限：单文件 256KB、总量 1MB —— 再多会把模型上下文吃光。
 * 图片沿用文件预览的 2MB 单文件上限；总量 8MB。发送前 PNG/JPEG 会按最长边
 * 1568 缩放，缩放后的数据才进入模型上下文。数量最多 20 个。
 */
export const ATTACHMENT_LIMITS = {
  maxCount: 20,
  maxTextFileBytes: 256 * 1024,
  maxTextTotalBytes: 1024 * 1024,
  maxImageFileBytes: 2 * 1024 * 1024,
  maxImageTotalBytes: 8 * 1024 * 1024
} as const

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

/** 对话区的三种排版模式（PLAN.md D10） */
export type ConversationMode = 'normal' | 'terminal' | 'html'

/**
 * 右侧面板的导航入口。
 *
 * **没有「会话」** —— 主区永远是对话，不跟着导航切；
 * 导航只决定右侧面板显示什么。
 *
 * Git / Agent 也在里面：右侧面板一次只显示一个视图，没有常驻面板。
 */
export type NavEntry = 'board' | 'memory' | 'code' | 'terminal' | 'git' | 'agent' | 'context'

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
  /** Pi 会话文件里存的自定义名；没改过名就是 null */
  name: string | null
  /** ISO 时间串 */
  modified: string
  messageCount: number
  /** 所属目录 */
  cwd: string
}

/**
 * 批量删除会话的结果。
 *
 * 逐条报告，不因为一条失败就丢掉其他条的结果。
 * 文件在删除时已经不在磁盘上的，也算删除成功 —— 目标（它不存在）已经达成。
 */
export interface DeleteConversationsResult {
  deleted: string[]
  failed: Array<{ path: string; reason: string }>
}

/**
 * 一个打开的文件（PLAN.md D22）。
 *
 * **文件标签是全局的、跨项目的** —— 跟顶部那排会话标签是两套东西，
 * 所以不进 `TabInfo`，单独一个数组挂在快照上。
 */
export interface FileTab {
  id: string
  /** 文件绝对路径 */
  path: string
  /**
   * 这个文件属于哪个目录 —— **打开那一刻的快照**。
   *
   * 之后那个会话关了、cwd 变了，这里不变 —— 否则用户关了会话，
   * 已经打开的文件就没法读了。
   */
  cwd: string
  /** 项目里的相对路径，用来显示和去重 */
  relPath: string
  /**
   * 这个文件在别处被改过（打开了之后又被别的程序写过）。
   *
   * 跟会话标签的 `stale` 同一个思路：标出来让用户决定要不要重新读，
   * 不自动刷新 —— 用户可能正在看某一段，自动重读会把滚动位置也带走。
   */
  stale?: boolean
}

/** 文件树里的一项 */
export interface FileEntry {
  /** 名字（不含目录） */
  name: string
  kind: 'dir' | 'file'
  /** 字节数（目录没有） */
  size?: number
  /**
   * 被项目根的 `.gitignore` 命中。
   *
   * **只置灰，不隐藏** —— 用户可能就是想看 `node_modules` 里的某个文件。
   */
  ignored?: boolean
}

/** `@` 搜索里的一项。路径是相对项目根的，用 `/` 分隔。 */
export interface FileSearchResult {
  path: string
  kind: 'dir' | 'file'
  /** 被项目根的 `.gitignore` 命中 */
  ignored?: boolean
}

/** 读一个文件的结果 */
export type FileContent =
  | {
      kind: 'text'
      text: string
      /** 行数 —— 渲染时画行号用 */
      lines: number
      /** 是不是二进制（内容仍然返回，只是调用方可以选择不渲染） */
      binary: boolean
      /** 超过阈值只给提示，不带内容 */
      tooLarge: boolean
      size: number
    }
  | {
      kind: 'image'
      /** data URL，直接塞给 <img src> */
      dataUrl: string
      size: number
    }
  | {
      kind: 'unsupported'
      reason: string
      size?: number
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

/** 输入框里用 `/` 调用的 Pi 命令来源 */
export type CommandSource = 'template' | 'extension' | 'skill'

/** 扩展错误：加载失败，或者执行 handler / session_start 时抛错 */
export interface ExtensionErrorInfo {
  /** 属于哪个标签；加载错误在恢复标签时也可能有 */
  tabId: string | null
  kind: 'load' | 'runtime'
  /** 扩展文件路径，或者 `<runtime>` / `<session_start>` */
  path: string
  /** 执行错误对应的事件名（command、session_start 等） */
  event?: string
  message: string
  /** 发生时刻（Unix 毫秒），用于排序 */
  at: number
}

/** Pi 的思考等级 —— 具体哪些可用由当前模型决定 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 一个可在输入框里用 `/` 调用的 Pi 命令 */
export interface CommandOption {
  /** 不带前导斜杠 */
  name: string
  description?: string
  argumentHint?: string
  source: CommandSource
  /** 扩展提供了 getArgumentCompletions，输入空格后可以弹参数候选 */
  hasArgumentCompletions?: boolean
}

/** 扩展命令的一个参数候选 */
export interface CommandArgumentOption {
  value: string
  label: string
  description?: string
}

/** 系统文件选择器选中的一个附件；path 不暴露给渲染进程，发送时只回传 id */
export interface PickedAttachment {
  id: string
  /** 文件名（不含目录） */
  name: string
  kind: 'text' | 'image'
  size: number
  tokens: number
}

export interface PickAttachmentsResult {
  attachments: PickedAttachment[]
  /** 选中的文件里不能作为附件的原因，每个文件一条 */
  errors: string[]
}

/** 一条上下文消息的摘要（不含全文） */
export interface ContextMessageSummary {
  key: string
  role: string
  hash: string
  tokens: number
  preview: string
  /** 修改项在基线快照里的对应消息；新增/删除没有 */
  previousKey?: string
  /** 基线消息的 preview，详情不可用时兜底 */
  previousPreview?: string
}

/** 一次模型请求的上下文快照引用 */
export interface ContextSnapshotRef {
  id: string
  sessionId: string
  sessionPath: string | null
  sessionName?: string
  turn: number
  request: number
  capturedAt: number
  totalTokens: number
}

/** 上下文 diff 的分组 */
export interface ContextDiffGroup {
  kind: 'system' | 'tools' | 'added' | 'removed' | 'modified' | 'shared' | 'compacted'
  label: string
  messages: ContextMessageSummary[]
  tokens?: number
}

/** 右侧栏当前的上下文对比 */
export interface ContextDiffView {
  current: ContextSnapshotRef
  baseline: ContextSnapshotRef | null
  tokens: { before: number; after: number }
  system: 'same' | 'changed' | 'only-current' | 'only-baseline' | 'unknown'
  tools: 'same' | 'changed' | 'unknown'
  /** toolsHash 是近似信号，不是最终声明文本 */
  toolsApproximate: boolean
  counts: { added: number; removed: number; modified: number; shared: number }
  groups: ContextDiffGroup[]
}

/** 跨会话基线选择器用 */
export interface ContextDiffSession {
  sessionId: string
  sessionName?: string
  sessionPath: string | null
  first: ContextSnapshotRef | null
  last: ContextSnapshotRef | null
}

/** 弹窗式临时对话；不写 session 文件，不进标签/侧栏 */
export interface TemporaryChatState {
  id: string
  cwd: string
  model: ModelOption | null
  error: string | null
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
  /** 当前会话的思考等级；runtime 没建时是 null */
  thinkingLevel: ThinkingLevel | null
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
   * 正在重读数据（会话列表刷新 / 标签重载）。
   *
   * 只管「事实」—— 什么时候该显示给人看（延迟出现、最短停留）是渲染进程的事，
   * 见 `host/renderer/src/shell/refreshIndicator.ts`。
   */
  refreshing: boolean
  /**
   * 正在中止的标签（`abortPrompt` 还没返回的那些）。
   *
   * 跟 `refreshing` 一样只管事实 —— 什么时候显示「停止中」是渲染进程的事。
   */
  aborting: string[]
  /** 打开的文件（按打开顺序）。文件标签是全局的，跟会话标签无关（D22） */
  files: FileTab[]
  /** 当前活动的文件（null = 没有） */
  activeFileId: string | null
  /** 扩展加载 / 执行错误 —— 侧栏主区顶部会提示；清掉后为空 */
  extensionErrors: ExtensionErrorInfo[]
  /** 当前临时对话；null 表示没有打开过，或已经彻底关闭 */
  temporaryChat: TemporaryChatState | null
  /** 活动标签的上下文对比；没有快照时为 null */
  contextDiff: ContextDiffView | null
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

/** 用户消息里带的图片缩略图；原图只给模型，不进实时事件流 */
export interface StreamImage {
  mimeType: string
  /** base64，不带 data URL 前缀 */
  data: string
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
      /** 用户消息里的图片缩略图（只有 user 有） */
      images?: StreamImage[]
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
      /**
       * 这条助手消息是被用户中止的（Pi 的 `stopReason === "aborted"`）。
       *
       * 只读这个字段，不另存「哪一轮被中止过」的状态 —— 会话文件里本来就写着，
       * 所以重启之后历史记录里那次中止还标着。
       */
      aborted?: boolean
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
  | {
      /** 扩展通过 `pi.sendMessage()` 发出的自定义消息（display 为 true 才显示） */
      kind: 'custom'
      /** 扩展自己定的类型，显示在消息左上角 */
      customType: string
      /** 只取文本块；可能是空串 */
      text: string
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
  /**
   * 删除一批会话：会话文件移入系统废纸篓，引用它们的标签一起关掉。
   *
   * 路径必须都在宿主当前的会话列表里，否则整批拒绝。列表更新走快照推送，
   * 返回值只用于逐条报告失败。
   */
  deleteConversations(paths: string[]): Promise<DeleteConversationsResult>
  /**
   * 给一个会话改名。空名字表示清掉自定义名，标题退回首条用户消息。
   *
   * 名字写进 Pi 的会话文件（`session_info` 条目）；会话开着的话走它的 runtime，
   * 没有开着就打开会话文件追加一条。
   */
  renameConversation(path: string, name: string): Promise<HostSnapshot>
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
  /**
   * 往某个标签发一条消息。
   *
   * attachments 是项目内的相对路径；uploads 是 pickAttachments() 返回的 id。
   * 主进程在发送时读取内容并嵌入。
   */
  prompt(tabId: string, text: string, attachments?: string[], uploads?: string[]): Promise<void>
  /**
   * 中止某个标签正在跑的那一轮。
   *
   * 返回时**已经停稳**（Pi 的 `abort()` 内部 `await waitForIdle()`），
   * 所以等待期间界面要靠 `aborting` 显示「停止中」。
   * 没在跑、或者已经在停 —— 直接返回，不报错。
   */
  abortPrompt(tabId: string): Promise<void>
  /** 压缩某个标签的上下文。没有 runtime 时抛错 */
  compactTab(tabId: string): Promise<void>
  /** 列某个标签可用的 `/` 命令（Pi 模板、扩展、技能） */
  listCommands(tabId: string): Promise<CommandOption[]>
  /** 打开系统文件选择器，选择文本或图片附件 */
  pickAttachments(): Promise<PickAttachmentsResult>
  /** 打开或恢复临时对话；已存在时返回当前会话 */
  openTemporaryChat(): Promise<HostSnapshot>
  /** 彻底关闭临时对话并清除内存会话 */
  closeTemporaryChat(): Promise<HostSnapshot>
  /** 临时对话发消息；只接受系统选择器上传的附件 id */
  promptTemporary(id: string, text: string, uploads?: string[]): Promise<void>
  /** 中止临时对话当前轮 */
  abortTemporary(id: string): Promise<void>
  /** 临时对话可用模型 */
  listTemporaryModels(id: string): Promise<ModelOption[]>
  /** 临时对话切换模型；只影响这份内存会话 */
  selectTemporaryModel(id: string, provider: string, modelId: string): Promise<HostSnapshot>
  /** 取活动标签的上下文对比；baselineId 为空时用上一次请求 */
  getContextDiff(tabId: string, baselineId?: string): Promise<ContextDiffView | null>
  /** 取截至某一用户轮次的最后两次请求对比 */
  getContextDiffForTurn(
    tabId: string,
    turn: number,
    baselineId?: string
  ): Promise<ContextDiffView | null>
  /** 列出有快照可比较的会话 */
  listContextDiffSessions(): Promise<ContextDiffSession[]>
  /** 列出某个标签属于当前会话的请求快照 */
  listContextDiffSnapshots(tabId: string): Promise<ContextSnapshotRef[]>
  /** 取某个快照里一条消息的全文；缓存/会话不可用时返回 null */
  getContextDiffDetail(
    tabId: string,
    snapshotId: string,
    key: string
  ): Promise<{ text: string; truncated: boolean } | null>
  /** 列某个扩展命令的参数候选 */
  completeCommand(tabId: string, name: string, prefix: string): Promise<CommandArgumentOption[]>
  /** 列当前模型可用的思考等级 */
  listThinkingLevels(tabId: string): Promise<ThinkingLevel[]>
  /** 设置某个标签的思考等级 */
  selectThinkingLevel(tabId: string, level: ThinkingLevel): Promise<void>
  /** 清掉已经显示的扩展错误 */
  dismissExtensionErrors(): Promise<HostSnapshot>
  /** 按名字搜索项目里的文件 —— `@` 引用用，只返回相对路径。requestId 用于取消 */
  searchFiles(cwd: string, query: string, limit: number, requestId?: string): Promise<FileSearchResult[]>
  /** 取消一个文件搜索；只中断这次等待，索引构建会继续 */
  cancelFileSearch(requestId: string): Promise<void>
  /** 把一段文字写入系统剪贴板（复制回复正文） */
  copyText(text: string): Promise<void>
  /** 列一个目录下的条目 */
  listFiles(cwd: string, dir: string): Promise<FileEntry[]>
  /** 读一个文件 */
  readFile(cwd: string, path: string): Promise<FileContent>
  /** 打开一个文件（进文件标签栏） */
  openFile(cwd: string, path: string): Promise<HostSnapshot>
  /** 关掉一个文件标签 */
  closeFile(fileId: string): Promise<HostSnapshot>
  /** 切到某个文件标签 */
  activateFile(fileId: string): Promise<HostSnapshot>
  /**
   * 用系统默认程序打开一个文件。
   *
   * 预览不了的时候（二进制、太大、不支持的类型）唯一的出路。同样要过路径校验。
   */
  openFileExternal(cwd: string, path: string): Promise<void>
  /** 文件被外部改过之后，重新加载（清掉 stale） */
  reloadFile(fileId: string): Promise<HostSnapshot>
  /** 列出已配置凭据的模型（选择器用） */
  listModels(tabId: string): Promise<ModelOption[]>
  /** 切某个标签的模型；persist 为真时同时设为新会话默认 */
  selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void>
  /** 订阅快照推送，返回取消订阅的函数 */
  onSnapshot(listener: (snapshot: HostSnapshot) => void): () => void
  /** 订阅会话流增量事件 */
  onSessionEvent(listener: (events: SessionEvent[]) => void): () => void
}
