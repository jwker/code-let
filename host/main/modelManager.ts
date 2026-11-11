import { ModelRuntime, SettingsManager, getAgentDir } from '@earendil-works/pi-coding-agent'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AuthPromptRequest,
  ModelAuthEvent,
  ModelEntry,
  ModelSettings,
  ModelSettingsChange,
  ProviderInfo
} from '@contract/models'
import type { ThinkingLevel } from '@contract/index'

/*
 * pi-ai 里的认证类型（`AuthEvent` / `AuthPrompt` / `AuthInteraction`）不在 Codelet 的
 * 直接依赖里 —— 从 `ModelRuntime.login` 的签名反推，不额外引一个包。
 */
type AuthInteraction = Parameters<ModelRuntime['login']>[2]
type AuthEvent = Parameters<AuthInteraction['notify']>[0]
type AuthPrompt = Parameters<AuthInteraction['prompt']>[0]

/**
 * 大模型管理 —— 主进程这一侧。
 *
 * 它自己持有一套 `ModelRuntime` 与 `SettingsManager`，不借用任何标签的：
 * 设置窗口可能一个标签都没有 opened 着，而登录要能独立发生。
 *
 * 登录/登出改的是 agent 目录里的 `auth.json`。别的标签各自的 runtime 缓存了
 * 「哪些模型可用」的结果，所以这里改完要去通知它们重新查一遍 —— 见 `HostState` 那边的接线。
 */

/** 一次待答的提问 —— 渲染进程回话时按 id 找回来 */
interface PendingPrompt {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

/** 登录过程中用到的回调集合 */
export interface ModelManagerEvents {
  /** 把登录过程中的事件发给渲染进程 */
  emit: (event: ModelAuthEvent) => void
}

export class ModelManager {
  /**
   * 运行时与设置管理器。
   *
   * 存的是**建它们的 Promise** —— 页面一打开就是四个并发请求（provider、模型、
   * 设置、models.json），存值的话四个都会各自建一套 ModelRuntime。
   */
  private ready: Promise<{ runtime: ModelRuntime; settings: SettingsManager }> | null = null
  private readonly agentDir: string
  private readonly events: ModelManagerEvents
  /** 待答的提问 */
  private readonly prompts = new Map<string, PendingPrompt>()
  /** 当前登录流程的中止器 */
  private loginAbort: AbortController | null = null
  private promptSeq = 0

  constructor(events: ModelManagerEvents, agentDir = getAgentDir()) {
    this.events = events
    this.agentDir = agentDir
  }

  /**
   * 运行时 —— 第一次用时才建（建它要读目录、可能联网）。
   *
   * 失败就把 ready 清掉 —— 下次再试，而不是一直拿着一个坏掉的 Promise。
   */
  private async ensure(): Promise<{ runtime: ModelRuntime; settings: SettingsManager }> {
    if (!this.ready) {
      this.ready = (async () => {
        const runtime = await ModelRuntime.create({
          authPath: join(this.agentDir, 'auth.json'),
          modelsPath: join(this.agentDir, 'models.json')
        })
        // cwd 只影响「项目级设置」的读；这里写的都是全局设置
        const settings = SettingsManager.create(process.cwd(), this.agentDir)
        return { runtime, settings }
      })().catch((error) => {
        this.ready = null
        throw error
      })
    }
    return this.ready
  }

  /**
   * provider 清单 —— 带凭据状态。
   *
   * 「支持哪些登录方式」直接看 provider 的 `auth` 字段：挂了 `oauth` 就能走 OAuth，
   * 挂了 `apiKey` 就能走密钥。
   */
  async providers(): Promise<ProviderInfo[]> {
    const { runtime } = await this.ensure()
    const out: ProviderInfo[] = []
    for (const provider of runtime.getProviders()) {
      const methods: ProviderInfo['methods'] = []
      if (provider.auth.oauth) methods.push('oauth')
      if (provider.auth.apiKey) methods.push('api_key')
      const status = runtime.getProviderAuthStatus(provider.id)
      out.push({
        providerId: provider.id,
        name: provider.name,
        methods,
        configured: status.configured,
        source: status.source,
        label: status.label,
        subscription: provider.auth.oauth?.isSubscription === true
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * 模型清单 —— 全部对话模型，标出哪些现在能用。
   *
   * 「能用」取的是 runtime 的可用快照（它自己查过凭据）。没凭据的模型也列出来，
   * 但标成不可用 —— 用户能看见「有这个模型，只是没登录」。
   *
   * 只取对话模型（`getModels`）—— 图像模型和分类器模型不在 pi 的 `/model` 里，
   * 是给 codemode 工具用的，不该出现在这一页。
   */
  async models(): Promise<ModelEntry[]> {
    const { runtime } = await this.ensure()
    const available = new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`))
    return runtime.getModels().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      reasoning: model.reasoning === true,
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0
      },
      available: available.has(`${model.provider}/${model.id}`)
    }))
  }

  /** 模型相关的设置 —— 读的是全局与项目合并后的生效值 */
  async readSettings(): Promise<ModelSettings> {
    const { settings } = await this.ensure()
    return {
      defaultProvider: settings.getDefaultProvider() ?? null,
      defaultModel: settings.getDefaultModel() ?? null,
      defaultThinkingLevel: settings.getDefaultThinkingLevel() ?? 'medium',
      modelThinkingLevels: settings.getAllModelThinkingLevels(),
      enabledModels: settings.getEnabledModels() ?? null
    }
  }

  /** 写一项设置 */
  async writeSettings(change: ModelSettingsChange): Promise<boolean> {
    const { settings } = await this.ensure()
    switch (change.kind) {
      case 'defaultModel':
        settings.setDefaultModelAndProvider(change.provider, change.id)
        return true
      case 'thinkingLevel':
        settings.setDefaultThinkingLevel(change.level)
        return true
      case 'modelThinkingLevel':
        if (change.level === null) {
          settings.removeModelThinkingLevel(change.provider, change.id)
        } else {
          settings.setModelThinkingLevel(change.provider, change.id, change.level)
        }
        return true
      case 'enabledModels':
        settings.setEnabledModels(change.ids ?? undefined)
        return true
      default:
        return false
    }
  }

  /**
   * 登录。
   *
   * pi 的登录是「回调式」的：provider 在登录过程中会喊「给我一个 URL」「让我问用户要个密钥」。
   * 这里把这些回调翻译成事件发给渲染进程，渲染进程回话时按 id 找回对应的 Promise。
   */
  async login(providerId: string, method: 'oauth' | 'api_key'): Promise<void> {
    const { runtime, settings } = await this.ensure()

    // 一次只允许一个登录流程 —— 上一个还没结束就再开一个，两个回调会打架
    this.cancelLogin()

    const abort = new AbortController()
    this.loginAbort = abort

    const interaction = {
      signal: abort.signal,
      notify: (event: AuthEvent): void => {
        this.events.emit(this.toEvent(providerId, event))
      },
      prompt: (prompt: AuthPrompt): Promise<string> => {
        const id = `p${++this.promptSeq}`
        const request: AuthPromptRequest = {
          id,
          kind: prompt.type,
          message: prompt.message,
          placeholder: 'placeholder' in prompt ? prompt.placeholder : undefined,
          options: prompt.type === 'select' ? prompt.options.map((o) => ({ ...o })) : undefined
        }
        return new Promise<string>((resolve, reject) => {
          this.prompts.set(id, { resolve, reject })
          // 提问自带的中止信号：流程被取消时，这个提问也就没有意义了
          prompt.signal?.addEventListener('abort', () => {
            if (!this.prompts.delete(id)) return
            reject(new Error('登录已取消'))
          })
          this.events.emit({ type: 'prompt', providerId, prompt: request })
        })
      }
    }

    try {
      await runtime.login(providerId, method, interaction, {
        getDeviceId: () => settings.getOrCreateDeviceId()
      })
      this.events.emit({ type: 'done', providerId, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.events.emit({ type: 'done', providerId, ok: false, message })
    } finally {
      if (this.loginAbort === abort) this.loginAbort = null
      // 流程断了，没答的提问全部作废
      for (const pending of this.prompts.values()) pending.reject(new Error('登录已取消'))
      this.prompts.clear()
    }
  }

  /** 渲染进程回答了一个提问 */
  answerPrompt(promptId: string, value: string): boolean {
    const pending = this.prompts.get(promptId)
    if (!pending) return false
    this.prompts.delete(promptId)
    pending.resolve(value)
    return true
  }

  /** 取消登录 */
  cancelLogin(): void {
    if (this.loginAbort) {
      this.loginAbort.abort()
      this.loginAbort = null
    }
    for (const pending of this.prompts.values()) pending.reject(new Error('登录已取消'))
    this.prompts.clear()
  }

  /** 登出 —— 只删 auth.json 里存的那一份凭据 */
  async logout(providerId: string): Promise<boolean> {
    const { runtime } = await this.ensure()
    try {
      await runtime.logout(providerId, { signal: AbortSignal.timeout(15_000) })
      return true
    } catch {
      return false
    }
  }

  /**
   * 重新查一遍可用性。
   *
   * 登录/登出之后，各标签的 runtime 还拿着旧的「哪些模型可用」——
   * 它们得重新查一次才看得到新登录的 provider 的模型。
   */
  async refresh(): Promise<ModelEntry[]> {
    const { runtime } = await this.ensure()
    try {
      await runtime.refresh({ allowNetwork: true })
    } catch {
      // 联网刷新失败不算错 —— 本地缓存的清单照常用
    }
    return this.models()
  }

  /** models.json 的内容 —— 没有这个文件就是空串 */
  readConfig(): string {
    const path = join(this.agentDir, 'models.json')
    if (!existsSync(path)) return ''
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }

  /** 写 models.json —— 写完重新加载，让新端点立刻生效 */
  async writeConfig(content: string): Promise<boolean> {
    const path = join(this.agentDir, 'models.json')
    try {
      if (content.trim() === '') {
        // 空内容等于删掉这个文件 —— 不留一个空壳
        rmSync(path, { force: true })
      } else {
        JSON.parse(content) // 语法不对就别写
        writeFileSync(path, content, 'utf8')
      }
    } catch {
      return false
    }
    const { runtime } = await this.ensure()
    try {
      await runtime.refresh({ allowNetwork: false })
    } catch {
      // 刷新失败不影响文件本身已经写下去
    }
    return true
  }

  /** pi 的登录事件 → Codelet 的事件 */
  private toEvent(providerId: string, event: AuthEvent): ModelAuthEvent {
    switch (event.type) {
      case 'info':
        return {
          type: 'info',
          providerId,
          message: event.message,
          links: event.links?.map((link) => ({ ...link }))
        }
      case 'auth_url':
        return { type: 'auth_url', providerId, url: event.url, instructions: event.instructions }
      case 'device_code':
        return {
          type: 'device_code',
          providerId,
          userCode: event.userCode,
          verificationUri: event.verificationUri
        }
      case 'progress':
        return { type: 'progress', providerId, message: event.message }
      default:
        return { type: 'progress', providerId, message: '进行中…' }
    }
  }
}

/** 思考等级的取值 —— 与 pi 的八档一致 */
export const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]
