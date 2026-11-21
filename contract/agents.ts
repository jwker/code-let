/**
 * agent —— 顶部标签变成项目之后，窄轨里的那一个个头像（PLAN.md D53）。
 *
 * 一个 agent 就是一个会话（D53）。这里只放**推给渲染进程的形状**；
 * 落盘形状是 `host/main/agents.ts` 的 `AgentRecord`。
 * 分法跟 `ProjectTabInfo` / `StoredProjectTab` 一样：磁盘格式归主进程，界面契约归 contract。
 *
 * 本文件不 import 任何运行时依赖（跟 contract 其他文件一样）。
 */

/** 右栏里能放的功能区。`null` 是空态：右栏展开着但还没选 */
export type RightPanelKind = 'code' | 'docs' | 'browser'

/**
 * 一条项目标签的右栏状态。
 *
 * 跟左列的 `pane` 一起落盘、一起随快照推给渲染进程：切走再切回来，
 * 右栏还是原来那个样子。宽度不在这里 —— 那是窗口级偏好。
 */
export interface RightPanelState {
  /** 右栏展开着没有 */
  open: boolean
  /** 开着的是哪个功能区；`null` 是空态 */
  kind: RightPanelKind | null
}

/**
 * 项目标签的左列看什么。
 *
 * 左列只剩两种内容：当前 agent 的对话，或者占满一列的项目设置。
 * 代码、文档、浏览器在右栏里（`rightPanel.kind`），不再是左列的取值。
 */
export type ProjectPaneView = 'agent' | 'settings'

/**
 * 一个项目标签。
 *
 * 跟 `AgentInfo` 是两个层次：那边是一个 Pi 会话，这边背后是一整个项目 ——
 * 里面可能有好几个 agent 在跑。
 */
export interface ProjectTabInfo {
  /** 项目标签的 id，宿主发的。跟 cwd 分开：同一个目录将来可能被打开两次 */
  id: string
  /** 项目目录（绝对路径） */
  cwd: string
  /** 标签上显示的名字，默认取目录名 */
  title: string
  /** 当前看的是什么（左列） */
  pane: ProjectPaneView
  /** 右栏开着没有、开的是哪个功能区 */
  rightPanel: RightPanelState
  /** 上次看的 agent；`pane !== 'agent'` 时也留着，切回来不用重选 */
  activeAgentId: string | null
}

/**
 * 推给渲染进程的一个 agent。
 *
 * 前一半是落盘字段（`AgentRecord`），后一半是运行时状态
 * （`streaming` / `ready` / `stale`）：界面要显示「在跑」「落后了」，不能靠猜。
 */
export interface AgentInfo {
  /** agent 的稳定 id —— runtime 以它为键（D58） */
  id: string
  /** agent 名 —— 窄轨里的名字，只由默认名或手动改名决定 */
  name: string
  /**
   * 会话名（会话文件里的 `session_info`，没有就是首条消息摘要）。
   *
   * **跟 `name` 是两个东西**：这是 Pi 侧的名字，裸 pi 也看得到。
   * 窄轨的悬停气泡把它作为第二行显示，方便对照。
   */
  sessionTitle: string | null
  /** 类型 id。内置是 `general` / `dev` / `product`，也可能是用户自定义的 */
  type: string
  /**
   * 同类型里的第几个实例。
   *
   * 头像上只显示 2 及以上的角标 —— 第 1 个不显示，省一点视觉噪音。
   */
  instance: number
  /** agent 所在目录 */
  cwd: string
  /**
   * 会话文件路径。
   *
   * Pi 在创建会话时就算出来了，**但文件要等第一条用户消息才真的建** ——
   * 非 null 不代表磁盘上有这个文件。
   */
  sessionPath: string | null
  /** 最后活动时间（毫秒）。自动归档按它算（D55） */
  lastActiveAt: number
  /** 归档时间；null = 在窄轨里 */
  archivedAt: number | null
  /** 用户消息条数 —— 归档列表显示「42 轮」 */
  turns: number
  /** 运行时：这个 agent 是不是正在跑 */
  streaming: boolean
  /** 运行时：runtime 建好了没（懒加载的 agent 先不建） */
  ready: boolean
  /**
   * 运行时：这个会话文件在**别处**被改过（比如在裸 pi 的 TUI 里聊了几句）。
   *
   * Pi 的 `SessionManager.open()` 只在构造时把文件读进内存，之后不再重读 ——
   * 所以别的进程写了，这个 agent 的内容流不知道。标出来让用户决定要不要重新加载，
   * 不自动同步：Codelet 这边如果还基于旧上下文写，两边会冲突。
   *
   * 读它的地方只有一处：输入框（`stale` 时禁用发送，逼用户先 `/reload`）。
   */
  stale: boolean
}
