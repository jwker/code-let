import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PreviewEntry, PrototypeFile, PrototypeListing } from '@contract/index'

/**
 * 原型目录：没有可恢复的预览地址时，从这里挑一个页面。
 *
 * 规矩（票 03）：
 * - 只列**顶层**的 `.html` / `.htm`，不递归、忽略大小写；
 * - 按修改时间倒序，同一时刻按名字；
 * - 目录不存在和目录空着都算「没有可预览的原型」，但要分开告诉用户。
 *
 * 目录只读，不创建 —— 由 agent 写文件时自然出现。
 */

/** 文件名是不是原型（`.html` / `.htm`，忽略大小写） */
export function isPrototypeFileName(name: string): boolean {
  const lower = name.toLowerCase()
  // 名字本身就叫 `.html` 的是隐藏文件，不是页面
  if (lower === '.html' || lower === '.htm') return false
  return lower.endsWith('.html') || lower.endsWith('.htm')
}

/**
 * 目录里的条目 → 原型文件清单：过滤、拼绝对路径与 `file:` 地址、排序。
 *
 * 排完之后新的在前；同一毫秒写出来的按名字，保证顺序稳定。
 */
export function prototypeFilesFrom(
  entries: Array<{ name: string; modified: number }>,
  dir: string
): PrototypeFile[] {
  return entries
    .filter((entry) => isPrototypeFileName(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name)
      return {
        name: entry.name,
        path,
        url: pathToFileURL(path).toString(),
        modified: entry.modified
      }
    })
    .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))
}

/** 读一个目录的原型清单；目录不在就 `exists: false` */
export async function listPrototypeFiles(dir: string): Promise<PrototypeListing> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return { dir, exists: false, files: [] }
  }

  const entries: Array<{ name: string; modified: number }> = []
  for (const name of names) {
    if (!isPrototypeFileName(name)) continue
    try {
      const info = await stat(join(dir, name))
      if (!info.isFile()) continue
      entries.push({ name, modified: info.mtimeMs })
    } catch {
      // 坏掉的符号链接之类 —— 跳过这一条，不让它毁掉整张列表
    }
  }
  return { dir, exists: true, files: prototypeFilesFrom(entries, dir) }
}

/** 预览该怎么显示：记录有效就恢复，否则列目录，目录里也没有就空态 */
export function choosePreviewEntry(
  usableUrl: string | null,
  listing: PrototypeListing
): PreviewEntry {
  if (usableUrl) return { kind: 'restore', url: usableUrl }
  return listing.files.length > 0 ? { kind: 'list', listing } : { kind: 'empty', listing }
}
