import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS, type CommandOption, type FileContent } from '@contract/index'
import {
  attachmentOf,
  attachmentTotalError,
  codeletCommands,
  commandNameOf,
  estimateTextTokens,
  filterCommands,
  findArgumentQuery,
  findAtQuery,
  findMentions,
  findSlashQuery,
  formatBytes,
  formatMention,
  formatTokenEstimate,
  IMAGE_TOKEN_ESTIMATE,
  insertArgument,
  insertCommand,
  insertMention,
  mergeCommands,
  parseCodeletCommand,
  removeMentions,
  type ComposerCommand
} from '../host/renderer/src/conversation/composerCommands'

/**
 * 输入框 `/` 与 `@` 的纯逻辑（PLAN.md D25）。
 *
 * 重点是边界：`/` 只认整段开头，`@` 只认词边界，路径带空格要加引号。
 */

describe('`/` token', () => {
  it('整段开头是斜杠时返回 query', () => {
    expect(findSlashQuery('/', 1)).toEqual({ tokenStart: 0, tokenEnd: 1, query: '' })
    expect(findSlashQuery('/re', 3)).toEqual({ tokenStart: 0, tokenEnd: 3, query: 're' })
  })

  it('允许前导空白，tokenStart 指向斜杠', () => {
    expect(findSlashQuery('  /rev', 6)).toEqual({ tokenStart: 2, tokenEnd: 6, query: 'rev' })
  })

  it('正文中间的斜杠不弹', () => {
    expect(findSlashQuery('hi /review', 10)).toBeNull()
  })

  it('光标在斜杠前面不弹', () => {
    expect(findSlashQuery('/review', 0)).toBeNull()
  })

  it('命令名后面有空格（开始写参数）就关掉菜单', () => {
    expect(findSlashQuery('/review arg', 11)).toBeNull()
  })
})

describe('命令参数 token', () => {
  it('命令名后的空格开始参数，光标处取 token', () => {
    expect(findArgumentQuery('/deploy ', 8)).toEqual({
      commandName: 'deploy',
      tokenStart: 8,
      tokenEnd: 8,
      prefix: ''
    })
    expect(findArgumentQuery('/deploy sta', 11)).toEqual({
      commandName: 'deploy',
      tokenStart: 8,
      tokenEnd: 11,
      prefix: 'sta'
    })
  })

  it('光标在参数中间时替换整个 token', () => {
    expect(findArgumentQuery('/deploy staging prod', 11)).toEqual({
      commandName: 'deploy',
      tokenStart: 8,
      tokenEnd: 15,
      prefix: 'sta'
    })
  })

  it('光标在命令名上、没有空白、正文里的斜杠都不命中', () => {
    expect(findArgumentQuery('/deploy', 3)).toBeNull()
    expect(findArgumentQuery('/deploy ', 4)).toBeNull()
    expect(findArgumentQuery('hi /deploy ', 11)).toBeNull()
  })

  it('插入参数后补空格并保留后面的文字', () => {
    expect(insertArgument('/deploy sta prod', 8, 11, 'staging')).toEqual({
      text: '/deploy staging  prod',
      caret: 16
    })
  })
})

describe('`@` token', () => {
  it('行首和空白后的 @ 都命中', () => {
    expect(findAtQuery('@', 1)).toEqual({ tokenStart: 0, tokenEnd: 1, query: '' })
    expect(findAtQuery('看下 @src/', 8)).toEqual({ tokenStart: 3, tokenEnd: 8, query: 'src/' })
  })

  it('邮箱和正文里的 @ 不命中', () => {
    expect(findAtQuery('foo@bar.com', 11)).toBeNull()
  })

  it('多个引用里取光标所在的最后一个', () => {
    expect(findAtQuery('@a @b', 5)).toEqual({ tokenStart: 3, tokenEnd: 5, query: 'b' })
  })

  it('query 里有空白就关掉', () => {
    expect(findAtQuery('@a b', 4)).toBeNull()
  })
})

describe('插入', () => {
  it('命令替换掉斜杠 token，保留后面的文字', () => {
    const result = insertCommand('看 /re 这里', 2, 5, 'review')
    expect(result.text).toBe('看 /review  这里')
    expect(result.caret).toBe(10)
  })

  it('文件引用后面补空格，目录不补', () => {
    expect(insertMention('@ind', 0, 4, 'src/index.ts', 'file')).toEqual({
      text: '@src/index.ts ',
      caret: 14
    })
    expect(insertMention('@sr', 0, 3, 'src', 'dir')).toEqual({
      text: '@src/',
      caret: 5
    })
  })

  it('光标在 token 中间时替换整个 token', () => {
    expect(findSlashQuery('/review', 3)?.tokenEnd).toBe(7)
    expect(insertCommand('/review arg', 0, 7, 'rename').text).toBe('/rename  arg')
    expect(findAtQuery('@src/index.ts', 5)?.tokenEnd).toBe(13)
    expect(insertMention('@src/index.ts 看这里', 0, 13, 'src/app.ts', 'file').text).toBe(
      '@src/app.ts  看这里'
    )
  })

  it('路径有空格时加引号', () => {
    expect(formatMention('my file.ts', 'file')).toBe('@"my file.ts"')
    expect(formatMention('my dir', 'dir')).toBe('@"my dir/"')
  })
})

describe('手打 Codelet 命令', () => {
  it('识别已知命令和参数', () => {
    expect(parseCodeletCommand('/new')).toEqual({ name: 'new', args: '' })
    expect(parseCodeletCommand('  /stop ')).toEqual({ name: 'stop', args: '' })
    expect(parseCodeletCommand('/new 带参数')).toEqual({ name: 'new', args: '带参数' })
    expect(parseCodeletCommand('/thinking high')).toEqual({ name: 'thinking', args: 'high' })
    expect(parseCodeletCommand('/reload')).toEqual({ name: 'reload', args: '' })
  })

  it('不认识的命令和正文里的斜杠不拦截', () => {
    expect(parseCodeletCommand('/review')).toBeNull()
    expect(parseCodeletCommand('hi /new')).toBeNull()
  })
})

describe('命令合并与过滤', () => {
  const codelet: ComposerCommand[] = [
    { name: 'new', description: '新建对话', source: 'codelet' },
    { name: 'stop', description: '停止', source: 'codelet' }
  ]

  const pi: CommandOption[] = [
    { name: 'new', description: '扩展同名命令', source: 'extension' },
    { name: 'review', description: '代码审查', source: 'template' },
    { name: 'review', description: '扩展版审查', source: 'extension' },
    { name: 'skill:pdf', description: 'PDF 技能', source: 'skill' }
  ]

  it('与 Codelet 动作同名的 Pi 命令不列；扩展覆盖模板', () => {
    const merged = mergeCommands(codelet, pi)
    expect(merged.map((command) => command.name)).toEqual(['new', 'stop', 'review', 'skill:pdf'])
    expect(merged.find((command) => command.name === 'review')?.source).toBe('extension')
    expect(merged.find((command) => command.name === 'review')?.description).toBe('扩展版审查')
  })

  it('保留扩展命令的参数补全标记', () => {
    const merged = mergeCommands(codelet, [
      { name: 'deploy', description: '发布', source: 'extension', hasArgumentCompletions: true }
    ])
    expect(merged.find((command) => command.name === 'deploy')?.hasArgumentCompletions).toBe(true)
  })

  it('流式期间 Pi 命令整体禁用', () => {
    const merged = mergeCommands(codelet, pi, '等这一轮结束再发')
    expect(merged.find((command) => command.name === 'review')?.disabled).toBe(true)
    expect(merged.find((command) => command.name === 'new')?.disabled).toBeUndefined()
  })

  it('名字、描述、子序列都能匹配；禁用的排后面', () => {
    const commands: ComposerCommand[] = [
      { name: 'review', description: '代码审查', source: 'template' },
      { name: 'deploy', description: '发布到预发', source: 'extension', disabled: true },
      { name: 'reload', description: '重新加载', source: 'template' },
      { name: 'stop', description: '停止', source: 'codelet' }
    ]
    expect(filterCommands(commands, 'rev').map((command) => command.name)).toEqual(['review'])
    expect(filterCommands(commands, '发布').map((command) => command.name)).toEqual(['deploy'])
    expect(filterCommands(commands, 'rvi').map((command) => command.name)).toEqual(['review'])
    expect(filterCommands(commands, '').map((command) => command.name)).toEqual([
      'review',
      'deploy',
      'reload',
      'stop'
    ])
  })
})

describe('Codelet 动作的可用性', () => {
  it('流式中新建/改名可用，停止可用，压缩和模型不可用', () => {
    const commands = codeletCommands({
      streaming: true,
      stopping: false,
      stale: false,
      hasCwd: true,
      canRename: true,
      canModel: false
    })
    const disabled = Object.fromEntries(commands.map((command) => [command.name, Boolean(command.disabled)]))
    expect(disabled).toEqual({
      new: false,
      model: true,
      rename: false,
      compact: true,
      reload: true,
      stop: false,
      thinking: true
    })
  })

  it('没有在跑时停止不可用；没有落盘的对话不能改名', () => {
    const commands = codeletCommands({
      streaming: false,
      stopping: false,
      stale: false,
      hasCwd: true,
      canRename: false,
      canModel: true
    })
    const disabled = Object.fromEntries(commands.map((command) => [command.name, Boolean(command.disabled)]))
    expect(disabled.stop).toBe(true)
    expect(disabled.rename).toBe(true)
    expect(disabled.model).toBe(false)
    expect(disabled.thinking).toBe(false)
    expect(disabled.reload).toBe(false)
  })

  it('stale 时 reload 仍然可用 —— 它本身就是恢复入口', () => {
    const commands = codeletCommands({
      streaming: false,
      stopping: false,
      stale: true,
      hasCwd: true,
      canRename: false,
      canModel: true
    })
    const reload = commands.find((command) => command.name === 'reload')
    expect(reload?.disabled).toBe(false)
  })

  it('没有目录时 reload 不可用', () => {
    const commands = codeletCommands({
      streaming: false,
      stopping: false,
      stale: false,
      hasCwd: false,
      canRename: false,
      canModel: true
    })
    const reload = commands.find((command) => command.name === 'reload')
    expect(reload?.disabled).toBe(true)
  })
})

describe('附件估算与正文引用', () => {
  it('文本按字符数估算，图片用固定估算；大小格式化', () => {
    expect(estimateTextTokens('abcd')).toBe(9)
    expect(estimateTextTokens('a'.repeat(400))).toBe(108)
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(2048)).toBe('2KB')
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5MB')
    expect(formatTokenEstimate(999)).toBe('≈999 tok')
    expect(formatTokenEstimate(1200)).toBe('≈1.2k tok')
  })

  it('扫出正文里的引用，忽略邮箱和正文中间的 @', () => {
    expect(findMentions('看 @src/a.ts 和 @"my file.ts"')).toEqual([
      { path: 'src/a.ts', tokenStart: 2, tokenEnd: 11 },
      { path: 'my file.ts', tokenStart: 14, tokenEnd: 27 }
    ])
    expect(findMentions('foo@bar.com')).toEqual([])
    expect(findMentions('@a @b')).toEqual([
      { path: 'a', tokenStart: 0, tokenEnd: 2 },
      { path: 'b', tokenStart: 3, tokenEnd: 5 }
    ])
  })

  it('删 chip 时把正文里的同名引用一起删掉', () => {
    expect(removeMentions('看 @src/a.ts 这里', 'src/a.ts', 6)).toEqual({
      text: '看 这里',
      caret: 2
    })
    expect(removeMentions('@"my file.ts" 跟着', 'my file.ts', 13)).toEqual({
      text: '跟着',
      caret: 0
    })
    expect(removeMentions('没有引用', 'a.ts', 3)).toBeNull()
  })
})

describe('附件判定与总量', () => {
  const text = (size: number, overrides: Partial<Extract<FileContent, { kind: 'text' }>> = {}) =>
    ({ kind: 'text', text: 'x', lines: 1, binary: false, tooLarge: false, size, ...overrides }) as FileContent
  const image = (size: number) =>
    ({ kind: 'image', dataUrl: 'data:image/png;base64,AAAA', size }) as FileContent

  it('文本与图片可以附件；二进制、太大、不支持的不行', () => {
    expect(attachmentOf('a.ts', text(10))).toEqual({
      attachment: { path: 'a.ts', kind: 'text', size: 10, tokens: estimateTextTokens('x') }
    })
    expect(attachmentOf('pic.png', image(10))).toEqual({
      attachment: {
        path: 'pic.png',
        kind: 'image',
        size: 10,
        tokens: IMAGE_TOKEN_ESTIMATE
      }
    })
    expect(attachmentOf('a.bin', text(10, { binary: true }))).toMatchObject({ error: /二进制/ })
    expect(attachmentOf('a.txt', text(10, { tooLarge: true }))).toMatchObject({ error: /太大/ })
    expect(attachmentOf('a.txt', text(ATTACHMENT_LIMITS.maxTextFileBytes + 1))).toMatchObject({
      error: /单文件上限/
    })
    expect(attachmentOf('a.png', image(ATTACHMENT_LIMITS.maxImageFileBytes + 1))).toMatchObject({
      error: /图片单文件上限/
    })
    expect(attachmentOf('a.zip', { kind: 'unsupported', reason: '不支持' })).toEqual({ error: '不支持' })
  })

  it('重复路径不算错；数量与总量超限报错', () => {
    const existing = [{ path: 'a.ts', kind: 'text' as const, size: 10, tokens: 9 }]
    expect(
      attachmentTotalError(existing, { path: 'a.ts', kind: 'text', size: 10, tokens: 9 })
    ).toBeNull()
    expect(
      attachmentTotalError(existing, {
        path: 'b.ts',
        kind: 'text',
        size: ATTACHMENT_LIMITS.maxTextTotalBytes,
        tokens: 9
      })
    ).toMatch(/文本附件总量/)
    const many = Array.from({ length: ATTACHMENT_LIMITS.maxCount }, (_, index) => ({
      path: `f${index}.ts`,
      kind: 'text' as const,
      size: 1,
      tokens: 9
    }))
    expect(
      attachmentTotalError(many, { path: 'extra.ts', kind: 'text', size: 1, tokens: 9 })
    ).toMatch(/最多/)
  })
})

describe('流式期间执行扩展命令', () => {
  it('只禁用模板和技能，扩展命令仍然可用', () => {
    const commands: CommandOption[] = [
      { name: 'tpl', description: '模板', source: 'template' },
      { name: 'ext', description: '扩展', source: 'extension' },
      { name: 'skill:pdf', description: '技能', source: 'skill' }
    ]
    const merged = mergeCommands([], commands, '等这一轮结束再发', ['template', 'skill'])
    expect(merged.find((command) => command.name === 'tpl')?.disabled).toBe(true)
    expect(merged.find((command) => command.name === 'skill:pdf')?.disabled).toBe(true)
    expect(merged.find((command) => command.name === 'ext')?.disabled).toBeUndefined()
  })

  it('从整段文本里取命令名', () => {
    expect(commandNameOf('/deploy 预发')).toBe('deploy')
    expect(commandNameOf('  /review')).toBe('review')
    expect(commandNameOf('hi /deploy')).toBeNull()
    expect(commandNameOf('/')).toBeNull()
  })
})
