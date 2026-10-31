import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { FileContent, FileEntry } from '@contract/index'

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
      // 目录规则要能匹配到目录本身，所以命中时也试一下带斜杠的形式
      const hit = rules.some((re) => re.test(rel) || (item.kind === 'dir' && re.test(`${rel}/`)))
      if (hit) item.ignored = true
    }
  }

  items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return items
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
