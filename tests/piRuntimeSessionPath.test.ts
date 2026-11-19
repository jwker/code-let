import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { PiRuntime } from '../host/main/pi/runtime'

/**
 * 重建 runtime 不能把会话换成新的。
 *
 * 新建的 agent 建 runtime 时还没有会话文件 —— 文件要等第一条消息才写出来。
 * 如果记录上一直留着「没有路径」，`/reload`（以及 stale 之后的重新加载）就会
 * `SessionManager.create` 开一条全新的空会话，界面上看就是历史忽然空了。
 */

const dirs: string[] = []
let previousAgentDir: string | undefined

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  previousAgentDir = undefined
})

function makeDirs(): { cwd: string; agentDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'codelet-runtime-path-cwd-'))
  const agentDir = mkdtempSync(join(tmpdir(), 'codelet-runtime-path-agent-'))
  dirs.push(cwd, agentDir)
  previousAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  return { cwd, agentDir }
}

describe('PiRuntime 的会话文件记账', () => {
  it('建 runtime 时没有路径：重建之后还是同一个会话文件，历史还在', async () => {
    const { cwd } = makeDirs()
    const pi = new PiRuntime()
    // 不带 path —— 跟「新建 agent」一样
    await pi.openAgent('a1', { cwd })

    const firstFile = pi.agentState('a1').sessionFile
    expect(firstFile).toBeTruthy()

    // 模拟第一条用户消息：Pi 会把会话写在这个路径上
    const manager = SessionManager.open(firstFile as string)
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: '第一句话' }],
      timestamp: Date.now()
    })

    await pi.reloadAgent('a1')

    expect(pi.agentState('a1').sessionFile).toBe(firstFile)
    const texts = pi.readEntries('a1').map((item) => (item.kind === 'message' ? item.text : ''))
    expect(texts.join('\n')).toContain('第一句话')
    await pi.stop()
  }, 60_000)
})
