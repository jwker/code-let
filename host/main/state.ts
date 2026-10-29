import { EventEmitter } from 'node:events'
import { normalize } from 'node:path'
import type { ConversationInfo, HostSnapshot, ProjectInfo, SessionState, StreamItem } from '@contract/index'
import { affectsConversationList, DebouncedRefresh } from './conversationRefresh'
import { PiRuntime, type PiRuntimePort } from './pi/runtime'
import { ProjectStore } from './projects'

/**
 * 宿主权威状态（PLAN.md D7）。
 *
 * 渲染进程只是它的投影：状态变化从这里推快照，不从渲染进程回写。
 */
export class HostState extends EventEmitter {
  readonly pi: PiRuntimePort
  private readonly store: ProjectStore
  private currentProject: ProjectInfo | null = null
  private conversations: ConversationInfo[] = []
  private session: SessionState = { ready: false, cwd: null, sessionId: null, error: null }
  /** 去抖刷新：把一轮里的多次刷新合成一次 */
  private readonly conversationsRefresh: DebouncedRefresh
  /** 刷新的序号：只认最后一次发起的 */
  private refreshToken = 0

  /** 运行时和项目存储都能塞进来 —— 真跑要用模型，测不动 */
  constructor(store?: ProjectStore, pi?: PiRuntimePort) {
    super()
    this.store = store ?? new ProjectStore()
    this.pi = pi ?? new PiRuntime()
    this.conversationsRefresh = new DebouncedRefresh(() => this.refreshConversations())
  }

  // ---------------------------------------------------------------------
  // 快照
  // ---------------------------------------------------------------------

  snapshot(): HostSnapshot {
    return {
      projects: this.store.list(),
      currentProject: this.currentProject,
      conversations: this.conversations,
      session: this.session
    }
  }

  private push(): void {
    this.emit('snapshot', this.snapshot())
  }

  // ---------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------

  async init(): Promise<void> {
    // 会话流事件：转发给渲染进程
    this.pi.onEvent((event) => {
      this.emit('session-event', event)
      // 会话文件变了，对话列表要跟着变
      if (affectsConversationList(event)) {
        this.conversationsRefresh.schedule()
      }
    })

    const recent = this.store.list()
    const first = recent[0]?.path ?? process.cwd()
    // 启动时接着上次那个会话跑，不留一堆空会话
    await this.switchProject(first, { remember: recent.length > 0, resume: true })
  }

  // ---------------------------------------------------------------------
  // 项目
  // ---------------------------------------------------------------------

  /** 系统目录选择器：打开新项目 */
  async openProject(): Promise<ProjectInfo | null> {
    const picked = await this.store.pick()
    if (!picked) return null
    this.store.add(picked)
    await this.switchProject(picked, { remember: true })
    return this.currentProject
  }

  /** 切到某个项目（目录） */
  async switchProject(path: string, options?: { remember?: boolean; resume?: boolean }): Promise<void> {
    const dir = normalize(path)
    if (options?.remember) this.store.add(dir)

    this.currentProject = { path: dir, name: basenameOf(dir) }
    this.conversations = []
    this.session = { ready: false, cwd: dir, sessionId: null, error: null }
    this.push()

    try {
      await this.pi.start(dir, { resume: options?.resume })
      this.session = {
        ready: this.pi.ready,
        cwd: this.pi.cwd,
        sessionId: this.pi.currentSessionId,
        error: null
      }
    } catch (error) {
      this.session = {
        ready: false,
        cwd: dir,
        sessionId: null,
        error: error instanceof Error ? error.message : String(error)
      }
    }

    await this.refreshConversations()
  }

  // ---------------------------------------------------------------------
  // 对话
  // ---------------------------------------------------------------------

  /**
   * 重读对话列表（磁盘上的会话文件是权威）。
   *
   * 刷新是异步的（要读盘），两次刷新可能交错返回。
   * 只认最后一次发起的 —— 早发起的那次数据更旧，别让它盖掉新的。
   */
  async refreshConversations(): Promise<void> {
    const cwd = this.currentProject?.path
    if (!cwd) {
      this.conversations = []
      this.push()
      return
    }
    // 刷新是异步的（要读盘），两次刷新可能交错返回。
    // 只认最后一次发起的 —— 早发起的那次数据更旧，别让它盖掉新的。
    const token = ++this.refreshToken
    try {
      const list = await PiRuntime.listConversations(cwd)
      if (token !== this.refreshToken) return
      this.conversations = list
    } catch {
      if (token !== this.refreshToken) return
      this.conversations = []
    }
    this.push()
  }

  /** 在当前项目下新建会话 */
  async newConversation(): Promise<void> {
    await this.pi.newSession()
    this.session = {
      ready: this.pi.ready,
      cwd: this.pi.cwd,
      sessionId: this.pi.currentSessionId,
      error: null
    }
    await this.refreshConversations()
  }

  /** 切到某个已有会话 */
  async switchConversation(path: string): Promise<void> {
    await this.pi.switchSession(path)
    this.session = {
      ready: this.pi.ready,
      cwd: this.pi.cwd,
      sessionId: this.pi.currentSessionId,
      error: null
    }
    await this.refreshConversations()
  }

  /** 往当前会话发一条用户消息 */
  async prompt(text: string): Promise<void> {
    await this.pi.prompt(text)
  }

  /** 当前会话已经说过的话（R1 R5） */
  readEntries(): StreamItem[] {
    return this.pi.readEntries()
  }

  async dispose(): Promise<void> {
    this.conversationsRefresh.dispose()
    await this.pi.stop()
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}
