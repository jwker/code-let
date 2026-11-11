import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelManager } from '../host/main/modelManager'

/**
 * 大模型管理的设置读写。
 *
 * 这些设置存在 **pi 的全局 settings.json**（agent 目录）里 ——
 * 「设为新会话默认」那条既有路径写的就是那儿，两边写一处值才不会打架。
 * 所以这里盯的是：写到 pi 的设置里没有、读回来是不是同一个值、
 * 「可用模型」清单的三种状态（没设过 / 空 / 有内容）有没有被区分开。
 */

let agentDir: string
let manager: ModelManager

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'codelet-model-'))
  manager = new ModelManager({ emit: () => {} }, agentDir)
})

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
})

describe('模型设置', () => {
  it('默认模型读写的是 pi 的设置', async () => {
    await manager.writeSettings({ kind: 'defaultModel', provider: 'anthropic', id: 'claude-fable-5' })
    const settings = await manager.readSettings()
    expect(settings.defaultProvider).toBe('anthropic')
    expect(settings.defaultModel).toBe('claude-fable-5')
  })

  it('默认思考等级读写', async () => {
    await manager.writeSettings({ kind: 'thinkingLevel', level: 'high' })
    expect((await manager.readSettings()).defaultThinkingLevel).toBe('high')
  })

  it('每模型的思考等级可以设也可以撤', async () => {
    await manager.writeSettings({
      kind: 'modelThinkingLevel',
      provider: 'anthropic',
      id: 'claude-fable-5',
      level: 'xhigh'
    })
    let settings = await manager.readSettings()
    expect(settings.modelThinkingLevels['anthropic/claude-fable-5']).toBe('xhigh')

    await manager.writeSettings({
      kind: 'modelThinkingLevel',
      provider: 'anthropic',
      id: 'claude-fable-5',
      level: null
    })
    settings = await manager.readSettings()
    expect(settings.modelThinkingLevels['anthropic/claude-fable-5']).toBeUndefined()
  })

  it('可用模型清单：没设过是 null（全部可用），空数组是一个都不启用', async () => {
    // 没设过
    expect((await manager.readSettings()).enabledModels).toBeNull()

    // 空数组 —— 与「没设过」是两回事，不能被混掉
    await manager.writeSettings({ kind: 'enabledModels', ids: [] })
    expect((await manager.readSettings()).enabledModels).toEqual([])

    // 有内容 —— 顺序要保住（顺序就是模型选择器里的排列顺序）
    await manager.writeSettings({
      kind: 'enabledModels',
      ids: ['anthropic/claude-fable-5', 'minimax/MiniMax-M3']
    })
    expect((await manager.readSettings()).enabledModels).toEqual([
      'anthropic/claude-fable-5',
      'minimax/MiniMax-M3'
    ])

    // 撤掉清单 —— 回到「全部可用」
    await manager.writeSettings({ kind: 'enabledModels', ids: null })
    expect((await manager.readSettings()).enabledModels).toBeNull()
  })
})
