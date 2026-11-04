import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEventBus,
  SessionManager,
  type AgentSession,
  type ToolInfo
} from '@earendil-works/pi-coding-agent'
import { PiRuntime, missingExtensionTools } from '../host/main/pi/runtime'

/**
 * 扩展工具的「掉队自愈」。
 *
 * 背景：`out/ext` 是易变目录。构建期间（或编译失败后）重建 runtime 读不到扩展，
 * Pi 在下一轮请求前把差集写成 `toolsRemoved` 落进会话文件，而
 * `_restoreToolsFromTranscript()` 只把「从未被提过」的扩展工具当新工具激活 ——
 * 于是这些工具在那个分支上永久不可用。`PiRuntime` 在扩展加载完之后把掉队的
 * 扩展工具补回 active，下一轮请求就会写出 `toolsAdded`，会话自愈。
 */

const dirs: string[] = []
let previousAgentDir: string | undefined

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  previousAgentDir = undefined
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const EXTENSION_SOURCE = `
export default function demo(pi) {
  pi.registerTool({
    name: 'demo_tool',
    description: '测试用的扩展工具',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }] }
    }
  })
}
`

/** 编译好的扩展目录（一个 .js 入口，注册 demo_tool） */
function makeExtensionsDir(): string {
  const dir = tempDir('codelet-ext-revive-ext-')
  writeFileSync(join(dir, 'demo.js'), EXTENSION_SOURCE)
  return dir
}

/**
 * 中毒的会话文件：先声明 demo_tool，后来又声明它被移除。
 * 这是 Pi 在扩展缺席的那一轮请求前写下的形状。
 */
function makePoisonedSession(cwd: string): string {
  const manager = SessionManager.create(cwd)
  manager.appendMessage({
    role: 'system',
    content: '',
    toolsAdded: [{ name: 'demo_tool', description: '测试用的扩展工具', parameters: { type: 'object', properties: {} } }],
    timestamp: Date.now()
  })
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    timestamp: Date.now()
  })
  manager.appendMessage({
    role: 'system',
    content: '',
    toolsRemoved: [{ name: 'demo_tool' }],
    timestamp: Date.now()
  })
  const path = manager.getSessionFile()
  if (!path) throw new Error('会话文件没创建出来')
  return path
}

function prepare(): { cwd: string; agentDir: string } {
  const agentDir = tempDir('codelet-ext-revive-agent-')
  const cwd = tempDir('codelet-ext-revive-cwd-')
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  return { cwd, agentDir }
}

describe('missingExtensionTools', () => {
  const tool = (name: string, path: string, exposure: ToolInfo['exposure'] = 'direct'): ToolInfo =>
    ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      promptGuidelines: [],
      exposure,
      sourceInfo: { path, source: 'local', scope: 'temporary', origin: 'top-level' }
    }) as ToolInfo

  it('只挑扩展目录里、可声明、又不在 active 的工具', () => {
    const tools = [
      tool('ext_active', '/proj/out/ext/a.js'),
      tool('ext_dormant', '/proj/out/ext/a.js'),
      tool('ext_hidden', '/proj/out/ext/a.js', 'hidden'),
      tool('ext_other_dir', '/proj/out/ext-other/a.js'),
      tool('builtin_read', 'builtin:read')
    ]

    expect(missingExtensionTools(tools, ['ext_active', 'builtin_read'], '/proj/out/ext')).toEqual([
      'ext_dormant'
    ])
  })

  it('目录前缀按路径分隔符对齐 —— 不把 ext-other 当成 ext', () => {
    const tools = [tool('t', '/proj/out/ext-other/a.js')]
    expect(missingExtensionTools(tools, [], '/proj/out/ext')).toEqual([])
  })
})

describe('PiRuntime 重建 runtime 时补回掉队的扩展工具', () => {
  it('会话记录说工具被移除过 —— 扩展回来后仍然可用', async () => {
    const { cwd } = prepare()
    const extensionsDir = makeExtensionsDir()
    const path = makePoisonedSession(cwd)

    const pi = new PiRuntime(extensionsDir)
    try {
      await pi.openTab('tab-1', { cwd, path })

      const record = (pi as unknown as { tabs: Map<string, { runtime: { session: AgentSession } }> }).tabs.get(
        'tab-1'
      )
      const session = record?.runtime.session
      if (!session) throw new Error('runtime 没建出来')

      const registration = session.getAllTools().find((item) => item.name === 'demo_tool')
      // sourceInfo.path 是扩展文件的真实路径 —— 自愈逻辑靠它认出「这是我加载的扩展」
      expect(registration?.sourceInfo.path).toBe(join(extensionsDir, 'demo.js'))

      expect(session.getActiveToolNames()).toContain('demo_tool')
    } finally {
      await pi.stop()
    }
  })
})

describe('对照：不补回的话，同一份记录里工具就是不可用的', () => {
  it('SDK 直接建会话 —— toolsRemoved 之后 restore 不会把它当新工具', async () => {
    const { cwd, agentDir } = prepare()
    const extensionsDir = makeExtensionsDir()
    const path = makePoisonedSession(cwd)

    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: {
        eventBus: createEventBus(),
        additionalExtensionPaths: [join(extensionsDir, 'demo.js')]
      }
    })
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.open(path, undefined, cwd)
    })

    expect(session.getAllTools().some((item) => item.name === 'demo_tool')).toBe(true)
    expect(session.getActiveToolNames()).not.toContain('demo_tool')
  })
})
