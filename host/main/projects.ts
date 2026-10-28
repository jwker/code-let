import { app, dialog } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import type { ProjectInfo } from '@contract/index'

const MAX_RECENT = 20

interface RecentProjectsFile {
  projects: string[]
}

/**
 * 最近项目列表（PLAN.md D11）。
 *
 * 归宿主，存 userData。永不自动删除用户数据 —— 只增不减，满了就把最旧的挤掉。
 */
export class ProjectStore {
  private readonly file: string
  private projects: string[] = []

  constructor(file?: string) {
    this.file = file ?? join(app.getPath('userData'), 'projects.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as RecentProjectsFile
      if (Array.isArray(raw?.projects)) {
        this.projects = raw.projects.filter((p): p is string => typeof p === 'string' && p.length > 0)
      }
    } catch {
      // 索引坏了就当空的，不删用户数据
      this.projects = []
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ projects: this.projects }, null, 2), 'utf8')
    } catch {
      // 写不进去也不能影响主流程
    }
  }

  list(): ProjectInfo[] {
    return this.projects.map((path) => ({ path, name: basename(path) || path }))
  }

  /** 把项目排到最前（去重），返回当前顺序 */
  add(path: string): ProjectInfo[] {
    const normalized = normalize(path)
    this.projects = [normalized, ...this.projects.filter((p) => p !== normalized)].slice(0, MAX_RECENT)
    this.save()
    return this.list()
  }

  /** 系统目录选择器 */
  async pick(): Promise<string | null> {
    const result = await dialog.showOpenDialog({
      title: '打开项目',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return normalize(result.filePaths[0])
  }
}
