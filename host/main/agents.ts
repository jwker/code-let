import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AgentType } from '@contract/index'
import { defaultAgentName } from '@contract/index'

/**
 * agent 清单的落盘与读写（PLAN.md D53）。
 *
 * 归宿主，存 `<userData>/agents.json`。读写风格照抄 `tabs.ts` 的 `TabStore`：
 * 文件坏了当空的，写不进去不影响主流程，**永不删用户数据**（底线 2）。
 *
 * 这里只管清单本身。runtime、会话文件、归档动作的副作用都在 `HostState`。
 */

/** 落盘的一条 agent */
export interface AgentRecord {
  /** agent 的稳定 id —— runtime 以它为键（D58） */
  id: string
  name: string
  type: AgentType
  /** 同类型里的第几个实例，从 1 开始 */
  instance: number
  cwd: string
  /**
   * 会话文件路径。
   *
   * 跟 `agentId` **分开存**（D54）：归档本来就在挂回、移走会话文件，
   * 将来支持「一个 agent 多条会话」时只改读写代码，不动磁盘上的历史。
   *
   * 新建的 agent 在第一条用户消息之前还没有文件 —— 那时是 null。
   */
  sessionPath: string | null
  createdAt: number
  /** 最后活动时间，自动归档按它算（D55） */
  lastActiveAt: number
  /** 归档时间；null = 在窄轨里 */
  archivedAt: number | null
  /** 用户消息条数 */
  turns: number
}

interface AgentsFile {
  version: 1
  agents: AgentRecord[]
}

const AGENT_TYPES: readonly AgentType[] = ['general', 'dev', 'product']

function isType(value: unknown): value is AgentType {
  return typeof value === 'string' && (AGENT_TYPES as readonly string[]).includes(value)
}

/** 一天的毫秒数 —— 归档天数按它折算 */
const DAY = 24 * 60 * 60 * 1000

/**
 * 从磁盘读回来的一条能不能用。
 *
 * 判定从严：少一个必需字段就丢掉这条，而不是拿默认值补 ——
 * 补出来的 agent 会指向一个不存在的会话，比少一条更难查。
 */
function readRecord(raw: unknown): AgentRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') return null
  if (typeof value.name !== 'string') return null
  if (!isType(value.type)) return null
  if (typeof value.instance !== 'number' || !Number.isFinite(value.instance)) return null
  if (typeof value.cwd !== 'string' || value.cwd === '') return null
  // 可选字段缺省等同于 null —— 手改过的文件、或者更早的版本写出来的记录都别丢
  if (value.sessionPath !== null && value.sessionPath !== undefined && typeof value.sessionPath !== 'string') {
    return null
  }
  if (typeof value.lastActiveAt !== 'number' || !Number.isFinite(value.lastActiveAt)) return null
  if (value.archivedAt !== null && value.archivedAt !== undefined && typeof value.archivedAt !== 'number') {
    return null
  }
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    instance: Math.max(1, Math.floor(value.instance)),
    cwd: value.cwd,
    sessionPath: (value.sessionPath as string | null) ?? null,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : value.lastActiveAt,
    lastActiveAt: value.lastActiveAt,
    archivedAt: (value.archivedAt as number | null) ?? null,
    turns: typeof value.turns === 'number' && value.turns >= 0 ? Math.floor(value.turns) : 0
  }
}

/** agent 清单 */
export class AgentStore {
  private agents: AgentRecord[] = []
  private readonly file: string

  constructor(file: string) {
    this.file = file
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AgentsFile>
      if (!Array.isArray(raw?.agents)) return
      this.agents = raw.agents
        .map(readRecord)
        .filter((record): record is AgentRecord => record !== null)
    } catch {
      // 清单坏了就当空的。会话文件还在磁盘上，导入入口能把它们找回来
      this.agents = []
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const payload: AgentsFile = { version: 1, agents: this.agents }
      writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8')
    } catch {
      // 写不进去也不能影响主流程
    }
  }

  /** 全部，含已归档 */
  list(): AgentRecord[] {
    return this.agents
  }

  get(id: string): AgentRecord | null {
    return this.agents.find((agent) => agent.id === id) ?? null
  }

  /** 整体替换（迁移和测试用） */
  replaceAll(agents: AgentRecord[]): void {
    this.agents = agents
    this.save()
  }

  add(record: AgentRecord): void {
    this.agents = [...this.agents.filter((agent) => agent.id !== record.id), record]
    this.save()
  }

  /** 改一条。返回改完的记录；id 不存在返回 null */
  update(id: string, patch: Partial<AgentRecord>): AgentRecord | null {
    const index = this.agents.findIndex((agent) => agent.id === id)
    if (index < 0) return null
    const next = { ...this.agents[index], ...patch }
    this.agents = [...this.agents.slice(0, index), next, ...this.agents.slice(index + 1)]
    this.save()
    return next
  }

  remove(id: string): void {
    this.agents = this.agents.filter((agent) => agent.id !== id)
    this.save()
  }

  /**
   * 下一个实例序号 —— **按项目算**，不是全局。
   *
   * 窄轨只列当前项目的 agent（D51），所以「第 3 个」必须是在这个项目里数第 3 个；
   * 全局编号会出现「这个项目只有一个 agent，角标却写着 5」这种看不懂的情况。
   */
  nextInstance(type: AgentType, cwd: string): number {
    const used = this.agents
      .filter((agent) => agent.type === type && agent.cwd === cwd)
      .map((agent) => agent.instance)
    return used.length === 0 ? 1 : Math.max(...used) + 1
  }

  /**
   * 窄轨里的：没归档的，**按创建顺序**。
   *
   * 顺序定在宿主这一侧、按创建排 —— 跟标签栏的顺序一致，关掉一个时「落到相邻的一个」
   * 才有意义。按活动时间排的话，点一下某个 agent 它就会换位置，关标签时的邻居也就跟着跳。
   *
   * 想按最近活动排的是渲染层的显示选择（`AgentInfo.lastActiveAt` 已经给出去了）。
   */
  visible(): AgentRecord[] {
    return this.agents
      .filter((agent) => agent.archivedAt === null)
      .sort((a, b) => a.createdAt - b.createdAt || a.instance - b.instance)
  }

  /** 归档区里的：按归档时间倒序 */
  archived(): AgentRecord[] {
    return this.agents
      .filter((agent) => agent.archivedAt !== null)
      .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  }
}

// ---------------------------------------------------------------------------
// 纯函数：不做 IO，测试直接调用
// ---------------------------------------------------------------------------

/** 新建一条 agent 记录 */
export function newAgentRecord(input: {
  id: string
  type: AgentType
  instance: number
  cwd: string
  sessionPath: string | null
  now: number
  name?: string
}): AgentRecord {
  return {
    id: input.id,
    name: input.name ?? defaultAgentName(input.type, input.instance),
    type: input.type,
    instance: input.instance,
    cwd: input.cwd,
    sessionPath: input.sessionPath,
    createdAt: input.now,
    lastActiveAt: input.now,
    archivedAt: null,
    turns: 0
  }
}

/**
 * 该自动归档的 agent（D55）。
 *
 * 三条规则：只挑通用 agent、跳过已归档的、`days <= 0` 表示关掉自动归档。
 * 「超过」按严格大于算 —— 第 30 天当天还不归档，满 30 天才算。
 */
export function dueForArchive(
  agents: readonly AgentRecord[],
  now: number,
  days: number
): AgentRecord[] {
  if (!Number.isFinite(days) || days <= 0) return []
  const cutoff = days * DAY
  return agents.filter(
    (agent) => agent.archivedAt === null && agent.type === 'general' && now - agent.lastActiveAt > cutoff
  )
}

/** 归档一条（返回新对象，不改原对象） */
export function archiveRecord(agent: AgentRecord, now: number): AgentRecord {
  return { ...agent, archivedAt: now }
}

/** 恢复一条 */
export function restoreRecord(agent: AgentRecord): AgentRecord {
  return { ...agent, archivedAt: null }
}

/**
 * 迁移用：一条旧标签（`TabStore` 的 `StoredTab`）。
 *
 * 这里只声明用得到的字段，不 import `tabs.ts` —— 迁移函数保持纯的，
 * 将来 `tabs.ts` 改成项目标签时这段不用跟着改。
 */
export interface LegacyTab {
  id: string
  cwd: string
  path: string | null
  title: string
}

/**
 * 把旧的会话标签列表迁成 agent 清单（D59）。
 *
 * 规则：
 * - 每条标签一个**通用** agent —— 现存会话都还没有类型，默认通用最不意外。
 * - **同一个会话文件只建一个 agent**：两个标签指向同一条会话时共用一个 agent，
 *   否则两条 runtime 会写同一个文件。
 * - 没有会话文件的标签（从没发过消息）各自建一个，不能靠 path 合并。
 * - id 由标签 id 派生（`agent-<tabId>`），所以**同一个输入跑两次结果一致**。
 *
 * 轮数这里给 0：算它要解析会话文件，迁移不该为此读几十个 jsonl。
 * 第一次打开这个 agent 时再由 `HostState` 补上。
 */
export function migrateLegacyTabs(
  tabs: readonly LegacyTab[],
  now: number
): { agents: AgentRecord[]; binding: Array<{ tabId: string; agentId: string }> } {
  const agents: AgentRecord[] = []
  const binding: Array<{ tabId: string; agentId: string }> = []
  const byPath = new Map<string, string>()
  /** 每个项目各自的实例计数 —— 窄轨是项目级的，编号也要按项目 */
  const perCwd = new Map<string, number>()

  for (const tab of tabs) {
    const shared = tab.path ? byPath.get(tab.path) : undefined
    if (shared) {
      binding.push({ tabId: tab.id, agentId: shared })
      continue
    }
    const instance = (perCwd.get(tab.cwd) ?? 0) + 1
    perCwd.set(tab.cwd, instance)
    const id = `agent-${tab.id}`
    agents.push(
      newAgentRecord({
        id,
        type: 'general',
        instance,
        cwd: tab.cwd,
        sessionPath: tab.path,
        now,
        // 旧标签的标题就是会话名，留着比「通用 3」好认
        name: tab.title
      })
    )
    if (tab.path) byPath.set(tab.path, id)
    binding.push({ tabId: tab.id, agentId: id })
  }

  return { agents, binding }
}
