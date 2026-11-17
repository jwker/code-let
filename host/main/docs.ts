import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { DocEntry, DocGroup, DocsResult } from '@contract/index'

/**
 * AI 文档清单（PLAN.md D52 / R38）。
 *
 * 不写死「有哪几组」—— 扫 `.ai/` 下的每个子目录当一组，再加上项目根的 `AGENTS.md`。
 * 这样新开一个 `.ai/artifacts` 之类，不用改代码就能出现在列表里。
 *
 * **只读**：这个模块只列目录和读元信息，不写任何东西。
 */

/** 只列这些扩展名 —— 文档区不是文件树，不该把图片、压缩包都塞进来 */
const DOC_EXT = new Set(['.md', '.html', '.htm', '.txt', '.json', '.yml', '.yaml'])

/** 一个组最多列这么多条 —— 再多就该进文件树找了 */
const MAX_PER_GROUP = 200

/** 递归深度上限：`.ai/` 下一般只有一层，留两层给 design/screenshots 这类 */
const MAX_DEPTH = 2

function extOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index < 0 ? '' : name.slice(index).toLowerCase()
}

/** 读一个文件那一行的元信息；读不到就当不存在 */
async function entryOf(cwd: string, full: string): Promise<DocEntry | null> {
  try {
    const info = await stat(full)
    if (!info.isFile()) return null
    const relPath = relative(cwd, full).split(sep).join('/')
    return {
      path: full,
      relPath,
      name: full.split(sep).pop() ?? relPath,
      size: info.size,
      modified: info.mtimeMs
    }
  } catch {
    return null
  }
}

/** 递归收集一个目录下的文档 */
async function walk(cwd: string, dir: string, depth: number): Promise<DocEntry[]> {
  if (depth > MAX_DEPTH) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out: DocEntry[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const info = await stat(full).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) {
      out.push(...(await walk(cwd, full, depth + 1)))
      continue
    }
    if (!DOC_EXT.has(extOf(name))) continue
    const entry = await entryOf(cwd, full)
    if (entry) out.push(entry)
  }
  return out
}

/** 最近改的排前面 —— 刚写的那份通常就是你要找的 */
function byModified(a: DocEntry, b: DocEntry): number {
  return b.modified - a.modified
}

/**
 * 列出一个项目的 AI 文档。
 *
 * 组顺序固定：先 `AGENTS.md`（跨项目的那份约定），再按目录名排 `planning / design / docs / …`。
 * 空组不返回 —— 一个空标题比没有它更让人困惑。
 */
export async function listDocs(cwd: string): Promise<DocsResult> {
  if (!cwd) return { groups: [], truncated: false }

  const groups: DocGroup[] = []
  let truncated = false

  // 根目录的项目说明 —— Pi 读的就是它（AGENTS.md）
  const agentsFile = join(cwd, 'AGENTS.md')
  if (existsSync(agentsFile)) {
    const entry = await entryOf(cwd, agentsFile)
    if (entry) groups.push({ title: '项目说明', entries: [entry] })
  }

  const aiDir = join(cwd, '.ai')
  if (existsSync(aiDir)) {
    const names = await readdir(aiDir).catch(() => [] as string[])
    const dirs: string[] = []
    for (const name of names) {
      if (name.startsWith('.')) continue
      const info = await stat(join(aiDir, name)).catch(() => null)
      if (info?.isDirectory()) dirs.push(name)
    }
    // planning 在最前，其余按名字排 —— 计划是「现在做什么」，最常看
    dirs.sort((a, b) => (a === 'planning' ? -1 : b === 'planning' ? 1 : a.localeCompare(b)))

    for (const name of dirs) {
      const entries = (await walk(cwd, join(aiDir, name), 0)).sort(byModified)
      if (entries.length === 0) continue
      if (entries.length > MAX_PER_GROUP) {
        truncated = true
        groups.push({ title: name, entries: entries.slice(0, MAX_PER_GROUP) })
      } else {
        groups.push({ title: name, entries })
      }
    }
  }

  return { groups, truncated }
}
