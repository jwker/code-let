import { ATTACHMENT_LIMITS, type CommandOption, type CommandSource, type FileContent } from '@contract/index'

/**
 * 输入框里的 `/` 命令与 `@` 引用的纯逻辑（好测）。
 *
 * 组件只管画和发请求；「什么时候弹出、弹什么、选中后怎么替换文本」全在这里。
 */

export type ComposerCommandSource = 'codelet' | CommandSource

export interface ComposerCommand {
  name: string
  description?: string
  argumentHint?: string
  source: ComposerCommandSource
  /** 扩展命令提供参数候选；选中命令后输入空格会弹第二级菜单 */
  hasArgumentCompletions?: boolean
  disabled?: boolean
  disabledReason?: string
}

/** Codelet 自己的命令名 —— 这些名字不从 Pi 的命令列表里再列一遍 */
export const CODELET_COMMAND_NAMES = ['new', 'model', 'rename', 'compact', 'reload', 'stop', 'thinking'] as const

export type CodeletCommandName = (typeof CODELET_COMMAND_NAMES)[number]

export function isCodeletCommandName(name: string): name is CodeletCommandName {
  return (CODELET_COMMAND_NAMES as readonly string[]).includes(name)
}

export interface CodeletCommandContext {
  streaming: boolean
  stopping: boolean
  stale: boolean
  hasCwd: boolean
  canRename: boolean
  canModel: boolean
}

/** Codelet 动作 —— 这些不发给模型，由界面直接执行 */
export function codeletCommands(context: CodeletCommandContext): ComposerCommand[] {
  const busy = context.streaming || context.stopping
  return [
    {
      name: 'new',
      description: '在当前项目里新建对话',
      source: 'codelet',
      disabled: !context.hasCwd || context.stale,
      disabledReason: !context.hasCwd ? '这个标签没有目录' : '会话有外部更新'
    },
    {
      name: 'model',
      description: '切换当前会话的模型',
      source: 'codelet',
      disabled: !context.canModel || busy || context.stale,
      disabledReason: busy ? '等这一轮结束再换' : '没有可用模型'
    },
    {
      name: 'rename',
      description: '重命名当前对话',
      source: 'codelet',
      disabled: !context.canRename || context.stale,
      disabledReason: '这个对话还没有保存到磁盘'
    },
    {
      name: 'compact',
      description: '压缩当前会话的上下文',
      source: 'codelet',
      disabled: busy || context.stale,
      disabledReason: '等这一轮结束再压缩'
    },
    {
      name: 'reload',
      description: '重新加载扩展和会话',
      source: 'codelet',
      disabled: busy || !context.hasCwd,
      disabledReason: busy ? '等这一轮结束再重新加载' : '这个标签没有目录'
    },
    {
      name: 'stop',
      description: '停止正在跑的这一轮',
      source: 'codelet',
      disabled: !context.streaming || context.stopping || context.stale,
      disabledReason: '当前没有在跑的轮次'
    },
    {
      name: 'thinking',
      description: '设置当前会话的思考等级',
      argumentHint: '<level>',
      source: 'codelet',
      hasArgumentCompletions: true,
      disabled: !context.canModel || busy || context.stale,
      disabledReason: busy ? '等这一轮结束再改' : '没有可用模型'
    }
  ]
}

/**
 * Codelet 动作 + Pi 命令。
 *
 * Pi 命令同名时按实际分发顺序覆盖：扩展 > 技能 > 模板
 * （`prompt()` 先试扩展命令，再展开技能，最后展开模板）。
 * 与 Codelet 动作同名的 Pi 命令不列 —— Codelet 会先处理它。
 */
export function mergeCommands(
  codelet: readonly ComposerCommand[],
  pi: readonly CommandOption[],
  piDisabledReason?: string,
  /** 流式期间允许跑哪些来源；默认三类都禁用 */
  disabledSources: readonly CommandSource[] = ['template', 'skill', 'extension']
): ComposerCommand[] {
  const reserved = new Set<string>(CODELET_COMMAND_NAMES)
  const byName = new Map<string, ComposerCommand>()
  for (const source of ['template', 'skill', 'extension'] as const) {
    for (const command of pi) {
      if (command.source !== source || reserved.has(command.name)) continue
      byName.set(command.name, {
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint,
        source,
        ...(command.hasArgumentCompletions ? { hasArgumentCompletions: true } : {}),
        ...(piDisabledReason && disabledSources.includes(source)
          ? { disabled: true, disabledReason: piDisabledReason }
          : {})
      })
    }
  }
  return [...codelet, ...byName.values()]
}

function commandScore(command: ComposerCommand, query: string): number {
  const name = command.name.toLowerCase()
  if (name === query) return 100
  if (name.startsWith(query)) return 80
  if (name.includes(query)) return 60
  const description = (command.description ?? '').toLowerCase()
  if (description.includes(query)) return 30
  // 子序列：`rvi` 命中 `review`
  let at = 0
  for (const ch of name) {
    if (ch === query[at]) at += 1
    if (at === query.length) return 20
  }
  return -1
}

/** 过滤命令；禁用的排在后面，但不会消失 */
export function filterCommands(commands: readonly ComposerCommand[], query: string): ComposerCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...commands]
  return commands
    .map((command) => ({ command, score: commandScore(command, q) }))
    .filter((item) => item.score >= 0)
    .sort(
      (a, b) =>
        Number(Boolean(a.command.disabled)) - Number(Boolean(b.command.disabled)) ||
        b.score - a.score ||
        a.command.name.localeCompare(b.command.name)
    )
    .map((item) => item.command)
}

/** 命令来源的界面标签 */
export const COMMAND_SOURCE_LABEL: Record<ComposerCommandSource, string> = {
  codelet: '内置',
  template: '模板',
  extension: '扩展',
  skill: '技能'
}

// ---------------------------------------------------------------------------
// `/` 的 token
// ---------------------------------------------------------------------------

export interface SlashQuery {
  /** `/` 在文本里的位置 */
  tokenStart: number
  /** 整个命令 token 的结束位置（光标在中间时也能整段替换） */
  tokenEnd: number
  /** 斜杠和光标之间的文字 */
  query: string
}

/** 从 from 往后扫到空白，得到 token 的结束位置 */
function tokenEndAt(text: string, from: number): number {
  let end = from
  while (end < text.length && !/\s/.test(text[end])) end += 1
  return end
}

/**
 * 只在整段输入的第一个非空白字符是 `/` 时返回。
 *
 * Pi 的 `expandPromptTemplate()` / `_expandSkillCommand()` / 扩展命令分发都要求
 * 整段文本以 `/` 开头；第二行或正文中间的 `/` 不会被当成命令。
 * query 里出现空白就关掉菜单（命令名不接受空格，参数补全这一版不做）。
 */
export function findSlashQuery(text: string, caret: number): SlashQuery | null {
  const first = text.search(/\S/)
  if (first < 0 || text[first] !== '/') return null
  if (caret <= first) return null
  const query = text.slice(first + 1, caret)
  if (/\s/.test(query)) return null
  return { tokenStart: first, tokenEnd: tokenEndAt(text, caret), query }
}

// ---------------------------------------------------------------------------
// 命令参数
// ---------------------------------------------------------------------------

export interface ArgumentQuery {
  /** 不带斜杠的命令名 */
  commandName: string
  /** 光标所在参数 token 的起点 */
  tokenStart: number
  /** 参数 token 的结束位置（可能是行尾或下一个空白） */
  tokenEnd: number
  /** token 起点到光标之间的文字 */
  prefix: string
}

/**
 * 找 `/name ` 后面光标所在的参数 token。
 *
 * 只认整段输入开头的命令；命令名和参数之间必须有空白。
 * 参数用空白分隔，因此 `/deploy sta` 的 token 是 `sta`；
 * 光标放在空格后时 prefix 为空，仍然会弹候选（方便列出全部参数）。
 * 带空格的参数值（例如引号路径）不在这一版的补全范围内。
 */
export function findArgumentQuery(text: string, caret: number): ArgumentQuery | null {
  const first = text.search(/\S/)
  if (first < 0 || text[first] !== '/') return null
  const rest = text.slice(first + 1)
  const match = /^([^\s]+)(\s+)/.exec(rest)
  if (!match) return null
  const argsStart = first + 1 + match[0].length
  if (caret < argsStart) return null

  let tokenStart = caret
  while (tokenStart > argsStart && !/\s/.test(text[tokenStart - 1])) tokenStart -= 1
  let tokenEnd = caret
  while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) tokenEnd += 1
  const prefix = text.slice(tokenStart, caret)
  if (/\s/.test(prefix)) return null
  return { commandName: match[1], tokenStart, tokenEnd, prefix }
}

// ---------------------------------------------------------------------------
// `@` 的 token
// ---------------------------------------------------------------------------

export interface AtQuery {
  /** `@` 在文本里的位置 */
  tokenStart: number
  /** 整个引用 token 的结束位置 */
  tokenEnd: number
  /** `@` 和光标之间的文字 */
  query: string
}

/**
 * 找光标所在的 `@` token。
 *
 * token 从上一个空白开始；所以 `foo@bar.com` 这种不会命中。
 * query 里出现空白就关掉（路径里有空格的情况用插入的 `@"..."` 处理，不在输入时补全）。
 */
export function findAtQuery(text: string, caret: number): AtQuery | null {
  let start = caret
  while (start > 0 && !/\s/.test(text[start - 1])) start -= 1
  const token = text.slice(start, caret)
  if (!token.startsWith('@')) return null
  const query = token.slice(1)
  if (/\s/.test(query)) return null
  return { tokenStart: start, tokenEnd: tokenEndAt(text, caret), query }
}

// ---------------------------------------------------------------------------
// 插入
// ---------------------------------------------------------------------------

export interface InsertResult {
  text: string
  caret: number
}

/** 把整个命令 token 换成 `/name ` */
export function insertCommand(
  text: string,
  tokenStart: number,
  tokenEnd: number,
  name: string
): InsertResult {
  const before = text.slice(0, tokenStart)
  const after = text.slice(tokenEnd)
  const inserted = `/${name} `
  return { text: before + inserted + after, caret: before.length + inserted.length }
}

/** 把参数 token 换成选中的值，并在后面补一个空格 */
export function insertArgument(
  text: string,
  tokenStart: number,
  tokenEnd: number,
  value: string
): InsertResult {
  const before = text.slice(0, tokenStart)
  const after = text.slice(tokenEnd)
  const inserted = `${value} `
  return { text: before + inserted + after, caret: before.length + inserted.length }
}

/** 文本附件的粗略 token 估算：4 字符一个 token，再加 `<file>` 包装的开销 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4) + 8
}

/** 图片附件的固定估算 —— 跟 Pi 压缩估算里的 4800 字符/图片一致 */
export const IMAGE_TOKEN_ESTIMATE = 1200

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 只用于界面提示，明确标成约数 */
export function formatTokenEstimate(tokens: number): string {
  if (tokens >= 1000) return `≈${(tokens / 1000).toFixed(1)}k tok`
  return `≈${tokens} tok`
}

/** `@` 引用的显示形式；路径有空格时加引号 */
export function formatMention(path: string, kind: 'dir' | 'file'): string {
  const raw = kind === 'dir' ? `${path}/` : path
  return /\s/.test(raw) ? `@"${raw}"` : `@${raw}`
}

/**
 * 把 `[tokenStart, caret)` 换成 `@path`。
 *
 * 文件后面补一个空格，方便接着打字；目录不补，方便继续补全。
 */
export function insertMention(
  text: string,
  tokenStart: number,
  tokenEnd: number,
  path: string,
  kind: 'dir' | 'file'
): InsertResult {
  const before = text.slice(0, tokenStart)
  const after = text.slice(tokenEnd)
  const mention = formatMention(path, kind)
  const suffix = kind === 'file' ? ' ' : ''
  return { text: before + mention + suffix + after, caret: before.length + mention.length + suffix.length }
}

// ---------------------------------------------------------------------------
// 手打的 Codelet 命令
// ---------------------------------------------------------------------------

export interface ParsedCodeletCommand {
  name: CodeletCommandName
  args: string
}

/** 发送前再解析一次 —— 用户可能手打 `/new`，不能只靠弹窗 */
export function parseCodeletCommand(text: string): ParsedCodeletCommand | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(trimmed)
  if (!match) return null
  const name = match[1]
  if (!isCodeletCommandName(name)) return null
  return { name, args: (match[2] ?? '').trim() }
}

// ---------------------------------------------------------------------------
// @ 内容附件
// ---------------------------------------------------------------------------

export interface ComposerAttachment {
  /** 项目内的相对路径 */
  path: string
  kind: 'text' | 'image'
  /** 字节数，用于总量限制 */
  size: number
  /** 估算 token，仅用于界面提示 */
  tokens: number
}

export type AttachmentCheck = { attachment: ComposerAttachment } | { error: string }

function formatKb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`
}

/** 把一次 `readFile` 的结果判成可附件 / 不可附件 */
export function attachmentOf(path: string, content: FileContent): AttachmentCheck {
  if (content.kind === 'unsupported') return { error: content.reason }
  if (content.kind === 'image') {
    if (content.size > ATTACHMENT_LIMITS.maxImageFileBytes) {
      return { error: `超过图片单文件上限 ${formatKb(ATTACHMENT_LIMITS.maxImageFileBytes)}` }
    }
    return {
      attachment: { path, kind: 'image', size: content.size, tokens: IMAGE_TOKEN_ESTIMATE }
    }
  }
  if (content.binary) return { error: '是二进制文件，不能作为附件' }
  if (content.tooLarge) return { error: '文件太大，不能作为附件' }
  if (content.size > ATTACHMENT_LIMITS.maxTextFileBytes) {
    return { error: `超过文本单文件上限 ${formatKb(ATTACHMENT_LIMITS.maxTextFileBytes)}` }
  }
  return {
    attachment: {
      path,
      kind: 'text',
      size: content.size,
      tokens: estimateTextTokens(content.text)
    }
  }
}

/** 再加一个附件会不会超总量；重复路径不算错（已经在了） */
export function attachmentTotalError(
  existing: readonly ComposerAttachment[],
  next: ComposerAttachment
): string | null {
  if (existing.some((item) => item.path === next.path)) return null
  if (existing.length >= ATTACHMENT_LIMITS.maxCount) {
    return `附件最多 ${ATTACHMENT_LIMITS.maxCount} 个`
  }
  const total = existing
    .filter((item) => item.kind === next.kind)
    .reduce((sum, item) => sum + item.size, 0)
  const limit =
    next.kind === 'text' ? ATTACHMENT_LIMITS.maxTextTotalBytes : ATTACHMENT_LIMITS.maxImageTotalBytes
  if (total + next.size <= limit) return null
  return next.kind === 'text'
    ? `文本附件总量超过 ${formatKb(limit)}`
    : `图片附件总量超过 ${formatKb(limit)}`
}

export interface MentionToken {
  path: string
  /** `@` 在文本里的位置 */
  tokenStart: number
  /** 整个引用 token 的结束位置（含引号） */
  tokenEnd: number
}

/**
 * 扫出正文里所有 `@path` / `@"path with space"`。
 *
 * 只认行首或空白后的 `@`，跟输入时的触发规则一致；邮箱和正文中间的 `@` 不算。
 */
export function findMentions(text: string): MentionToken[] {
  const mentions: MentionToken[] = []
  const pattern = /(^|\s)@(?:"([^"]*)"|([^\s]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const path = match[2] ?? match[3] ?? ''
    if (!path) continue
    const tokenStart = match.index + (match[1]?.length ?? 0)
    mentions.push({ path, tokenStart, tokenEnd: match.index + match[0].length })
  }
  return mentions
}

/** 删掉正文里某个路径的所有引用；没有命中时返回 null */
export function removeMentions(text: string, path: string, caret: number): InsertResult | null {
  const matches = findMentions(text).filter((mention) => mention.path === path)
  if (matches.length === 0) return null

  let next = text
  let nextCaret = caret
  // 从后往前删，前面的下标才不会变
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const mention = matches[index]
    let end = mention.tokenEnd
    if (next[end] === ' ') end += 1
    const removed = end - mention.tokenStart
    next = next.slice(0, mention.tokenStart) + next.slice(end)
    if (nextCaret >= end) nextCaret -= removed
    else if (nextCaret > mention.tokenStart) nextCaret = mention.tokenStart
  }
  return { text: next, caret: Math.max(0, nextCaret) }
}

/** 取 `/name args` 里的命令名（不含斜杠）；不是命令就返回 null */
export function commandNameOf(text: string): string | null {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('/')) return null
  const match = /^\/([^\s]+)/.exec(trimmed)
  return match ? match[1] : null
}
