import { describe, expect, it } from 'vitest'
import { agentMenuState } from '../host/renderer/src/shell/AgentContextMenu'

/**
 * agent 右键菜单里各项的可点状态（PLAN.md D53）。
 *
 * 只有「归档」受状态限制：正在跑的不许归档 —— 它显然还有活动，
 * 藏起来会让人以为任务没了。删除反过来允许在运行时做（会先 abort 再移文件，
 * 而且点之前已经有确认框）。
 */

describe('菜单项的可点状态', () => {
  it('空闲时四项都能点', () => {
    const state = agentMenuState({ streaming: false })
    expect(state.newInstance.enabled).toBe(true)
    expect(state.rename.enabled).toBe(true)
    expect(state.archive.enabled).toBe(true)
    expect(state.remove.enabled).toBe(true)
  })

  it('正在跑时归档置灰，并说明原因', () => {
    const state = agentMenuState({ streaming: true })
    expect(state.archive.enabled).toBe(false)
    expect(state.archive.reason).toContain('先停下来')
  })

  it('正在跑时删除仍然可点，但提示会先中止这一轮', () => {
    const state = agentMenuState({ streaming: true })
    expect(state.remove.enabled).toBe(true)
    expect(state.remove.reason).toContain('中止')
  })

  it('新建实例和重命名不受运行状态影响', () => {
    const running = agentMenuState({ streaming: true })
    expect(running.newInstance.enabled).toBe(true)
    expect(running.rename.enabled).toBe(true)
  })
})
