import { describe, expect, it } from 'vitest'
import type { ConversationInfo, TabInfo } from '@contract/index'
import {
  batchDeleteCopy,
  countAffectedTabs,
  projectNamesOf,
  singleDeleteCopy
} from '../host/renderer/src/shell/conversationDelete'

/**
 * 删除会话的确认文案（PLAN.md D23）。
 *
 * 三种状态要覆盖：没开标签、开着标签、正在跑。
 */

function tab(overrides: Partial<TabInfo> & { path: string }): TabInfo {
  return {
    id: `tab-${overrides.path}`,
    sessionId: `s-${overrides.path}`,
    cwd: '/tmp/project',
    title: '对话',
    projectName: 'project',
    streaming: false,
    ready: true,
    removed: false,
    stale: false,
    model: null,
    modelFallback: null,
    error: null,
    ...overrides
  }
}

function conversation(path: string, cwd = '/tmp/project', title = '对话'): ConversationInfo {
  return { id: path, path, title, name: null, modified: '2026-01-01T00:00:00.000Z', messageCount: 1, cwd }
}

describe('受影响标签统计', () => {
  it('只统计路径命中的标签，正在跑的是其中一部分', () => {
    const tabs = [
      tab({ path: '/a' }),
      tab({ path: '/b', streaming: true }),
      tab({ path: '/c', streaming: true })
    ]
    expect(countAffectedTabs(['/a', '/b'], tabs)).toEqual({ tabCount: 2, streamingCount: 1 })
    expect(countAffectedTabs(['/x'], tabs)).toEqual({ tabCount: 0, streamingCount: 0 })
  })
})

describe('单条删除文案', () => {
  it('没开标签：只说文件去废纸篓', () => {
    const copy = singleDeleteCopy('类型声明生成', { tabCount: 0, streamingCount: 0 })
    expect(copy.title).toBe('删除这个对话？')
    expect(copy.body).toContain('「类型声明生成」')
    expect(copy.body).toContain('废纸篓')
    expect(copy.warning).toBeUndefined()
    expect(copy.confirmText).toBe('删除')
  })

  it('开着标签：多一句「标签会一起关掉」', () => {
    const copy = singleDeleteCopy('类型声明生成', { tabCount: 1, streamingCount: 0 })
    expect(copy.warning).toBe('它开着的标签会一起关掉。')
    expect(copy.confirmText).toBe('删除')
  })

  it('正在跑：按钮改成「中止并删除」', () => {
    const copy = singleDeleteCopy('类型声明生成', { tabCount: 1, streamingCount: 1 })
    expect(copy.warning).toContain('中止')
    expect(copy.confirmText).toBe('中止并删除')
  })
})

describe('批量删除文案', () => {
  it('多个项目时列出项目名，并写清标签与正在生成的数量', () => {
    const copy = batchDeleteCopy(3, ['codelet', 'pi-sdk'], { tabCount: 2, streamingCount: 1 })
    expect(copy.title).toBe('删除 3 个对话？')
    expect(copy.body).toContain('这 3 个会话文件')
    expect(copy.body).toContain('来自 2 个项目：codelet、pi-sdk。')
    expect(copy.warning).toBe('其中 2 个开着标签，会一起关掉；1 个正在生成，会先中止再删除。')
    expect(copy.confirmText).toBe('中止并删除')
  })

  it('只有一个项目时不写项目那一段', () => {
    const copy = batchDeleteCopy(1, ['codelet'], { tabCount: 0, streamingCount: 0 })
    expect(copy.body).not.toContain('来自')
    expect(copy.warning).toBeUndefined()
    expect(copy.confirmText).toBe('删除')
  })

  it('超过 3 个项目只列前 3 个', () => {
    const copy = batchDeleteCopy(4, ['a', 'b', 'c', 'd'], { tabCount: 0, streamingCount: 0 })
    expect(copy.body).toContain('来自 4 个项目：a、b、c 等。')
  })
})

describe('项目名', () => {
  it('按项目清单顺序、去重', () => {
    const conversations = [conversation('/a', '/codelet'), conversation('/b', '/pi-sdk'), conversation('/c', '/codelet')]
    const projects = [
      { path: '/pi-sdk', name: 'pi-sdk' },
      { path: '/codelet', name: 'codelet' }
    ]
    expect(projectNamesOf(['/a', '/b', '/c'], conversations, projects)).toEqual(['pi-sdk', 'codelet'])
  })
})
