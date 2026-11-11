/**
 * 大模型管理 —— 主进程与渲染进程之间的契约。
 *
 * 这一页把 pi 的模型管理搬进设置窗口：凭据（登录/登出）、模型清单（启停与排序）、
 * 默认模型与思考等级、自定义端点。
 *
 * 设置项本身存在 **pi 的全局 settings.json**（agent 目录）里，不在 Codelet 自己的
 * settings.json —— 因为「设为新会话默认」那条既有路径（`session.setModel(..., {persist})`）
 * 写的就是那儿。两边写一处，值才不会打架。
 */

import type { ThinkingLevel } from './index'

/** 一个 provider 的凭据状态 */
export interface ProviderInfo {
  providerId: string
  /** 显示名 */
  name: string
  /** 这个 provider 支持的登录方式 */
  methods: Array<'oauth' | 'api_key'>
  /** 已经配好凭据了 */
  configured: boolean
  /** 凭据来源：stored / environment / models_json_key … */
  source?: string
  /** 来源的可读标签（例如环境变量名） */
  label?: string
  /** OAuth 走的是订阅账号 */
  subscription: boolean
}

/** 模型清单里的一项 */
export interface ModelEntry {
  provider: string
  id: string
  /** 显示名 */
  name: string
  /** 上下文窗口（token） */
  contextWindow: number
  /** 支不支持思考强度 */
  reasoning: boolean
  /** 每百万 token 的价格（美元） */
  cost: { input: number; output: number }
  /** 现在有可用凭据 —— 没有的选了会报错 */
  available: boolean
}

/** 模型相关的设置（读出来的是合并后的生效值） */
export interface ModelSettings {
  /** 默认模型的 provider */
  defaultProvider: string | null
  /** 默认模型的 id */
  defaultModel: string | null
  /** 默认思考等级 */
  defaultThinkingLevel: ThinkingLevel
  /** 每模型的思考等级覆盖，key 是 `provider/id` */
  modelThinkingLevels: Record<string, ThinkingLevel>
  /**
   * 启用的模型清单（`provider/id`）。
   *
   * null 表示不限制 —— 全部可用。空数组表示一个都不启用。
   * 数组的顺序就是模型选择器里的排列顺序。
   */
  enabledModels: string[] | null
}

/** 一次设置变更 */
export type ModelSettingsChange =
  | { kind: 'defaultModel'; provider: string; id: string }
  | { kind: 'thinkingLevel'; level: ThinkingLevel }
  | { kind: 'modelThinkingLevel'; provider: string; id: string; level: ThinkingLevel | null }
  | { kind: 'enabledModels'; ids: string[] | null }

/** 登录过程中要用户填的东西 */
export interface AuthPromptRequest {
  id: string
  kind: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string; description?: string }>
}

/**
 * 登录过程中的事件 —— 主进程发给渲染进程。
 *
 * 形态照 pi 的 `AuthEvent`，另外加了两个：一个是把「要填东西」也变成事件
 * （pi 那边是回调，跨进程只能这么传），一个是收尾。
 */
export type ModelAuthEvent =
  | { type: 'info'; providerId: string; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: 'auth_url'; providerId: string; url: string; instructions?: string }
  | { type: 'device_code'; providerId: string; userCode: string; verificationUri: string }
  | { type: 'progress'; providerId: string; message: string }
  | { type: 'prompt'; providerId: string; prompt: AuthPromptRequest }
  | { type: 'done'; providerId: string; ok: boolean; message?: string }
