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

interface TabsFile {
  tabs: StoredTab[]
}

export class TabStore {
  private readonly file: string
  private tabs: StoredTab[] = []

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
    } catch {
      // 索引坏了就当空的，不删用户数据
      this.tabs = []
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ tabs: this.tabs }, null, 2), 'utf8')
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
}
