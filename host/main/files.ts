import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FileContent, FileEntry, FileSearchResult } from '@contract/index'

/**
 * 文件系统 —— 列目录、读文件，以及**路径越界校验**（PLAN.md D20 / R26）。
 *
 * 所有对外函数都要求传 `cwd`（项目根），内部把目标路径解析成绝对路径之后
 * 校验它仍在 `cwd` 之内。渲染进程永远不直接碰 fs。
 */

/** 超过这个大小不渲染内容，只给提示 */
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024

/** 读多少字节来判断是不是二进制 */
const SNIFF_BYTES = 8192

/** 这些扩展名直接当图片读成 data URL */
const IMAGE_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif'
}

/** 请求的路径跑到项目目录外面了 */
export class PathOutsideCwdError extends Error {
  constructor(requested: string, cwd: string) {
    super(`路径不在项目目录内：${requested}（项目根：${cwd}）`)
    this.name = 'PathOutsideCwdError'
  }
}

/**
 * 纯字符串的越界校验：把 `target` 解析成绝对路径，确认它仍在 `root` 之内。
 *
 * 拒绝两种：`../` 越界、绝对路径指向别处。
 * 用 `relative()` 判断而不是字符串前缀 —— 前缀判断会把 `/a/bc` 当成 `/a/b` 的子路径。
 *
 * **这个函数挡不住符号链接** —— `root/link -> /etc` 时，`link/passwd` 在字符串上
 * 看着在 root 里。要挡链接用 `resolveInsideCwd`（异步，带 realpath）。
 */
function assertInside(root: string, full: string, requested: string): void {
  const rel = relative(root, full)
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new PathOutsideCwdError(requested, root)
  }
}

/**
 * 校验并解析出真实路径 —— **同时挡住 `../` 和符号链接**。
 *
 * 两步：
 * 1. 字符串校验（挡住 `../`、绝对路径）
 * 2. `realpath` 之后再用**真实的 root** 校验一次（挡住指向外面的符号链接）
 *
 * 路径不存在时 realpath 会抛 —— 那种情况下字符串校验已经够了（反正也读不到）。
 */
export async function resolveInsideCwd(cwd: string, target: string): Promise<string> {
  const full = isAbsolute(target) ? resolve(target) : resolve(resolve(cwd), target)
  // 先做字符串校验，避免对明显越界的路径去 stat
  assertInside(resolve(cwd), full, target)

  /*
   * 只把 realpath 的失败吞掉 —— **校验抛的错必须传播出去**。
   * 早先把 assertInside 写在 try 里，它抛的 PathOutsideCwdError 被 catch 一起吞了，
   * 符号链接越界就这么漏过去了。
   */
  let realRoot: string | null = null
  let realFull: string | null = null
  try {
    realRoot = await realpath(resolve(cwd))
    realFull = await realpath(full)
  } catch {
    // 路径不存在（或 cwd 本身不在）—— 字符串校验过了就放行，后续 fs 操作会自己报错
  }
  if (realRoot !== null && realFull !== null) assertInside(realRoot, realFull, target)

  /*
   * 返回的是**调用方传入路径的绝对形式**，不是 realpath 的结果。
   *
   * 为什么不返回 realpath：macOS 上 `/var` 是 `/private/var` 的符号链接，
   * realpath 会把前缀改掉。同一个文件因此会有两种写法，去重、缓存、
   * 跟 FileTab.path 对不上 —— 校验用 realpath 就够，返回值保持原样。
   */
  return full
}

/**
 * 列一个目录下的条目。
 *
 * 文件夹在前、按名字；文件在后、按名字。隐藏文件照常列（`.git` `.env` 这些是配置，
 * 用户可能就是想看它们）。
 */
export async function listDirectory(cwd: string, dir: string): Promise<FileEntry[]> {
  const full = await resolveInsideCwd(cwd, dir)
  const entries = await readdir(full, { withFileTypes: true })

  const items: FileEntry[] = []
  for (const entry of entries) {
    // 符号链接按「指向什么」算，避免把目录当成文件
    let isDir = entry.isDirectory()
    let size: number | undefined
    if (entry.isSymbolicLink()) {
      try {
        const info = await stat(resolve(full, entry.name))
        isDir = info.isDirectory()
        if (!isDir) size = info.size
      } catch {
        // 断链 —— 当文件列出来，点开时会报错，但不至于整棵树列不出来
        isDir = false
      }
    } else if (!isDir) {
      try {
        size = (await stat(resolve(full, entry.name))).size
      } catch {
        // 拿不到大小就算了
      }
    }
    items.push({ name: entry.name, kind: isDir ? 'dir' : 'file', size })
  }

  // 顺手标一下哪些被 .gitignore 命中 —— 界面会置灰，但仍然显示
  const rules = await gitignoreRules(cwd)
  if (rules.length > 0) {
    for (const item of items) {
      const rel = dir ? `${dir}/${item.name}` : item.name
      if (isIgnoredPath(rules, rel, item.kind === 'dir')) item.ignored = true
    }
  }

  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return items
}

/** 一条相对路径是否被 `.gitignore` 命中；目录规则也匹配目录本身 */
function isIgnoredPath(rules: RegExp[], rel: string, isDir: boolean): boolean {
  return rules.some((re) => re.test(rel) || (isDir && re.test(`${rel}/`)))
}

/**
 * 名字匹配打分 —— 越大越靠前，-1 表示不匹配。
 *
 * 先看文件名本身，再看整条路径；最后允许子序列（`s/i/t` 命中 `src/index.ts`）。
 */
function fileMatchScore(path: string, query: string): number {
  const p = path.toLowerCase()
  const q = query.toLowerCase()
  const base = p.slice(p.lastIndexOf('/') + 1)
  if (base === q) return 100
  if (base.startsWith(q)) return 80
  if (base.includes(q)) return 60
  if (p.startsWith(q)) return 50
  if (p.includes(q)) return 40
  let at = 0
  for (const ch of p) {
    if (ch === q[at]) at += 1
    if (at === q.length) return 20
  }
  return -1
}

/** 搜索索引重新扫描的最长间隔 */
const SEARCH_INDEX_TTL_MS = 10_000
/** 建索引的遍历上限 —— 跟旧版搜索上限一致，避免在大仓库里卡死 */
const MAX_INDEX_DIRS = 2000
const MAX_INDEX_DEPTH = 12
const MAX_INDEX_ENTRIES = 50_000
const MAX_CACHED_INDEXES = 20

interface SearchIndexEntry {
  path: string
  kind: FileSearchResult['kind']
  ignored: boolean
}

interface SearchIndex {
  entries: SearchIndexEntry[]
}

const searchIndexCache = new Map<string, { index: SearchIndex; at: number }>()
const searchIndexBuilds = new Map<string, Promise<SearchIndex>>()

/** 搜索请求被取消时用它中断等待；索引构建本身继续，下次查询直接复用 */
class SearchAbortedError extends Error {
  constructor() {
    super('搜索已取消')
  }
}

function abortSignalPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new SearchAbortedError())
      return
    }
    signal.addEventListener('abort', () => reject(new SearchAbortedError()), { once: true })
  })
}

/**
 * 建一份项目文件索引。
 *
 * 一次遍历把路径、类型、是否被 `.gitignore` 命中都记下来；后续每次输入只做内存匹配。
 * 不进被忽略的目录，`.git` 跳过；其他隐藏文件照常收。
 */
async function buildSearchIndex(cwd: string, root: string): Promise<SearchIndex> {
  const rules = await gitignoreRules(cwd)
  const entries: SearchIndexEntry[] = []
  const stack: Array<{ dir: string; rel: string; depth: number }> = [{ dir: root, rel: '', depth: 0 }]
  let visited = 0

  while (stack.length > 0 && visited < MAX_INDEX_DIRS && entries.length < MAX_INDEX_ENTRIES) {
    const current = stack.pop()
    if (!current) break
    let items
    try {
      items = await readdir(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    visited += 1
    items.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of items) {
      if (entry.name === '.git') continue
      const childRel = current.rel ? `${current.rel}/${entry.name}` : entry.name
      const kind: FileSearchResult['kind'] = entry.isDirectory() ? 'dir' : 'file'
      const ignored = isIgnoredPath(rules, childRel, kind === 'dir')
      entries.push({ path: childRel, kind, ignored })
      if (entries.length >= MAX_INDEX_ENTRIES) break

      // 忽略的目录不进入 —— 尊重 gitignore，也避免走进 node_modules
      if (kind === 'dir' && !ignored && current.depth < MAX_INDEX_DEPTH) {
        stack.push({
          dir: resolve(current.dir, entry.name),
          rel: childRel,
          depth: current.depth + 1
        })
      }
    }
  }

  return { entries }
}

/** 取项目索引：TTL 内复用；同一个项目的并发请求共用一次构建 */
async function getSearchIndex(cwd: string, root: string): Promise<SearchIndex> {
  const key = resolve(cwd)
  const cached = searchIndexCache.get(key)
  if (cached && Date.now() - cached.at < SEARCH_INDEX_TTL_MS) return cached.index

  const pending = searchIndexBuilds.get(key)
  if (pending) return pending

  const build = buildSearchIndex(cwd, root)
    .then((index) => {
      // 简单的容量上限：超过就淘汰最早写入的那份
      if (searchIndexCache.size >= MAX_CACHED_INDEXES) {
        const oldest = [...searchIndexCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) searchIndexCache.delete(oldest[0])
      }
      searchIndexCache.set(key, { index, at: Date.now() })
      searchIndexBuilds.delete(key)
      return index
    })
    .catch((error) => {
      searchIndexBuilds.delete(key)
      throw error
    })

  searchIndexBuilds.set(key, build)
  return build
}

/** 文件变动后手动丢掉索引；不传 cwd 时清空全部（测试和以后的刷新入口用） */
export function invalidateFileSearchIndex(cwd?: string): void {
  if (cwd) searchIndexCache.delete(resolve(cwd))
  else searchIndexCache.clear()
}

/**
 * `@` 搜索：按名字/路径找文件和目录。
 *
 * 规则：
 * - 空 query 只列项目根的一层（不递归，也不建索引）。
 * - 非空 query 先确保项目索引存在，之后在内存里匹配；不再每次输入都扫盘。
 * - 索引按项目缓存 10 秒；超过 TTL 或调用 `invalidateFileSearchIndex()` 后重建。
 * - 不进入被 `.gitignore` 忽略的目录；忽略的文件命中仍然返回，排在后面。
 * - 隐藏文件照常搜（`.git` 目录除外）。
 * - 传入 `signal` 时，取消只中断这次等待；索引构建会继续，下一次查询直接复用。
 */
export async function searchFiles(
  cwd: string,
  query: string,
  limit: number,
  signal?: AbortSignal
): Promise<FileSearchResult[]> {
  if (signal?.aborted) return []

  const root = await resolveInsideCwd(cwd, '.')
  const q = query.trim()

  // 空查询只读根目录一层 —— 比为了列目录先建全量索引快得多
  if (!q) {
    const items = await listDirectory(cwd, '')
    return items.slice(0, limit).map((item) => ({
      path: item.name,
      kind: item.kind,
      ...(item.ignored ? { ignored: true } : {})
    }))
  }

  if (signal?.aborted) return []

  let index: SearchIndex
  try {
    index = signal
      ? await Promise.race([getSearchIndex(cwd, root), abortSignalPromise(signal)])
      : await getSearchIndex(cwd, root)
  } catch (error) {
    if (error instanceof SearchAbortedError) return []
    throw error
  }
  if (signal?.aborted) return []

  const candidates: Array<FileSearchResult & { score: number }> = []
  for (const entry of index.entries) {
    const score = fileMatchScore(entry.path, q)
    if (score >= 0) {
      candidates.push({
        path: entry.path,
        kind: entry.kind,
        ...(entry.ignored ? { ignored: true } : {}),
        score
      })
    }
  }

  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      Number(Boolean(a.ignored)) - Number(Boolean(b.ignored)) ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path)
  )

  return candidates.slice(0, limit).map(({ score: _score, ...rest }) => rest)
}

/**
 * 把一条 `.gitignore` 规则转成正则。
 *
 * 只支持最常用的语法：`*`（不跨 `/`）、`**`（跨目录）、`?`、`!` 取反、结尾 `/` 表示目录。
 * 完整实现（字符类 `[abc]`、转义）没做 —— 够挡住 `node_modules/`、`dist/` 这些常见的就行，
 * 反正命中也只是置灰，不是不显示。
 */
function gitignoreToRegex(pattern: string): RegExp | null {
  let p = pattern.trimEnd()
  if (p === '' || p.startsWith('#')) return null

  // 结尾的 / 表示只匹配目录 —— 但我们不知道目标是不是目录，按「名字后面是 / 或者结尾」处理
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.slice(0, -1)

  // 开头没有 /、中间也没有 / 的规则，匹配任意层的同名文件（gitignore 的规矩）
  const anchored = p.startsWith('/') || p.includes('/')
  if (p.startsWith('/')) p = p.slice(1)

  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i += 1
        // **/ 也要吃掉后面的斜杠
        if (p[i + 1] === '/') i += 1
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }

  // 不锚定的话允许前面有任意层目录
  const prefix = anchored ? '^' : '(?:^|/)'
  // 目录规则匹配它自己或它下面的所有东西
  const suffix = dirOnly ? '(?:/.*)?$' : '$'
  try {
    return new RegExp(prefix + re + suffix)
  } catch {
    return null
  }
}

/** `.gitignore` 的规则缓存 —— 按 cwd 存，避免每次列目录都读一遍 */
const gitignoreCache = new Map<string, { mtime: number; rules: RegExp[] }>()

/**
 * 读项目根的 `.gitignore`，返回编译好的规则。
 *
 * 只读根目录那一份，不处理嵌套的 `.gitignore`（子目录里的）——
 * 那种要记「哪条规则相对哪个目录」，复杂度上去了，收益是把少数文件也置灰。
 */
async function gitignoreRules(cwd: string): Promise<RegExp[]> {
  const file = resolveInside(cwd, '.gitignore')
  if (!existsSync(file)) return []
  try {
    const info = await stat(file)
    const cached = gitignoreCache.get(cwd)
    if (cached && cached.mtime === info.mtimeMs) return cached.rules
    const text = await readFile(file, 'utf8')
    const rules = text
      .split('\n')
      .map(gitignoreToRegex)
      .filter((r): r is RegExp => r !== null)
    gitignoreCache.set(cwd, { mtime: info.mtimeMs, rules })
    return rules
  } catch {
    return []
  }
}

/** 纯字符串形式的「在 cwd 之内」—— 不做 realpath，给只拼路径用 */
function resolveInside(cwd: string, target: string): string {
  return isAbsolute(target) ? resolve(target) : resolve(resolve(cwd), target)
}

/** 前 SNIFF_BYTES 字节里有没有 NUL —— 有就当二进制 */
function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES)
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true
  }
  return false
}

/**
 * 读一个文件。
 *
 * 三种结果：
 * - 图片 → data URL
 * - 文本 → 文本（可能被判定为二进制，也可能因为太大不带内容）
 * - 其他 → unsupported
 */
export async function readFileContent(cwd: string, path: string): Promise<FileContent> {
  const full = await resolveInsideCwd(cwd, path)
  const info = await stat(full)

  if (info.isDirectory()) {
    return { kind: 'unsupported', reason: '这是一个目录' }
  }

  const size = info.size
  const ext = extname(full).toLowerCase()

  // 图片：读成 data URL。太大也不给 —— data URL 会撑爆 IPC
  const mime = IMAGE_EXT[ext]
  if (mime) {
    if (size > MAX_PREVIEW_BYTES) {
      return { kind: 'unsupported', reason: `图片太大（${formatSize(size)}），不预览`, size }
    }
    const buffer = await readFile(full)
    return { kind: 'image', dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, size }
  }

  // 太大：不读内容，只给提示
  if (size > MAX_PREVIEW_BYTES) {
    return {
      kind: 'text',
      text: '',
      lines: 0,
      binary: false,
      tooLarge: true,
      size
    }
  }

  const buffer = await readFile(full)
  if (looksBinary(buffer)) {
    return {
      kind: 'text',
      text: '',
      lines: 0,
      binary: true,
      tooLarge: false,
      size
    }
  }

  const text = buffer.toString('utf8')
  return {
    kind: 'text',
    text,
    // 末尾的换行不算多一行
    lines: text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
    binary: false,
    tooLarge: false,
    size
  }
}

/** 给提示用的可读大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
