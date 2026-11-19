import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { ProjectInfo } from '@contract/index'

/**
 * 「我选的项目」清单（PLAN.md D4 修订）。
 *
 * **Pi 的会话文件一个字都不动。** 这里存的只是「Codelet 要显示哪几个目录」——
 * 移除一个项目 = 从这张表里去掉一行，对话还在磁盘上，Pi 自己照常能读，
 * 重新「打开项目」指到同一个目录就回来了。
 *
 * 跟以前那份「最近项目」用的是同一个文件（userData/projects.json）。文件格式
 * 从「一串路径」升级成「一条记录带可选字段」，**旧的纯字符串数组照样能读**。
 *
 * 不再按「最近 20 个」自动挤掉最旧的 —— 这张表是用户自己维护的，
 * 静默删条目不行（PLAN.md 底线 2）。
 */

/** 默认的原型图目录：项目内的相对路径 */
export const DEFAULT_PROTOTYPE_DIR = '.codelet/prototype'

/** 原型图目录的校验结果：要么是规范化后的相对路径，要么是一句原因 */
export type PrototypeDirCheck =
  | { dir: string; error?: undefined }
  | { dir?: undefined; error: string }

/**
 * 校验「原型图目录」：必须是项目内的相对路径。
 *
 * - 空串（或只有空白）按默认值；
 * - 绝对路径、解析后跑出项目的 `..` 都拒绝；
 * - 项目根本身（`.`）是合法的 —— 只是把项目根当成原型目录。
 *
 * 只做字符串与路径运算，**不碰磁盘**：目录不存在是合法的，
 * 由 agent 写文件时自然创建。
 */
export function normalizePrototypeDir(
  cwd: string,
  input: string | null | undefined
): PrototypeDirCheck {
  const raw = (input ?? '').trim()
  if (!raw) return { dir: DEFAULT_PROTOTYPE_DIR }
  if (raw.length > 200) return { error: '原型图目录太长了（最多 200 个字符）' }
  if (isAbsolute(raw)) return { error: '原型图目录必须是项目内的相对路径' }
  const target = resolve(cwd, raw)
  const rel = relative(cwd, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { error: '原型图目录必须在这个项目里' }
  }
  // 存成和平台无关的相对路径（Windows 上也不过是把分隔符统一成 /）
  return { dir: rel ? rel.split(sep).join('/') : '.' }
}

/** 落盘的一个项目 */
interface StoredProject {
  /** 绝对路径 */
  path: string
  /** 原型图目录（项目内相对路径）；没设置过就没有这个字段 */
  prototypeDir?: string
}

interface ProjectsFile {
  /** 2 = 记录数组；没有或者更早 = 纯字符串数组 */
  version?: number
  projects: Array<string | StoredProject>
}

export class ProjectStore {
  private readonly file: string
  private projects: StoredProject[] = []

  constructor(file?: string) {
    this.file = file ?? join(app.getPath('userData'), 'projects.json')
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as ProjectsFile
      if (!Array.isArray(raw?.projects)) return
      this.projects = raw.projects.flatMap((item) => {
        // 旧格式：一条路径就是一个项目
        const record = typeof item === 'string' ? { path: item } : item
        if (!record || typeof record !== 'object') return []
        if (typeof record.path !== 'string' || record.path === '') return []
        const dir = (record as StoredProject).prototypeDir
        return [
          {
            path: record.path,
            ...(typeof dir === 'string' && dir ? { prototypeDir: dir } : {})
          }
        ]
      })
    } catch {
      // 清单坏了就当空的，不删用户数据
      this.projects = []
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const payload: ProjectsFile = {
        version: 2,
        projects: this.projects.map((project) => ({
          path: project.path,
          ...(project.prototypeDir ? { prototypeDir: project.prototypeDir } : {})
        }))
      }
      writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8')
    } catch {
      // 写不进去也不能影响主流程
    }
  }

  /**
   * 一条落盘记录 → 推给渲染层的形状。
   *
   * 手改坏的原型目录按默认值读 —— 不因为一个字段把整个项目丢掉。
   */
  private info(project: StoredProject): ProjectInfo {
    const checked = normalizePrototypeDir(project.path, project.prototypeDir)
    return {
      path: project.path,
      name: basename(project.path) || project.path,
      prototypeDir: checked.dir ?? DEFAULT_PROTOTYPE_DIR
    }
  }

  /** 清单里的项目，按添加次序（新的在前） */
  list(): ProjectInfo[] {
    return this.projects.map((project) => this.info(project))
  }

  /** 清单里有没有这个目录 */
  has(path: string): boolean {
    return this.projects.some((project) => project.path === normalize(path))
  }

  /** 加一个项目（已经在清单里就只把它挪到前面，别的字段不动） */
  add(path: string): ProjectInfo {
    const normalized = normalize(path)
    const existing = this.projects.find((project) => project.path === normalized)
    const record: StoredProject = existing ? existing : { path: normalized }
    this.projects = [record, ...this.projects.filter((project) => project.path !== normalized)]
    this.save()
    return this.info(record)
  }

  /**
   * 设置一个项目的原型图目录。
   *
   * 传进来的值应当已经过 `normalizePrototypeDir`；清单里没有这个项目就什么都不做。
   */
  setPrototypeDir(path: string, dir: string): void {
    const normalized = normalize(path)
    const index = this.projects.findIndex((project) => project.path === normalized)
    if (index < 0) return
    this.projects[index] = { ...this.projects[index], prototypeDir: dir }
    this.save()
  }

  /**
   * 从清单里去掉一个项目。
   *
   * **只动这张表** —— 磁盘上的会话文件原样保留。
   */
  remove(path: string): void {
    const normalized = normalize(path)
    const next = this.projects.filter((project) => project.path !== normalized)
    if (next.length === this.projects.length) return
    this.projects = next
    this.save()
  }
}
