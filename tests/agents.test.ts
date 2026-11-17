import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PANE_LAYOUT, defaultAgentName, paneLayoutFor } from '@contract/index'
import {
  AgentStore,
  archiveRecord,
  dueForArchive,
  migrateLegacyTabs,
  newAgentRecord,
  restoreRecord,
  type AgentRecord
} from '../host/main/agents'

/**
 * agent 清单与区域分派表（PLAN.md D52 / D53 / D55 / D59）。
 *
 * 这一层是纯逻辑：清单的增删改、自动归档筛选、旧标签迁移。runtime 和
 * 会话文件不在这里 —— 那些要模型和凭据，测不动。
 */

const dirs: string[] = []

function makeStore(): { store: AgentStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-agents-'))
  dirs.push(dir)
  const file = join(dir, 'agents.json')
  return { store: new AgentStore(file), file }
}

function record(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: 'a1',
    name: '通用 1',
    type: 'general',
    instance: 1,
    cwd: '/repo',
    sessionPath: '/repo/s1.jsonl',
    createdAt: 1_000,
    lastActiveAt: 1_000,
    archivedAt: null,
    turns: 0,
    ...overrides
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('区域 5 的分派表', () => {
  it('七个入口都有布局', () => {
    expect(Object.keys(PANE_LAYOUT).sort()).toEqual(
      ['browser', 'code', 'dev', 'docs', 'general', 'product', 'settings'].sort()
    )
  })

  it('只有代码、文档、设置、产品 agent 有区域 5', () => {
    expect(PANE_LAYOUT.code.zone5).toBe(268)
    expect(PANE_LAYOUT.docs.zone5).toBe(268)
    expect(PANE_LAYOUT.settings.zone5).toBe(268)
    expect(PANE_LAYOUT.product.zone5).toBe(380)
    expect(PANE_LAYOUT.browser.zone5).toBeNull()
    expect(PANE_LAYOUT.general.zone5).toBeNull()
    expect(PANE_LAYOUT.dev.zone5).toBeNull()
  })

  it('产品 agent 的对话比文件树宽，下限也更高', () => {
    expect(PANE_LAYOUT.product.zone5Min).toBe(320)
    expect(PANE_LAYOUT.code.zone5Min).toBeUndefined()
  })

  it('按入口取布局时，agent 走类型那张表', () => {
    expect(paneLayoutFor('agent', 'product').zone5).toBe(380)
    expect(paneLayoutFor('agent', 'general').zone5).toBeNull()
    // 还不知道类型 —— 给空布局，界面显示「没选 agent」
    expect(paneLayoutFor('agent', null).zone5).toBeNull()
    expect(paneLayoutFor('code').zone5).toBe(268)
  })

  it('默认名字带类型和实例序号', () => {
    expect(defaultAgentName('general', 1)).toBe('通用 1')
    expect(defaultAgentName('product', 3)).toBe('产品 3')
  })
})

describe('agent 清单', () => {
  it('存进去的能读回来', () => {
    const { store, file } = makeStore()
    store.add(record())

    const reloaded = new AgentStore(file)
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.get('a1')?.sessionPath).toBe('/repo/s1.jsonl')
  })

  it('缺字段的记录被丢掉，不拿默认值补', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-agents-'))
    dirs.push(dir)
    const file = join(dir, 'agents.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        agents: [
          { id: 'ok', name: '通用 1', type: 'general', instance: 1, cwd: '/r', sessionPath: null, lastActiveAt: 1 },
          // 缺 cwd
          { id: 'bad', name: '通用 2', type: 'general', instance: 2, sessionPath: null, lastActiveAt: 1 },
          // 类型不认识
          { id: 'bad2', name: 'x', type: 'reviewer', instance: 1, cwd: '/r', lastActiveAt: 1 }
        ]
      })
    )
    expect(new AgentStore(file).list().map((agent) => agent.id)).toEqual(['ok'])
  })

  it('文件坏了当空的，不抛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-agents-'))
    dirs.push(dir)
    const file = join(dir, 'agents.json')
    writeFileSync(file, '{ 不是 json')
    expect(new AgentStore(file).list()).toEqual([])
  })

  it('实例序号取同项目同类型的最大值加一', () => {
    const { store } = makeStore()
    store.add(record({ id: 'a1', type: 'general', instance: 1, cwd: '/repo' }))
    store.add(record({ id: 'a2', type: 'general', instance: 3, cwd: '/repo' }))
    store.add(record({ id: 'd1', type: 'dev', instance: 1, cwd: '/repo' }))
    expect(store.nextInstance('general', '/repo')).toBe(4)
    expect(store.nextInstance('dev', '/repo')).toBe(2)
    expect(store.nextInstance('product', '/repo')).toBe(1)
  })

  it('编号按项目分开 —— 窄轨是项目级的，不能出现「只有一个 agent 却写着 5」', () => {
    const { store } = makeStore()
    store.add(record({ id: 'a1', type: 'general', instance: 1, cwd: '/one' }))
    store.add(record({ id: 'a2', type: 'general', instance: 2, cwd: '/one' }))
    store.add(record({ id: 'b1', type: 'general', instance: 5, cwd: '/two' }))

    expect(store.nextInstance('general', '/one')).toBe(3)
    expect(store.nextInstance('general', '/two')).toBe(6)
    expect(store.nextInstance('general', '/three')).toBe(1)
  })

  it('删掉的实例序号不会回收，避免两个头像撞号', () => {
    const { store } = makeStore()
    store.add(record({ id: 'a1', type: 'general', instance: 1 }))
    store.add(record({ id: 'a2', type: 'general', instance: 2 }))
    store.remove('a2')
    expect(store.nextInstance('general', '/repo')).toBe(2)
  })

  it('窄轨按创建顺序，归档区按归档时间倒序', () => {
    const { store } = makeStore()
    // 活动时间故意乱序：窄轨的稳定顺序看创建时间，不看谁刚活跃过
    store.add(record({ id: 'first', createdAt: 1, lastActiveAt: 99 }))
    store.add(record({ id: 'second', createdAt: 2, lastActiveAt: 1 }))
    store.add(record({ id: 'gone', createdAt: 3, lastActiveAt: 5, archivedAt: 6 }))

    expect(store.visible().map((agent) => agent.id)).toEqual(['first', 'second'])
    expect(store.archived().map((agent) => agent.id)).toEqual(['gone'])
  })

  it('改一条不影响其他条', () => {
    const { store } = makeStore()
    store.add(record({ id: 'a1' }))
    store.add(record({ id: 'a2', instance: 2 }))
    const next = store.update('a1', { turns: 12 })
    expect(next?.turns).toBe(12)
    expect(store.get('a2')?.turns).toBe(0)
    expect(store.update('没有这个', { turns: 1 })).toBeNull()
  })
})

describe('自动归档', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 100 * DAY

  it('超过天数才归档，第 30 天当天不归档', () => {
    const agents = [
      record({ id: 'exactly', lastActiveAt: now - 30 * DAY }),
      record({ id: 'over', lastActiveAt: now - 30 * DAY - 1 }),
      record({ id: 'fresh', lastActiveAt: now })
    ]
    expect(dueForArchive(agents, now, 30).map((agent) => agent.id)).toEqual(['over'])
  })

  it('只挑通用 agent —— 开发与产品可能有没干完的活', () => {
    const agents = [
      record({ id: 'g', lastActiveAt: 0 }),
      record({ id: 'd', type: 'dev', lastActiveAt: 0 }),
      record({ id: 'p', type: 'product', lastActiveAt: 0 })
    ]
    expect(dueForArchive(agents, now, 30).map((agent) => agent.id)).toEqual(['g'])
  })

  it('已归档的不重复挑', () => {
    expect(dueForArchive([record({ lastActiveAt: 0, archivedAt: 5 })], now, 30)).toEqual([])
  })

  it('填 0 或负数表示关掉自动归档', () => {
    const agents = [record({ lastActiveAt: 0 })]
    expect(dueForArchive(agents, now, 0)).toEqual([])
    expect(dueForArchive(agents, now, -1)).toEqual([])
  })

  it('归档与恢复不改原对象', () => {
    const original = record()
    expect(archiveRecord(original, 42).archivedAt).toBe(42)
    expect(original.archivedAt).toBeNull()
    expect(restoreRecord(archiveRecord(original, 42)).archivedAt).toBeNull()
  })
})

describe('旧标签迁移', () => {
  const now = 5_000

  it('每个标签一个通用 agent，名字沿用会话名', () => {
    const result = migrateLegacyTabs(
      [
        { id: 't1', cwd: '/repo', path: '/repo/a.jsonl', title: '修一下登录' },
        { id: 't2', cwd: '/repo', path: '/repo/b.jsonl', title: '大模型管理页' }
      ],
      now
    )
    expect(result.agents).toHaveLength(2)
    expect(result.agents.map((agent) => agent.name)).toEqual(['修一下登录', '大模型管理页'])
    expect(result.agents.every((agent) => agent.type === 'general')).toBe(true)
    expect(result.binding).toEqual([
      { tabId: 't1', agentId: 'agent-t1' },
      { tabId: 't2', agentId: 'agent-t2' }
    ])
  })

  it('同一个会话文件只建一个 agent，两个标签共用它', () => {
    const result = migrateLegacyTabs(
      [
        { id: 't1', cwd: '/repo', path: '/repo/a.jsonl', title: '甲' },
        { id: 't2', cwd: '/repo', path: '/repo/a.jsonl', title: '乙' }
      ],
      now
    )
    expect(result.agents).toHaveLength(1)
    expect(result.binding[0].agentId).toBe('agent-t1')
    expect(result.binding[1].agentId).toBe('agent-t1')
  })

  it('还没落盘的标签各自建一个，不靠路径合并', () => {
    const result = migrateLegacyTabs(
      [
        { id: 't1', cwd: '/repo', path: null, title: '空会话' },
        { id: 't2', cwd: '/repo', path: null, title: '另一个空会话' }
      ],
      now
    )
    expect(result.agents).toHaveLength(2)
    expect(new Set(result.binding.map((item) => item.agentId)).size).toBe(2)
  })

  it('跑两次结果一致（幂等）', () => {
    const tabs = [
      { id: 't1', cwd: '/repo', path: '/repo/a.jsonl', title: '甲' },
      { id: 't2', cwd: '/repo', path: null, title: '乙' }
    ]
    const first = migrateLegacyTabs(tabs, now)
    const second = migrateLegacyTabs(tabs, now)
    expect(second).toEqual(first)
  })

  it('迁移出来的名字沿用旧标签标题 —— 那本来就是会话名', () => {
    const result = migrateLegacyTabs([{ id: 't1', cwd: '/repo', path: '/repo/a.jsonl', title: '新对话' }], now)
    expect(result.agents[0].name).toBe('新对话')
  })

  it('迁移的实例序号按项目分开', () => {
    const result = migrateLegacyTabs(
      [
        { id: 't1', cwd: '/one', path: '/one/a.jsonl', title: '甲' },
        { id: 't2', cwd: '/one', path: '/one/b.jsonl', title: '乙' },
        { id: 't3', cwd: '/two', path: '/two/c.jsonl', title: '丙' }
      ],
      now
    )
    expect(result.agents.map((agent) => [agent.cwd, agent.instance])).toEqual([
      ['/one', 1],
      ['/one', 2],
      ['/two', 1]
    ])
  })

  it('轮数先给 0 —— 迁移不解析会话文件', () => {
    const result = migrateLegacyTabs([{ id: 't1', cwd: '/repo', path: '/repo/a.jsonl', title: '甲' }], now)
    expect(result.agents[0].turns).toBe(0)
  })

  it('迁移出来的记录能被清单读回', () => {
    const { store, file } = makeStore()
    store.replaceAll(migrateLegacyTabs([{ id: 't1', cwd: '/repo', path: '/repo/a.jsonl', title: '甲' }], now).agents)
    const reloaded = new AgentStore(file)
    expect(reloaded.get('agent-t1')).toMatchObject({ name: '甲', type: 'general', cwd: '/repo' })
  })
})

describe('名字来源', () => {
  it('给了名字就用它，没给就用默认名 —— 两种都不会自动跟着会话标题变', () => {
    const auto = newAgentRecord({ id: 'a', type: 'general', instance: 1, cwd: '/r', sessionPath: null, now: 1 })
    expect(auto.name).toBe('通用 1')

    const named = newAgentRecord({
      id: 'b', type: 'general', instance: 2, cwd: '/r', sessionPath: null, now: 1, name: '查登录'
    })
    expect(named.name).toBe('查登录')
  })
})

describe('新建记录', () => {
  it('默认名字、时间戳与归档状态都对', () => {
    const agent = newAgentRecord({
      id: 'a9',
      type: 'product',
      instance: 2,
      cwd: '/repo',
      sessionPath: null,
      now: 777
    })
    expect(agent).toMatchObject({
      name: '产品 2',
      createdAt: 777,
      lastActiveAt: 777,
      archivedAt: null,
      turns: 0
    })
  })

  it('写盘再读回，null 字段不被 JSON 吃掉', () => {
    const { store, file } = makeStore()
    store.add(
      newAgentRecord({ id: 'a9', type: 'product', instance: 2, cwd: '/repo', sessionPath: null, now: 777 })
    )
    const reloaded = new AgentStore(file)
    expect(reloaded.get('a9')?.sessionPath).toBeNull()
    expect(reloaded.get('a9')?.createdAt).toBe(777)
  })
})
