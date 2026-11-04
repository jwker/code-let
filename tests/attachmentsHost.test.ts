import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore } from '../host/main/tabs'
import type { PromptImage } from '../host/main/attachments'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { CommandOption, ModelOption, StreamItem } from '@contract/index'

/**
 * 宿主把附件拼进 prompt 的那一段（PLAN.md D26）。
 *
 * 渲染进程只传相对路径；这里验证 HostState 读取、合并、传递 images。
 */

class FakePi implements PiRuntimePort {
  readonly prompts: Array<{ tabId: string; text: string; images?: PromptImage[] }> = []

  onEvent(_listener: PiEventListener): () => void {
    return () => {}
  }
  async openTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async activateTab(): Promise<void> {}
  async reloadTab(): Promise<void> {}
  tabState(_tabId: string): TabRuntimeState {
    return {
      ready: true,
      sessionId: 's-fake',
      sessionFile: null,
      streaming: false,
      model: null,
      thinkingLevel: null,
      modelFallback: null
    }
  }
  async listModels(): Promise<ModelOption[]> {
    return []
  }
  async selectModel(): Promise<void> {}
  async renameSession(): Promise<void> {}
  async listCommands(): Promise<CommandOption[]> {
    return []
  }
  async compactTab(): Promise<void> {}
  async prompt(tabId: string, text: string, images?: PromptImage[]): Promise<void> {
    this.prompts.push({ tabId, text, images })
  }
  async abortTab(): Promise<void> {}
  async completeCommand(): Promise<never[]> {
    return []
  }

  thinkingLevels(): never[] {
    return []
  }

  setThinkingLevel(): void {
    // 不参与
  }

  async stop(): Promise<void> {}
  readEntries(): StreamItem[] {
    return []
  }
}

const dirs: string[] = []
let state: HostState | null = null

function setup(pickFiles?: () => Promise<string[] | null>) {
  const root = mkdtempSync(join(tmpdir(), 'codelet-attach-host-'))
  dirs.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
  const projects = new ProjectStore(join(root, 'projects.json'))
  const tabStore = new TabStore(join(root, 'tabs.json'))
  const pi = new FakePi()
  state = new HostState({
    pi,
    projects,
    tabStore,
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

describe('HostState.pickAttachments 的上传附件', () => {
  it('选择外部文件后返回元信息，发送时读取并只回传 id', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codelet-upload-outside-'))
    dirs.push(outside)
    const textPath = join(outside, 'external.ts')
    const imagePath = join(outside, 'external.png')
    writeFileSync(textPath, 'export const external = 1\n')
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))

    const { root, pi } = setup(async () => [textPath, imagePath])
    await state!.init()
    await state!.newConversation(root)
    const tabId = state!.snapshot().activeTabId!

    const picked = await state!.pickAttachments()
    expect(picked.errors).toEqual([])
    expect(picked.attachments).toHaveLength(2)
    expect(picked.attachments[0]).toMatchObject({ name: 'external.ts', kind: 'text' })
    expect(picked.attachments[1]).toMatchObject({ name: 'external.png', kind: 'image' })

    await state!.prompt(tabId, '看外部文件', [], [picked.attachments[0].id])
    expect(pi.prompts[0].text).toBe(
      '看外部文件\n\n<file name="external.ts">\nexport const external = 1\n\n</file>'
    )
  })

  it('不合格的文件进 errors，发送已失效的上传 id 会拒绝', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'codelet-upload-invalid-'))
    dirs.push(outside)
    const binaryPath = join(outside, 'blob.bin')
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02]))

    const { root } = setup(async () => [binaryPath])
    await state!.init()
    await state!.newConversation(root)
    const tabId = state!.snapshot().activeTabId!
    const picked = await state!.pickAttachments()
    expect(picked.attachments).toEqual([])
    expect(picked.errors[0]).toMatch(/二进制/)

    await expect(state!.prompt(tabId, '看', [], ['missing-upload'])).rejects.toThrow(/失效/)
  })
})

describe('HostState.prompt 的附件', () => {
  it('文本附件拼在正文后面，图片走 images', async () => {
    const { root, pi } = setup()
    await state!.init()
    await state!.newConversation(root)
    const tabId = state!.snapshot().activeTabId
    expect(tabId).toBeTruthy()

    await state!.prompt(tabId!, '看看', ['src/a.ts'])
    expect(pi.prompts[0].text).toBe(
      '看看\n\n<file name="src/a.ts">\nexport const a = 1\n\n</file>'
    )
    expect(pi.prompts[0].images).toEqual([])

    await state!.prompt(tabId!, '看图', ['pic.png'])
    expect(pi.prompts[1].text).toContain('<file name="pic.png"></file>')
    expect(pi.prompts[1].images).toHaveLength(1)
    expect(pi.prompts[1].images?.[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
  })

  it('附件读不了时整次拒绝，不调用 Pi', async () => {
    const { root, pi } = setup()
    await state!.init()
    await state!.newConversation(root)
    const tabId = state!.snapshot().activeTabId!

    await expect(state!.prompt(tabId, '看看', ['nope.txt'])).rejects.toThrow(/附件/)
    expect(pi.prompts).toHaveLength(0)
  })
})
