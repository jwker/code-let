/**
 * agent —— 顶部标签变成项目之后，窄轨里的那一个个头像（PLAN.md D53）。
 *
 * 一个 agent 就是一个会话（D53）。这里只放**推给渲染进程的形状**；
 * 落盘形状是 `host/main/agents.ts` 的 `AgentRecord`。
 * 分法跟 `ProjectTabInfo` / `StoredProjectTab` 一样：磁盘格式归主进程，界面契约归 contract。
 *
 * 本文件不 import 任何运行时依赖（跟 contract 其他文件一样）。
 */

/** agent 的类型。类型决定区域 5/6 怎么分派（D52），也是头像形状与颜色的来源 */
export type AgentType = 'general' | 'dev' | 'product'

/** 项目级入口。agent 不在这里 —— 它在窄轨里是另一段（D51） */
export type ProjectPane = 'code' | 'docs' | 'browser' | 'settings'

/**
 * 项目标签当前看的是什么。
 *
 * `'agent'` 表示看 `activeAgentId` 指向的那个 agent；切到「代码」再切回来时
 * `activeAgentId` 仍然留着，不用重选。
 */
export type ProjectPaneView = ProjectPane | 'agent'

/** 分派表的键：项目入口，或者 agent 类型（D52） */
export type PaneLayoutKey = ProjectPane | AgentType

/** 一个入口的布局。`zone5: null` = 没有区域 5，区域 6 直接吃满 */
export interface PaneLayout {
  /** 区域 5 的默认宽度（像素） */
  zone5: number | null
  /** 区域 5 的可拖下限。不给就用 ZONE5_MIN */
  zone5Min?: number
}

/**
 * 区域 5 的分派表（D52）。
 *
 * 七个入口的布局差异只有这一个字段 —— 不给每个入口写一套布局代码。
 * 宽度是默认值，用户可以拖，拖完按入口各记一份。
 */
export const PANE_LAYOUT: Record<PaneLayoutKey, PaneLayout> = {
  // 文件树 / 文档树 / 设置分类：一列名字，268 够用
  code: { zone5: 268 },
  docs: { zone5: 268 },
  settings: { zone5: 268 },
  // 没有区域 5 的入口
  browser: { zone5: null },
  // 通用与开发 agent 第一版只有对话
  general: { zone5: null },
  dev: { zone5: null },
  // 产品 agent：窄边是对话，宽边是原型。对话比文件树要宽，下限也高
  product: { zone5: 380, zone5Min: 320 }
}

/** 区域 5 的默认可拖下限 */
export const ZONE5_MIN = 220
/** 区域 5 的可拖上限 */
export const ZONE5_MAX = 560

/**
 * 某个入口的区域 5 布局。
 *
 * `pane === 'agent'` 时按 agent 类型查表；类型还不知道（没选 agent）就没有区域 5。
 */
export function paneLayoutFor(
  pane: ProjectPaneView,
  agentType?: AgentType | null
): PaneLayout {
  if (pane === 'agent') {
    return agentType ? PANE_LAYOUT[agentType] : { zone5: null }
  }
  return PANE_LAYOUT[pane]
}

/** agent 类型的中文名 */
export const AGENT_TYPE_LABEL: Record<AgentType, string> = {
  general: '通用',
  dev: '开发',
  product: '产品'
}

/**
 * 新建 agent 时的默认名字：类型 + 实例序号。
 *
 * 用户改过名之后就用他自己的名字，这个只在创建时算一次。
 */
export function defaultAgentName(type: AgentType, instance: number): string {
  return `${AGENT_TYPE_LABEL[type]} ${instance}`
}

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
  /** 当前看的是什么 */
  pane: ProjectPaneView
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
  type: AgentType
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
