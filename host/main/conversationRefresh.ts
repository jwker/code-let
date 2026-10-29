/**
 * 对话列表的刷新时机 —— 纯逻辑，主进程用。
 *
 * 对话列表不是从内存里攒的，而是每次从磁盘上的会话文件重读
 * （Pi 的会话文件是权威，见 PLAN.md D7）。
 *
 * 所以判据只有一个：**磁盘上的会话文件有没有变**。
 *
 * - 用户消息落盘：新会话的 .jsonl 这时才第一次出现
 *   （SDK 的 _hasConversation()：没说过话的会话不建文件）。
 *   漏了这一条，新会话就永远不进列表 —— 直到下一次别的操作顺手刷新。
 * - 一轮结束（agent_settled）：最后一条消息写完了，
 *   排序用的 modified（取最后一条消息的时间）才是最终值。
 * - 改名 / 追加条目：标题和内容变了。
 *
 * 事件名取自 Pi SDK（host/main/pi/runtime.ts 只转不改）。
 */

export interface PiEventLike {
  type: string
  data: unknown
}

/** 从 message_end 的载荷里取消息角色 */
function roleOf(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const message = (data as { message?: { role?: unknown } }).message
  if (!message || typeof message !== 'object') return undefined
  return typeof message.role === 'string' ? message.role : undefined
}

/**
 * 这个事件会不会改动磁盘上的会话文件 —— 也就是对话列表要不要重读。
 *
 * 只认用户消息：助手消息和工具结果写的是同一个文件，
 * 用户消息那一收就够了（助手消息一定跟在用户消息后面）。
 */
export function affectsConversationList(event: PiEventLike): boolean {
  switch (event.type) {
    case 'message_end':
      return roleOf(event.data) === 'user'
    case 'agent_settled':
      return true
    case 'entry_appended':
    case 'session_info_changed':
      return true
    default:
      return false
  }
}

/**
 * 去抖刷新。
 *
 * 一次刷新要把整个会话目录重读一遍，一轮对话里能落下好几条消息 ——
 * 每次都扫一遍太浪费，所以合并成一次。
 *
 * 延后这一点还有个更重要的作用：Pi 是**先发事件、后写盘**的
 * （message_end 事件抛出来的时候，消息还没写进会话文件）。
 * 立刻去读会读到旧列表 —— 新会话又不见了。
 */
export class DebouncedRefresh {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly run: () => void | Promise<void>,
    private readonly delay = 100
  ) {}

  /** 请求一次刷新 —— 窗口内的重复请求合并成一次 */
  schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, this.delay)
  }

  /** 窗口内还有没有排着的刷新 */
  get pending(): boolean {
    return this.timer !== null
  }

  /** 丢掉排着的刷新（退出时用，别让定时器吊着进程） */
  dispose(): void {
    if (!this.timer) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
