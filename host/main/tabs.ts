import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * 标签列表的落盘与恢复（PLAN.md D4 修订）。
 *
 * 归宿主，存 userData。标签顺序、每个标签指哪个会话，都记在这儿。
 *
 * **会话文件不在了的标签，恢复时会被挑出去** —— 内容就在会话文件里，
 * 文件没了内容也没了，没有可恢复的东西。
 */

/** 落盘的一条标签 */
export interface StoredTab {
  /** 标签自己的 id —— 宿主发的，稳定的身份 */
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
  tabs: StoredTab[]
  /** 打开的文件（切片 2 加的） */
  files?: StoredFile[]
  /** 当前活动的文件 */
  activeFileId?: string | null
}

export class TabStore {
  private readonly file: string
  private tabs: StoredTab[] = []
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
        this.tabs = raw.tabs.filter(
          (t): t is StoredTab =>
            typeof t?.id === 'string' && typeof t?.cwd === 'string' && typeof t?.title === 'string'
        )
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
      this.files = []
      this.activeFileId = null
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(
        this.file,
        JSON.stringify({ tabs: this.tabs, files: this.files, activeFileId: this.activeFileId }, null, 2),
        'utf8'
      )
    } catch {
      // 写不进去也不能影响主流程
    }
  }

  list(): StoredTab[] {
    return this.tabs
  }

  /** 存下当前的标签列表（顺序即标签栏的顺序） */
  saveTabs(tabs: StoredTab[]): void {
    this.tabs = tabs
    this.save()
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
