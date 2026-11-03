import { describe, expect, it } from 'vitest'
import type { ExecResult, ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import repoStatus from '../ext/repo-status'

/**
 * `ext/index.ts` 的扩展命令（PLAN.md D29）。
 *
 * 这里只测 factory 和 handler 的行为；「编译后的文件能被 Pi 按目录加载」
 * 由 `npm run build:ext` + 构建后的手动验证覆盖。
 */

interface FakeCommand {
  name: string
  description?: string
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
}

interface FakeMessage {
  customType: string
  content: unknown
  display?: boolean
}

function setup(result: ExecResult | (() => Promise<ExecResult>)) {
  const commands = new Map<string, FakeCommand>()
  const messages: FakeMessage[] = []
  const execCalls: Array<{ command: string; args: string[] }> = []
  const pi = {
    registerCommand: (name: string, options: Omit<FakeCommand, 'name'>) => {
      commands.set(name, { name, ...options })
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args })
      return typeof result === 'function' ? result() : result
    },
    sendMessage: (message: FakeMessage) => {
      messages.push(message)
    }
  } as unknown as ExtensionAPI

  repoStatus(pi)
  return { commands, messages, execCalls }
}

const OK: ExecResult = {
  stdout: '## main\n M src/index.ts\n',
  stderr: '',
  code: 0,
  killed: false
}

describe('ext/repo-status', () => {
  it('注册命令并执行 git status，结果发成 custom 消息', async () => {
    const { commands, messages, execCalls } = setup(OK)
    expect(commands.has('repo-status')).toBe(true)
    expect(commands.get('repo-status')?.description).toBeTruthy()

    await commands.get('repo-status')!.handler('', {} as ExtensionCommandContext)

    expect(execCalls).toEqual([
      { command: 'git', args: ['-c', 'core.quotePath=false', 'status', '--short', '--branch'] }
    ])
    expect(messages).toEqual([
      {
        customType: 'repo-status',
        content: '```text\n## main\n M src/index.ts\n```',
        display: true
      }
    ])
  })

  it('git 返回非 0 时把 stderr 发出来', async () => {
    const { commands, messages } = setup({
      stdout: '',
      stderr: 'fatal: not a git repository',
      code: 128,
      killed: false
    })
    await commands.get('repo-status')!.handler('', {} as ExtensionCommandContext)
    expect(String(messages[0]?.content)).toContain('git status 失败')
    expect(String(messages[0]?.content)).toContain('not a git repository')
  })

  it('exec 抛错时也发一条 custom 消息', async () => {
    const { commands, messages } = setup(async () => {
      throw new Error('spawn git ENOENT')
    })
    await commands.get('repo-status')!.handler('', {} as ExtensionCommandContext)
    expect(String(messages[0]?.content)).toContain('执行失败')
    expect(String(messages[0]?.content)).toContain('ENOENT')
  })

  it('输出过长时截断', async () => {
    const { commands, messages } = setup({
      stdout: 'x'.repeat(9000),
      stderr: '',
      code: 0,
      killed: false
    })
    await commands.get('repo-status')!.handler('', {} as ExtensionCommandContext)
    const content = String(messages[0]?.content)
    expect(content).toContain('…（截断）')
    expect(content.startsWith('```text')).toBe(true)
    expect(content.length).toBeLessThan(8100)
  })
})
