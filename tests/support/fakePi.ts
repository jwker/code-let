import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeStubs } from './runtimeTree'
import type {
  AgentRuntimeState,
  PiEventListener,
  PiRuntimePort
} from '../../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 宿主测试用的假 runtime。
 *
 * 只记三件事：每个 agent 登记时拿到的参数（尤其 `appendSystemPrompt`）、
 * 重建时拿到的参数、以及会话文件路径。真 runtime 要模型和凭据，测不动。
 */
export class FakePi implements PiRuntimePort {
  readTree = treeStubs.readTree
  navigateTree = treeStubs.navigateTree
  forkTree = treeStubs.forkTree
  labelTree = treeStubs.labelTree

  private listeners = new Set<PiEventListener>()
  /** 每个 agent 的会话文件（openAgent 时给的，或者假装算出来的） */
  readonly files = new Map<string, string | null>()
  /** openAgent 收到的参数 */
  readonly opened: Array<{ agentId: string; options: Record<string, unknown> }> = []
  /** reloadAgent 收到的参数 */
  readonly reloaded: Array<{ agentId: string; options?: { appendSystemPrompt?: string[] } }> = []

  onEvent(listener: PiEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  hasAgent(agentId: string): boolean {
    return this.files.has(agentId)
  }

  async openAgent(agentId: string, options: Record<string, unknown>): Promise<void> {
    this.opened.push({ agentId, options })
    const path = typeof options.path === 'string' ? options.path : join(tmpdir(), `fake-${agentId}.jsonl`)
    this.files.set(agentId, path)
  }

  async closeAgent(agentId: string): Promise<void> {
    this.files.delete(agentId)
  }

  async activateAgent(): Promise<void> {}

  async reloadAgent(
    agentId: string,
    options?: { appendSystemPrompt?: string[] }
  ): Promise<void> {
    this.reloaded.push({ agentId, ...(options ? { options } : {}) })
  }

  agentState(agentId: string): AgentRuntimeState {
    return {
      ready: this.files.has(agentId),
      sessionId: `s-${agentId}`,
      sessionFile: this.files.get(agentId) ?? null,
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

  /** 某个 agent 最近一次登记时拿到的提示片段 */
  promptFragmentsOf(agentId: string): string[] | undefined {
    const last = [...this.opened].reverse().find((item) => item.agentId === agentId)
    const value = last?.options.appendSystemPrompt
    return Array.isArray(value) ? (value as string[]) : undefined
  }
}
