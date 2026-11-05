import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PiEvent, PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { CommandOption, ModelOption, StreamItem } from '@contract/index'

/** 临时对话的宿主生命周期（D40）：内存会话、不写标签、关闭即释放。 */

const MODEL: ModelOption = {
  provider: 'fake',
  id: 'model',
  name: 'Fake',
  contextWindow: 1000,
  reasoning: false,
  cost: { input: 0, output: 0 }
}

class FakePi implements PiRuntimePort {
  readonly tabs = new Map<string, { cwd: string; inMemory: boolean; model: ModelOption | null }>()
  readonly prompts: Array<{
    tabId: string
    text: string
    options?: { expandPromptTemplates?: boolean }
  }> = []
  readonly closes: string[] = []
  readonly models: Array<{ tabId: string; provider: string; id: string; persist: boolean }> = []

  onEvent(_listener: PiEventListener): () => void {
    return () => {}
  }
  async openTab(tabId: string, options: { cwd: string; inMemory?: boolean }): Promise<void> {
    this.tabs.set(tabId, { cwd: options.cwd, inMemory: options.inMemory === true, model: MODEL })
  }
  async closeTab(tabId: string): Promise<void> {
    this.closes.push(tabId)
    this.tabs.delete(tabId)
  }
  async activateTab(): Promise<void> {}
  async reloadTab(): Promise<void> {}
  tabState(tabId: string): TabRuntimeState {
    const tab = this.tabs.get(tabId)
    return {
      ready: Boolean(tab),
      sessionId: tab ? `s-${tabId}` : null,
      sessionFile: null,
      streaming: false,
      model: tab?.model ?? null,
      thinkingLevel: null,
      modelFallback: null
    }
  }
  readEntries(): StreamItem[] {
    return []
  }
  async listModels(): Promise<ModelOption[]> {
    return [MODEL]
  }
  async selectModel(tabId: string, provider: string, id: string, persist: boolean): Promise<void> {
    this.models.push({ tabId, provider, id, persist })
    const tab = this.tabs.get(tabId)
    if (tab) tab.model = MODEL
  }
  async renameSession(): Promise<void> {}
  async setSessionName(): Promise<void> {}
  async listCommands(): Promise<CommandOption[]> {
    return []
  }
  async completeCommand(): Promise<never[]> {
    return []
  }
  thinkingLevels(): never[] {
    return []
  }
  setThinkingLevel(): void {}
  async compactTab(): Promise<void> {}
  async prompt(
    tabId: string,
    text: string,
    _images?: unknown,
    options?: { expandPromptTemplates?: boolean }
  ): Promise<void> {
    this.prompts.push({ tabId, text, options })
  }
  async abortTab(): Promise<void> {}
  async stop(): Promise<void> {}

  emit(_event: PiEvent): void {}
}

const dirs: string[] = []
let state: HostState | null = null

function setup(pickFiles?: () => Promise<string[] | null>) {
  const root = mkdtempSync(join(tmpdir(), 'codelet-temp-host-'))
  dirs.push(root)
  const projects = new ProjectStore(join(root, 'projects.json'))
  projects.add(root)
  const pi = new FakePi()
  state = new HostState({
    pi,
    projects,
    tabStore: new TabStore(join(root, 'tabs.json')),
    pickFiles,
    trashFile: async () => {}
  })
  return { root, pi }
}

afterEach(async () => {
  await state?.dispose()
  state = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('临时对话宿主', () => {
  it('打开内存会话，不进入标签和标签存储；关闭后释放，重开是新 id', async () => {
    const { root, pi } = setup()
    await state!.init()
    await state!.newConversation(root)
    const tabsBefore = state!.snapshot().tabs.map((tab) => tab.id)

    const opened = await state!.openTemporaryChat()
    const temp = opened.temporaryChat
    expect(temp).not.toBeNull()
    expect(pi.tabs.get(temp!.id)?.inMemory).toBe(true)
    expect(state!.snapshot().tabs.map((tab) => tab.id)).toEqual(tabsBefore)
    expect(pi.models).toEqual([
      { tabId: temp!.id, provider: MODEL.provider, id: MODEL.id, persist: false }
    ])

    await state!.promptTemporary(temp!.id, '你好')
    expect(pi.prompts).toEqual([
      { tabId: temp!.id, text: '你好', options: { expandPromptTemplates: false } }
    ])

    await state!.closeTemporaryChat()
    expect(state!.snapshot().temporaryChat).toBeNull()
    expect(pi.closes).toContain(temp!.id)

    const reopened = await state!.openTemporaryChat()
    expect(reopened.temporaryChat?.id).not.toBe(temp!.id)
  })

  it('临时对话可以使用上传附件，发送时读取内容', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codelet-temp-upload-'))
    dirs.push(outside)
    const file = join(outside, 'note.txt')
    writeFileSync(file, '临时附件内容\n')
    const { root, pi } = setup(async () => [file])
    await state!.init()
    await state!.newConversation(root)
    const temp = (await state!.openTemporaryChat()).temporaryChat!
    const picked = await state!.pickAttachments()
    expect(picked.attachments).toHaveLength(1)

    await state!.promptTemporary(temp.id, '看看附件', [picked.attachments[0].id])
    expect(pi.prompts[0].text).toBe(
      '看看附件\n\n<file name="note.txt">\n临时附件内容\n\n</file>'
    )
  })

  it('模型切换只作用于临时会话，persist 固定为 false', async () => {
    const { root, pi } = setup()
    await state!.init()
    await state!.newConversation(root)
    const temp = (await state!.openTemporaryChat()).temporaryChat!
    pi.models.length = 0

    const snapshot = await state!.selectTemporaryModel(temp.id, MODEL.provider, MODEL.id)
    expect(snapshot.temporaryChat?.model).toEqual(MODEL)
    expect(pi.models).toEqual([
      { tabId: temp.id, provider: MODEL.provider, id: MODEL.id, persist: false }
    ])
  })
})
