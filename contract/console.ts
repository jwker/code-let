/**
 * 调试控制台的共享类型。
 *
 * 这里只有类型和纯数据 —— 主进程、preload、渲染进程都从这里取同一份定义。
 * 不 import 任何运行时依赖（preload 是 sandbox 的）。
 */

/** 一条请求记录的元数据 —— 列表里显示的就是这些 */
export interface ConsoleRecordMeta {
  id: string
  sessionId: string
  /** 会话的自定义名字（用户改过才有） */
  sessionName: string | null
  /**
   * 列表里显示的会话标题。
   *
   * 自定义名字优先，没有就取首条用户消息 —— 跟侧栏的对话标题一个口径。
   */
  sessionTitle: string | null
  /** 这次请求在哪个目录下跑的（项目目录）—— 标题推不出来时用它兜底 */
  cwd: string | null
  /**
   * 触发这次请求的那条用户消息。
   *
   * 同一个会话里的多次请求靠它区分开 —— 列表里那列显示的就是它。
   */
  prompt: string | null
  /**
   * 这个会话里的第几次请求。
   *
   * 列表时按时间顺序数出来的，不落盘 —— 列表排序一变，编号也跟着变。
   */
  requestNo?: number
  /** 记录产生时的标签 id */
  tabId: string
  model: { provider: string; id: string } | null
  /** 毫秒时间戳 */
  capturedAt: number
  /** 四个一级节点各占多少字节（未压缩前的 JSON 长度） */
  sizes: { meta: number; transcript: number; provider: number; response: number }
  /** provider 返回的状态码；没拿到就是 null */
  providerStatus: number | null
  /** 从 provider 请求发出到助手消息定稿，毫秒；没跑完就是 null */
  durationMs: number | null
  /** 从 provider 请求发出到收到响应头，毫秒（首字节时间）；没拿到就是 null */
  firstByteMs: number | null
  /** 超过单条上限，只留了元数据 */
  truncated: boolean
}

export interface ConsoleListResult {
  records: ConsoleRecordMeta[]
  /** 存储目录 */
  dir: string
}

export interface ConsoleStats {
  dir: string
  /** 记录条数 */
  count: number
  /** 请求内容（容器文件）占多少字节 */
  contentBytes: number
  /** 索引占多少字节 */
  indexBytes: number
  /** 图片 blob 占多少字节 */
  blobBytes: number
  totalBytes: number
  /** 正在写盘的条数 */
  writing: number
  /** 写盘失败的条数 */
  failed: number
  /** 当前生效的清理规则 —— 界面上要把上限显示出来 */
  limits: ConsoleLimits
  /** 上次自动清理的结果 —— 清理要出声，不能静默删 */
  lastPrune: ConsolePruneResult | null
}

/** 自动清理的规则 */
export interface ConsoleLimits {
  /** 自动清理开没开 */
  autoDelete: boolean
  /** 总占用上限（字节）。0 = 不限制 */
  maxTotalBytes: number
  /** 至少保留最近多少条 */
  keepRecent: number
  /** 保留时长（天）—— 写死的规则，不是设置项 */
  retentionDays: number
}

/** 一次清理的结果 */
export interface ConsolePruneResult {
  /** 删了几条 */
  deleted: number
  /** 释放了多少字节 */
  freedBytes: number
  /** 什么时候清的（毫秒时间戳） */
  at: number
}

/** 数组里一项的骨架 —— 不含正文，点开才去取 */
export interface ConsoleItemSkeleton {
  index: number
  /** 角色或类型；取不到就是空串 */
  role: string
  preview: string
  bytes: number
}

/** 一个节点的骨架：不含被拆开的数组 */
export interface ConsoleShell {
  /** 节点名：meta / transcript / provider / response */
  node: string
  /** 被拆开的数组：键名、条数、每条的骨架 */
  array: { key: string; count: number; items: ConsoleItemSkeleton[] } | null
  /** 不属于数组、但单独拆出来的条目（比如响应里的那条助手消息） */
  items: ConsoleItemSkeleton[]
  /** 这个节点自身的字段（不含被拆开的数组） */
  fields: Record<string, unknown>
  /** 节点的路径；数组元素的路径更长 */
  path: string
  bytes: number
}

/** 取一个字段的结果 */
export interface ConsoleFieldResult {
  /** 路径 */
  path: string
  /** 骨架（节点或数组元素） */
  shell?: ConsoleShell
  /** 完整取值（叶子节点） */
  value?: unknown
  /** 太大了，不能进界面 */
  oversize?: boolean
  bytes?: number
  error?: string
}

/** 导出范围 */
export type ConsoleExportScope = 'record' | 'records' | 'sessions' | 'all'

export interface ConsoleExportRequest {
  scope: ConsoleExportScope
  /** scope = 'record' 时的记录 id */
  recordId?: string
  /** scope = 'records' 时的记录 id 列表（界面上勾选的那些） */
  recordIds?: string[]
  /** scope = 'sessions' 时的会话 id 列表 */
  sessionIds?: string[]
}

export interface ConsoleExportProgress {
  jobId: string
  state: 'running' | 'done' | 'cancelled' | 'failed'
  done: number
  total: number
  bytes: number
  /** 写到哪里了 */
  path?: string
  message?: string
}

export interface ConsoleExportResult {
  ok: boolean
  jobId: string
  path?: string
  bytes?: number
  cancelled?: boolean
  message?: string
}

/** 主进程 → 渲染进程的控制台事件 */
export type ConsoleEvent =
  | { type: 'updated'; stats: ConsoleStats }
  | { type: 'export'; progress: ConsoleExportProgress }
