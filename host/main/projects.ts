import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, normalize } from 'node:path'
import type { ProjectInfo } from '@contract/index'

/**
 * 「我选的项目」清单（PLAN.md D4 修订）。
 *
 * **Pi 的会话文件一个字都不动。** 这里存的只是「Codelet 要显示哪几个目录」——
 * 移除一个项目 = 从这张表里去掉一行，对话还在磁盘上，Pi 自己照常能读，
 * 重新「打开项目」指到同一个目录就回来了。
 *
 * 跟以前那份「最近项目」用的是同一个文件（userData/projects.json）、同一个格式，
 * 所以已有的清单直接能用。
 *
 * 不再按「最近 20 个」自动挤掉最旧的 —— 这张表是用户自己维护的，
 * 静默删条目不行（PLAN.md 底线 2）。
 */

interface ProjectsFile {
  projects: string[]
}

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
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as ProjectsFile
      if (Array.isArray(raw?.projects)) {
        this.projects = raw.projects.filter((p): p is string => typeof p === 'string' && p.length > 0)
      }
    } catch {
      // 清单坏了就当空的，不删用户数据
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

  /** 清单里的项目，按添加次序（新的在前） */
  list(): ProjectInfo[] {
    return this.projects.map((path) => ({ path, name: basename(path) || path }))
  }

  /** 清单里有没有这个目录 */
  has(path: string): boolean {
    return this.projects.includes(normalize(path))
  }

  /** 加一个项目（已经在清单里就只把它挪到前面） */
  add(path: string): ProjectInfo {
    const normalized = normalize(path)
    this.projects = [normalized, ...this.projects.filter((p) => p !== normalized)]
    this.save()
    return { path: normalized, name: basename(normalized) || normalized }
  }

  /**
   * 从清单里去掉一个项目。
   *
   * **只动这张表** —— 磁盘上的会话文件原样保留。
   */
  remove(path: string): void {
    const normalized = normalize(path)
    const next = this.projects.filter((p) => p !== normalized)
    if (next.length === this.projects.length) return
    this.projects = next
    this.save()
  }
}
