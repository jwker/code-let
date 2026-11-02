import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { PiRuntime } from '../host/main/pi/runtime'

/**
 * 运行时的改名路由（PLAN.md D24）。
 *
 * 有活着的 runtime 走 `setSessionName`（那份要真模型，这里不测）；
 * 没有 runtime 时打开会话文件追加一条 `session_info` —— 这段能单测。
 */

const dirs: string[] = []
let previousAgentDir: string | undefined

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  previousAgentDir = undefined
})

function makeSession(): { cwd: string; path: string; agentDir: string } {
  const agentDir = mkdtempSync(join(tmpdir(), 'codelet-runtime-rename-agent-'))
  const cwd = mkdtempSync(join(tmpdir(), 'codelet-runtime-rename-cwd-'))
  dirs.push(agentDir, cwd)
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir

  const manager = SessionManager.create(cwd)
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    timestamp: Date.now()
  })
  const path = manager.getSessionFile()
  if (!path) throw new Error('会话文件没创建出来')
  return { cwd, path, agentDir }
}

describe('PiRuntime.renameSession', () => {
  it('懒加载的标签没有 runtime —— 直接打开会话文件追加 session_info', async () => {
    const { cwd, path } = makeSession()
    const pi = new PiRuntime()
    await pi.openTab('tab-1', { cwd, path, lazy: true })

    await pi.renameSession(path, '懒加载改名')

    expect(SessionManager.open(path).getSessionName()).toBe('懒加载改名')
    await pi.stop()
  })

  it('会话文件不在了 —— 抛错，不新建一个空会话', async () => {
    const { cwd } = makeSession()
    const pi = new PiRuntime()
    const missing = join(cwd, 'missing.jsonl')

    await expect(pi.renameSession(missing, '不该建出来')).rejects.toThrow('会话文件不存在')
    await pi.stop()
  })
})
