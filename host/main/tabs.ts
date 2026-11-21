import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { ProjectPaneView, RightPanelState } from '@contract/index'

/**
 * 标签列表的落盘与恢复（PLAN.md D4 修订）。
 *
 * 归宿主，存 userData。标签顺序、每个标签指哪个会话，都记在这儿。
 *
 * **会话文件不在了的标签，恢复时会被挑出去** —— 内容就在会话文件里，
 * 文件没了内容也没了，没有可恢复的东西。
 */

/**
 * 落盘的一条**项目**标签（PLAN.md D50）。
 *
 * 跟 v1 的 `StoredTab` 差在最要紧的一处：v1 的标签背后是一个会话，v2 的背后是一整个项目 ——
 * 所以它记的是「上次在看什么」和「上次看的是哪个 agent」。
 */
export interface StoredProjectTab {
  /** 项目标签的 id，宿主发的 */
  id: string
  /** 项目目录（绝对路径） */
  cwd: string
  /** 标签上显示的名字，默认取目录名 */
  title: string
  /** 上次看的是左列的哪样东西（对话 / 项目设置） */
  pane: ProjectPaneView
  /** 右栏开着没有、开的是哪个功能区 */
  rightPanel: RightPanelState
  /** 上次看的 agent；`pane !== 'agent'` 时也留着 */
  activeAgentId: string | null
}

/**
 * v1 落盘的一条标签 —— 背后是一个 Pi 会话。
 *
 * 只在**迁移**时读：`agents.json` 和 v2 的项目标签都还没有的第一次启动，
 * 用它把老标签转成 agent（PLAN.md D59）。迁移完就不再写这个形状。
 */
export interface StoredTab {
  /** 标签自己的 id */
  id: string
  /** 会话所在目录 */
  cwd: string
  /** 会话文件路径。新会话在第一条用户消息之前还没有文件 */
  path: string | null
  /** 标签显示的标题 */
  title: string
}

/**
 * 落盘的一个文件标签（PLAN.md D21）。
 *
 * 跟会话标签存在**同一个文件**里，但各占一个字段 —— 两种标签的规则完全不同
 * （会话标签有 runtime、关了要确认；文件标签都没有），混在一个数组里会乱。
 */
export interface StoredFile {
  id: string
  /** 文件绝对路径 */
  path: string
  /** 打开那一刻的项目根 */
  cwd: string
  /** 项目内的相对路径 */
  relPath: string
}

interface TabsFile {
  /** 2 = 项目标签；没有 = v1 的会话标签 */
  version?: number
  tabs: Array<StoredProjectTab | StoredTab>
  /** 打开的文件 */
  files?: StoredFile[]
  /** 当前活动的文件 */
  activeFileId?: string | null
}

export class TabStore {
  private readonly file: string
  private tabs: StoredProjectTab[] = []
  /** v1 的标签 —— 只在首次迁移时读一次，之后一直是空的 */
  private legacy: StoredTab[] = []
  private files: StoredFile[] = []
  private activeFileId: string | null = null

  constructor(file?: string) {
    this.file = file ?? join(app.getPath('userData'), 'tabs.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as TabsFile
      if (Array.isArray(raw?.tabs)) {
        if (raw.version === 2) {
          this.tabs = raw.tabs
            .map(normalizeProjectTab)
            .filter((tab): tab is StoredProjectTab => tab !== null)
        } else {
          // v1：留着给迁移用。**不在这里转** —— 转换要连 agents.json 一起写，
          // 那是 HostState 的事，存储层只负责把旧数据端出来
          this.legacy = (raw.tabs as StoredTab[]).filter(
            (t): t is StoredTab =>
              typeof t?.id === 'string' && typeof t?.cwd === 'string' && typeof t?.title === 'string'
          )
        }
      }
      if (Array.isArray(raw?.files)) {
        this.files = raw.files.filter(
          (f): f is StoredFile =>
            typeof f?.id === 'string' &&
            typeof f?.path === 'string' &&
            typeof f?.cwd === 'string' &&
            typeof f?.relPath === 'string'
        )
      }
      this.activeFileId = typeof raw?.activeFileId === 'string' ? raw.activeFileId : null
    } catch {
      // 索引坏了就当空的，不删用户数据
      this.tabs = []
      this.legacy = []
      this.files = []
      this.activeFileId = null
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(
        this.file,
        JSON.stringify(
          { version: 2, tabs: this.tabs, files: this.files, activeFileId: this.activeFileId },
          null,
          2
        ),
        'utf8'
      )
    } catch {
      // 写不进去也不能影响主流程
    }
  }

  /** 落盘文件路径 —— 宿主用它把 `agents.json` 放在同一个目录 */
  get path(): string {
    return this.file
  }

  list(): StoredProjectTab[] {
    return this.tabs
  }

  /** 存下当前的项目标签（顺序即标签栏的顺序） */
  saveTabs(tabs: StoredProjectTab[]): void {
    this.tabs = tabs
    this.save()
  }

  /** v1 的会话标签 —— 迁移用，迁移完就是空的 */
  legacyTabs(): StoredTab[] {
    return this.legacy
  }

  /**
   * 迁移前留一份原件（D59）。
   *
   * 只在 `.bak` 还不存在时写一次 —— 留最原始的那份，不是每次启动都覆盖。
   * 迁坏了可以拿它手工回滚。
   */
  backupLegacy(): void {
    if (!existsSync(this.file)) return
    const target = `${this.file}.bak`
    if (existsSync(target)) return
    try {
      copyFileSync(this.file, target)
    } catch {
      // 备份失败不该挡住启动
    }
  }

  /** 打开的文件（切片 2） */
  listFiles(): StoredFile[] {
    return this.files
  }

  /** 当前活动的文件 */
  activeFile(): string | null {
    return this.activeFileId
  }

  /** 存下文件标签 */
  saveFiles(files: StoredFile[], activeFileId: string | null): void {
    this.files = files
    this.activeFileId = activeFileId
    this.save()
  }
}

/** 右栏状态的形状校验 */
function isRightPanel(value: unknown): value is RightPanelState {
  if (!value || typeof value !== 'object') return false
  const panel = value as Record<string, unknown>
  return (
    typeof panel.open === 'boolean' &&
    (panel.kind === null ||
      panel.kind === 'code' ||
      panel.kind === 'docs' ||
      panel.kind === 'browser')
  )
}

/** 两种落盘形状都有的那几个字段 —— 少一个就当坏的，不拿默认值补出个假标签 */
function hasBaseFields(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false
  const tab = value as Record<string, unknown>
  return (
    typeof tab.id === 'string' &&
    typeof tab.cwd === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.pane === 'string' &&
    (tab.activeAgentId === null || typeof tab.activeAgentId === 'string')
  )
}

/**
 * 读出一条项目标签，顺手把旧版落盘形状归一。
 *
 * 上一版把代码 / 文档 / 浏览器当成左列的入口，那时还没有右栏，旧标签没有
 * `rightPanel` 字段。读出来时把这三个值搬进右栏（展开、功能区对应），左列变回对话；
 * 设置和对话则右栏收起。新形状（有 `rightPanel`）的左列只可能是对话或设置 ——
 * 别的组合只可能是手改坏的。
 *
 * 形状不对的返回 `null`，由调用方丢掉：不拿默认值拼出一个假标签。
 */
function normalizeProjectTab(value: unknown): StoredProjectTab | null {
  if (!hasBaseFields(value)) return null
  const tab = value as unknown as Record<string, unknown>
  if (tab.rightPanel !== undefined) {
    if (!isRightPanel(tab.rightPanel)) return null
    if (tab.pane !== 'agent' && tab.pane !== 'settings') return null
    return {
      id: tab.id as string,
      cwd: tab.cwd as string,
      title: tab.title as string,
      pane: tab.pane,
      rightPanel: tab.rightPanel,
      activeAgentId: tab.activeAgentId as string | null
    }
  }
  const base = {
    id: tab.id as string,
    cwd: tab.cwd as string,
    title: tab.title as string,
    activeAgentId: tab.activeAgentId as string | null
  }
  if (tab.pane === 'code' || tab.pane === 'docs' || tab.pane === 'browser') {
    return { ...base, pane: 'agent', rightPanel: { open: true, kind: tab.pane } }
  }
  if (tab.pane === 'settings') {
    return { ...base, pane: 'settings', rightPanel: { open: false, kind: null } }
  }
  if (tab.pane === 'agent') {
    return { ...base, pane: 'agent', rightPanel: { open: false, kind: null } }
  }
  // 不认识的值 —— 当坏数据
  return null
}
