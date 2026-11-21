/**
 * agent 类型的定义（ADR-0004）。
 *
 * 一个类型只决定四件展示与文本上的事 —— 名字、说明、头像颜色、提示词。
 * **能力不在这里**：能不能开预览、有没有区域 5、参不参自动归档，由
 * `capabilitiesOf()` 按内置 id 判定，用户改不了。
 *
 * 内置三个类型（基础 / 开发 / 产品）是这里的常量、不落盘；用户新增的
 * （自定义 agent）存在 `<userData>/agentTypes.json`，由 `AgentTypeStore` 读出来。
 *
 * 本文件跟 contract 其它文件一样不 import 运行时依赖 —— 只有一处 `import type`，
 * 编译后不留 require，所以跟 `agents.ts` 不构成运行时循环。
 */

import type { PaneLayout } from './agents'

/**
 * 用户可选的配色。
 *
 * 每一项在 `tokens.css` 里对应深色、浅色两套 bg/fg —— 所以是预置色板，
 * 不是让用户填 hex：对比度得由应用保证，头像上还有字。
 */
export type AgentColorId =
  | 'graphite'
  | 'blue'
  | 'sky'
  | 'teal'
  | 'green'
  | 'olive'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'pink'
  | 'purple'
  | 'berry'

/** 色板顺序 —— 默认配色按这个顺序找「用得最少」的一组 */
export const AGENT_COLORS: readonly AgentColorId[] = [
  'graphite',
  'blue',
  'sky',
  'teal',
  'green',
  'olive',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'berry'
]

/** 色板的中文名 —— 设置页的色块悬停提示用它 */
export const AGENT_COLOR_LABEL: Record<AgentColorId, string> = {
  graphite: '石墨',
  blue: '蓝',
  sky: '天蓝',
  teal: '青',
  green: '绿',
  olive: '橄榄',
  yellow: '黄',
  orange: '橙',
  red: '红',
  pink: '粉',
  purple: '紫',
  berry: '莓红'
}

/** 各个字段的上限。按 Unicode 码点算，见 `charCount` */
export const AGENT_TYPE_LIMITS = {
  /** 名字 */
  name: 12,
  /** 一句话说明 */
  description: 60,
  /** 提示词 */
  prompt: 4000,
  /** 自定义 agent 的个数上限 */
  custom: 50
} as const

/** 类型找不到定义时，默认名里用的名字 */
export const UNKNOWN_AGENT_TYPE_NAME = '未知'

/** 类型找不到定义时，界面上显示的类型名 */
export const UNKNOWN_AGENT_TYPE_LABEL = '未知 agent'

/**
 * 一份基础 agent 的定义。
 *
 * `builtin: true` 的三条来自 `BUILTIN_AGENT_TYPES`，名字、说明、颜色只读，
 * 只有提示词可以被用户改（改过的提示词落在 `agentTypes.json` 的 `prompts` 里）。
 */
export interface AgentTypeDef {
  /** 内置是 'general' | 'dev' | 'product'；自定义是 't-' + 8 位十六进制 */
  id: string
  name: string
  /** 一句话说明，可空 */
  description: string
  /** 提示词，可空。原样注入，不解析占位符 */
  prompt: string
  /** 自定义类型必填；内置为 null（用 `--av-<id>-*` 那套固定配色） */
  color: AgentColorId | null
  builtin: boolean
}

/** 一个类型能做什么。用户不能配置，全由代码按内置 id 判定 */
export interface AgentCapabilities {
  /** 区域 6 是原型预览（产品 agent 独有） */
  preview: boolean
  /** 参与自动归档（只认基础 agent） */
  autoArchive: boolean
  /** 区域 5 的布局；null 表示没有区域 5 */
  zone5: PaneLayout | null
}

/**
 * 内置的三个类型。
 *
 * 顺序就是界面上出现的顺序：基础在最前，新建 agent 默认选它。
 * 提示词这里是空串 —— 用户改过的部分不在常量里，读写都走 `AgentTypeStore`。
 */
export const BUILTIN_AGENT_TYPES: readonly AgentTypeDef[] = [
  {
    id: 'general',
    name: '基础',
    description: '普通对话，没有额外能力。',
    prompt: '',
    color: null,
    builtin: true
  },
  {
    id: 'dev',
    name: '开发',
    description: '改代码为主。',
    prompt: '',
    color: null,
    builtin: true
  },
  {
    id: 'product',
    name: '产品',
    description: '写原型，右侧带预览。',
    prompt: '',
    color: null,
    builtin: true
  }
]

/** 按 id 找内置定义；不是内置的返回 null */
export function builtinTypeDef(id: string): AgentTypeDef | null {
  return BUILTIN_AGENT_TYPES.find((def) => def.id === id) ?? null
}

/**
 * 一个类型的能力。
 *
 * `null` 是「未知 agent」：一列对话、不注入提示词、不参与自动归档。
 * 自定义类型跟基础 agent 一样什么都不带 —— 用户以后能配工具、技能时，
 * 这里才是加分支的地方。
 */
export function capabilitiesOf(def: AgentTypeDef | null): AgentCapabilities {
  if (!def) return { preview: false, autoArchive: false, zone5: null }
  if (def.builtin && def.id === 'product') {
    // 对话比文件树宽，下限也更高
    return { preview: true, autoArchive: false, zone5: { zone5: 380, zone5Min: 320 } }
  }
  if (def.builtin && def.id === 'general') {
    return { preview: false, autoArchive: true, zone5: null }
  }
  return { preview: false, autoArchive: false, zone5: null }
}

/**
 * 字数。
 *
 * 用码点而不是 `String.length` —— 一个 emoji 在 UTF-16 里算两个，
 * 4000 字的上限不该因为打了一个表情就少一格。
 */
export function charCount(text: string): number {
  return Array.from(text).length
}

/**
 * 新建 agent 时的默认名字：定义名 + 实例序号。
 *
 * 用户改过名之后就用他自己的名字，这个只在创建时算一次。
 * 类型找不到定义时用「未知」——不会出现「undefined 3」。
 */
export function defaultAgentName(def: AgentTypeDef | null, instance: number): string {
  return `${def?.name ?? UNKNOWN_AGENT_TYPE_NAME} ${instance}`
}

/** 设置面板提交的一份草稿。id 由宿主生成，创建时不在草稿里 */
export interface AgentTypeDraft {
  name: string
  description: string
  prompt: string
  color: AgentColorId
}

/** 校验结果：成功时给出去掉首尾空格的规范值 */
export type AgentTypeValidation =
  | { ok: true; value: AgentTypeDraft }
  | { ok: false; error: string }

/** 新建 / 修改的结果。失败时 `error` 是能直接显示给用户的一句话 */
export type AgentTypeSaveResult =
  | { ok: true; type: AgentTypeDef }
  | { ok: false; error: string }

/** 删除的结果。`usedBy` 是有多少个 agent 在用它 —— 有就不让删 */
export type AgentTypeRemoveResult =
  | { ok: true }
  | { ok: false; error: string; usedBy?: number }

const COLOR_SET = new Set<string>(AGENT_COLORS)

/**
 * 校验一份草稿。
 *
 * 主进程与渲染进程共用：渲染层用来即时提示，主进程用来挡住越界值。
 * `existing` 是当前全部定义（含内置）—— 名字全局唯一，连「基础」也不能重。
 * `selfId` 是正在编辑的那一条，比对重名时排除自己。
 */
export function validateTypeDraft(
  draft: AgentTypeDraft,
  existing: readonly AgentTypeDef[],
  selfId?: string | null
): AgentTypeValidation {
  const name = draft.name.trim()
  if (name === '') return { ok: false, error: '名字不能为空' }
  if (charCount(name) > AGENT_TYPE_LIMITS.name) {
    return { ok: false, error: `名字最多 ${AGENT_TYPE_LIMITS.name} 个字` }
  }
  if (existing.some((def) => def.id !== selfId && def.name === name)) {
    return { ok: false, error: '已经有同名的 agent' }
  }
  const description = draft.description.trim()
  if (charCount(description) > AGENT_TYPE_LIMITS.description) {
    return { ok: false, error: `说明最多 ${AGENT_TYPE_LIMITS.description} 个字` }
  }
  if (charCount(draft.prompt) > AGENT_TYPE_LIMITS.prompt) {
    return { ok: false, error: `提示词最多 ${AGENT_TYPE_LIMITS.prompt} 个字` }
  }
  if (!COLOR_SET.has(draft.color)) return { ok: false, error: '颜色不在可选范围里' }
  return {
    ok: true,
    value: { name, description, prompt: draft.prompt, color: draft.color }
  }
}

/**
 * 新建时默认给哪一组颜色：当前用得最少的那一组。
 *
 * 12 组色板、50 个上限，重复不可避免 —— 颜色只是识别辅助，允许重复，
 * 用户随时能改。平手时按色板顺序取，保证结果稳定。
 */
export function leastUsedColor(types: readonly AgentTypeDef[]): AgentColorId {
  const used = new Map<AgentColorId, number>()
  for (const color of AGENT_COLORS) used.set(color, 0)
  for (const def of types) {
    if (def.color && used.has(def.color)) used.set(def.color, (used.get(def.color) ?? 0) + 1)
  }
  let best: AgentColorId = AGENT_COLORS[0]!
  for (const color of AGENT_COLORS) {
    if ((used.get(color) ?? 0) < (used.get(best) ?? 0)) best = color
  }
  return best
}
