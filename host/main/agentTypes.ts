import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  AGENT_COLORS,
  AGENT_TYPE_LIMITS,
  BUILTIN_AGENT_TYPES,
  builtinTypeDef,
  leastUsedColor,
  validateTypeDraft,
  type AgentColorId,
  type AgentTypeDef,
  type AgentTypeDraft,
  type AgentTypeRemoveResult,
  type AgentTypeSaveResult
} from '@contract/index'

/**
 * agent 类型的定义清单（ADR-0004）。
 *
 * 存 `<userData>/agentTypes.json`，三个内置类型**不在这里** —— 它们是
 * `contract/agentTypes.ts` 的常量，名字、说明、颜色永远来自代码。这个文件只管两件事：
 *
 * - `types`：用户新增的自定义 agent；
 * - `prompts`：内置三个被改过的提示词（键是内置 id）。
 *
 * 读写风格照 `AgentStore`：文件坏了当空的、写不进去不影响主流程、**永不删用户数据**。
 * 「类型不认识」不是这里的事 —— `agents.json` 里的旧记录由渲染层按未知 agent 兜底。
 */

/** 落盘的一条自定义 agent */
export interface UserAgentTypeRecord {
  id: string
  name: string
  description: string
  prompt: string
  color: AgentColorId
  createdAt: number
}

interface AgentTypesFile {
  version: 1
  types: UserAgentTypeRecord[]
  prompts: Record<string, string>
}

const COLOR_SET = new Set<string>(AGENT_COLORS)

/** 文件是更新版本写的 —— 只读，别拿旧格式盖回去 */
const VERSION_ERROR = '这个文件是更新版本的应用写的，改不了'

/** 自定义类型的 id：`t-` + 8 位十六进制。跟名字无关，改名不改 id */
export function newAgentTypeId(): string {
  return `t-${randomBytes(4).toString('hex')}`
}

/**
 * 从磁盘读回来的一条能不能用。
 *
 * 判定从严：坏的那条丢掉而不是补默认值 —— 名字或颜色补错会让界面出现
 * 两个同名类型，或者一个看不清头像的类型。
 */
function readUserType(raw: unknown): UserAgentTypeRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') return null
  // 内置 id 不许从文件里冒出来：那会让内置定义的只读字段变成可写的
  if (builtinTypeDef(value.id)) return null
  if (typeof value.name !== 'string' || value.name.trim() === '') return null
  if (typeof value.color !== 'string' || !COLOR_SET.has(value.color)) return null
  const description = typeof value.description === 'string' ? value.description : ''
  const prompt = typeof value.prompt === 'string' ? value.prompt : ''
  return {
    id: value.id,
    name: value.name,
    description,
    prompt,
    color: value.color as AgentColorId,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0
  }
}

/** 落盘的一条转成界面用的定义 */
function toDef(record: UserAgentTypeRecord): AgentTypeDef {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    prompt: record.prompt,
    color: record.color,
    builtin: false
  }
}

/** agent 类型清单 */
export class AgentTypeStore {
  private types: UserAgentTypeRecord[] = []
  private prompts: Record<string, string> = {}
  /**
   * 文件是更新版本写的。
   *
   * 这时**只读**：按空清单读出来不报错（内置三个照旧可用），但任何写入都被拒绝 ——
   * 用旧版本覆盖新版本的文件会把用户更新的字段静默抹掉。
   */
  private unsupportedVersion = false
  private readonly file: string

  constructor(file: string) {
    this.file = file
    this.load()
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AgentTypesFile>
      // 版本不认识就不动这份文件 —— 新版本写的字段不能被旧版本覆盖掉
      if (raw?.version !== 1) {
        this.unsupportedVersion = true
        return
      }
      if (Array.isArray(raw.types)) {
        this.types = raw.types
          .map(readUserType)
          .filter((record): record is UserAgentTypeRecord => record !== null)
      }
      if (raw.prompts && typeof raw.prompts === 'object') {
        for (const def of BUILTIN_AGENT_TYPES) {
          const prompt = (raw.prompts as Record<string, unknown>)[def.id]
          if (typeof prompt === 'string') this.prompts[def.id] = prompt
        }
      }
    } catch {
      // 文件坏了当空清单。内置三个照旧可用，agent 记录一条不动
      this.types = []
      this.prompts = {}
    }
  }

  private save(): void {
    if (this.unsupportedVersion) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const payload: AgentTypesFile = {
        version: 1,
        types: this.types,
        prompts: this.prompts
      }
      writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8')
    } catch {
      // 写不进去也不能影响主流程
    }
  }

  /**
   * 全部定义：内置三个（带改过的提示词）在前，自定义按创建顺序在后。
   *
   * 渲染层拿到这一份就够了，不用自己拼内置与自定义。
   */
  list(): AgentTypeDef[] {
    const builtin = BUILTIN_AGENT_TYPES.map((def) => ({
      ...def,
      prompt: this.prompts[def.id] ?? ''
    }))
    const custom = [...this.types]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(toDef)
    return [...builtin, ...custom]
  }

  /** 按 id 找定义；找不到就是 null（未知 agent） */
  get(id: string): AgentTypeDef | null {
    return this.list().find((def) => def.id === id) ?? null
  }

  /** 自定义类型的条数 —— 上限按它算 */
  customCount(): number {
    return this.types.length
  }

  /** 新建时默认选哪一组颜色 */
  suggestedColor(): AgentColorId {
    return leastUsedColor(this.types.map(toDef))
  }

  /** 新建一个自定义 agent。名字、长度、颜色都走契约里的同一份校验 */
  create(draft: AgentTypeDraft, now: number): AgentTypeSaveResult {
    if (this.unsupportedVersion) return { ok: false, error: VERSION_ERROR }
    if (this.types.length >= AGENT_TYPE_LIMITS.custom) {
      return { ok: false, error: `最多 ${AGENT_TYPE_LIMITS.custom} 个自定义 agent` }
    }
    const checked = validateTypeDraft(draft, this.list())
    if (!checked.ok) return checked
    const record: UserAgentTypeRecord = {
      id: newAgentTypeId(),
      name: checked.value.name,
      description: checked.value.description,
      prompt: checked.value.prompt,
      color: checked.value.color,
      createdAt: now
    }
    this.types = [...this.types, record]
    this.save()
    return { ok: true, type: toDef(record) }
  }

  /**
   * 改一个。
   *
   * 内置类型只收提示词 —— 名字、说明、颜色由应用提供，界面也不给改；
   * 传进来的其它字段照收不误地忽略，不报错（界面只是把整份草稿发回来）。
   */
  update(id: string, draft: AgentTypeDraft): AgentTypeSaveResult {
    if (this.unsupportedVersion) return { ok: false, error: VERSION_ERROR }
    const builtin = builtinTypeDef(id)
    if (builtin) {
      const prompt = draft.prompt
      if (Array.from(prompt).length > AGENT_TYPE_LIMITS.prompt) {
        return { ok: false, error: `提示词最多 ${AGENT_TYPE_LIMITS.prompt} 个字` }
      }
      if (prompt === '') delete this.prompts[id]
      else this.prompts[id] = prompt
      this.save()
      return { ok: true, type: { ...builtin, prompt } }
    }

    const index = this.types.findIndex((record) => record.id === id)
    if (index < 0) return { ok: false, error: '这个 agent 类型不在了' }
    const checked = validateTypeDraft(draft, this.list(), id)
    if (!checked.ok) return checked
    const next: UserAgentTypeRecord = {
      ...this.types[index]!,
      name: checked.value.name,
      description: checked.value.description,
      prompt: checked.value.prompt,
      color: checked.value.color
    }
    this.types = [
      ...this.types.slice(0, index),
      next,
      ...this.types.slice(index + 1)
    ]
    this.save()
    return { ok: true, type: toDef(next) }
  }

  /**
   * 删一个自定义类型。
   *
   * **有没有 agent 在用由调用方查** —— 这个类只认识自己的文件，
   * 不认识 agent 清单。内置类型没有删除这回事。
   */
  remove(id: string): AgentTypeRemoveResult {
    if (this.unsupportedVersion) return { ok: false, error: VERSION_ERROR }
    if (builtinTypeDef(id)) return { ok: false, error: '内置的 agent 类型不能删除' }
    const exists = this.types.some((record) => record.id === id)
    if (!exists) return { ok: false, error: '这个 agent 类型不在了' }
    this.types = this.types.filter((record) => record.id !== id)
    this.save()
    return { ok: true }
  }
}
