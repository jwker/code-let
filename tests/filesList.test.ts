import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import { AgentStore } from '../host/main/agents'
import type { PiEventListener, PiRuntimePort, AgentRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 列目录时「越界」不是异常（PLAN.md 边界）。
 *
 * `node_modules` 里的 link 依赖常常指向项目外（Pi 自己的安装目录就是这样）。
 * 主进程拒绝读它，是为了守住「渲染进程不能点名读项目外的路径」；
 * 但这条失败必须**当正常结果**回到界面，并带一句能看懂的说明 ——
 * 否则每展开一次就一条控制台报错，树里还是个空文件夹。
 */

class FakePi implements PiRuntimePort {
  onEvent(_listener: PiEventListener): () => void {
    return () => {}
  }
  hasAgent(): boolean {
    return false
  }
  async openAgent(): Promise<void> {}
  async closeAgent(): Promise<void> {}
  async activateAgent(): Promise<void> {}
  async reloadAgent(): Promise<void> {}
  agentState(): AgentRuntimeState {
    return {
      ready: false,
      sessionId: null,
      sessionFile: null,
      streaming: false,
      model: null,
      thinkingLevel: null,
      modelFallback: null
    }
  }
  readEntries(): StreamItem[] {
    return []
  }
  async listModels(): Promise<ModelOption[]> {
    return []
  }
  async refreshModelAvailability(): Promise<void> {}
  async selectModel(): Promise<void> {}
  async prompt(): Promise<void> {}
  async abortAgent(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async setSessionName(): Promise<void> {}
  async listCommands(): Promise<never[]> {
    return []
  }
  async compactAgent(): Promise<void> {}
  async completeCommand(): Promise<never[]> {
    return []
  }
  thinkingLevels(): never[] {
    return []
  }
  setThinkingLevel(): void {}
  async stop(): Promise<void> {}
}

const dirs: string[] = []

function makeState(): HostState {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-fileslist-'))
  dirs.push(dir)
  return new HostState({
    pi: new FakePi(),
    tabStore: new TabStore(join(dir, 'tabs.json')),
    agentStore: new AgentStore(join(dir, 'agents.json')),
    projects: new ProjectStore(join(dir, 'projects.json'))
  })
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('列目录的越界情况', () => {
  it('普通目录照常返回条目', async () => {
    const state = makeState()
    const root = dirs[dirs.length - 1]
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/a.ts'), 'x')

    const result = await state.listFiles(root, 'src')
    expect(result.error).toBeNull()
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.ts'])
  })

  it('指向项目外的符号链接：不抛，返回空列表加一句说明', async () => {
    const state = makeState()
    const root = dirs[dirs.length - 1]
    const outside = mkdtempSync(join(tmpdir(), 'codelet-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(root, 'link'))

    const result = await state.listFiles(root, 'link')
    expect(result.entries).toEqual([])
    expect(result.error).toContain('符号链接')
  })

  it('指向项目内的符号链接照常展开', async () => {
    const state = makeState()
    const root = dirs[dirs.length - 1]
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/a.ts'), 'x')
    symlinkSync(join(root, 'src'), join(root, 'srclink'))

    const result = await state.listFiles(root, 'srclink')
    expect(result.error).toBeNull()
    expect(result.entries.map((entry) => entry.name)).toEqual(['a.ts'])
  })

  it('越界的相对路径也不抛，带说明回来', async () => {
    const state = makeState()
    const root = dirs[dirs.length - 1]
    const result = await state.listFiles(root, '../../..')
    expect(result.entries).toEqual([])
    expect(result.error).toBeTruthy()
  })
})
