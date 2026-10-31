import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostState } from '../host/main/state'
import { ProjectStore } from '../host/main/projects'
import { TabStore, type StoredFile } from '../host/main/tabs'
import type { PiEventListener, PiRuntimePort, TabRuntimeState } from '../host/main/pi/runtime'
import type { ModelOption, StreamItem } from '@contract/index'

/**
 * 文件标签的持久化（PLAN.md D21 / R25）。
 *
 * 规则跟会话标签一致：**文件不在了就丢掉这一条**，但整个列表不能因为
 * 一条坏掉就全丢 —— 一条条判断，能恢复的都要恢复。
 */

class FakePi implements PiRuntimePort {
  private listeners = new Set<PiEventListener>()
  onEvent(l: PiEventListener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
  async openTab(): Promise<void> {}
  async closeTab(): Promise<void> {}
  async activateTab(): Promise<void> {}
  async reloadTab(): Promise<void> {}
  tabState(): TabRuntimeState {
    return { ready: false, sessionId: null, sessionFile: null, streaming: false, model: null, modelFallback: null }
  }
  readEntries(): StreamItem[] {
    return []
  }
  async listModels(): Promise<ModelOption[]> {
    return []
  }
  async selectModel(): Promise<void> {}
  async prompt(): Promise<void> {}
  async stop(): Promise<void> {}
}

function setup(files: StoredFile[], activeFileId: string | null) {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-ftabs-'))
  const tabFile = join(dir, 'tabs.json')
  const store = new TabStore(tabFile)
  store.saveFiles(files, activeFileId)
  const projects = new ProjectStore(join(dir, 'projects.json'))
  projects.add(dir)
  return { dir, tabFile, store, projects }
}

describe('文件标签的落盘与恢复', () => {
  it('三个文件都还在 → 全部恢复，活动文件不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-ftabs-'))
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    const c = join(dir, 'c.ts')
    for (const f of [a, b, c]) writeFileSync(f, 'x')

    const { store, projects } = setup(
      [
        { id: 'file-1', path: a, cwd: dir, relPath: 'a.ts' },
        { id: 'file-2', path: b, cwd: dir, relPath: 'b.ts' },
        { id: 'file-3', path: c, cwd: dir, relPath: 'c.ts' }
      ],
      'file-2'
    )
    const state = new HostState({ pi: new FakePi(), tabStore: store, projects })
    await state.init()

    const snap = state.snapshot()
    expect(snap.files.map((f) => f.relPath)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(snap.activeFileId).toBe('file-2')

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('★ 中间那个文件没了 → 只丢那一条，其余照常恢复', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-ftabs-'))
    const a = join(dir, 'a.ts')
    const c = join(dir, 'c.ts')
    writeFileSync(a, 'x')
    writeFileSync(c, 'x')
    const gone = join(dir, 'gone.ts') // 不创建

    const { store, projects } = setup(
      [
        { id: 'file-1', path: a, cwd: dir, relPath: 'a.ts' },
        { id: 'file-2', path: gone, cwd: dir, relPath: 'gone.ts' },
        { id: 'file-3', path: c, cwd: dir, relPath: 'c.ts' }
      ],
      'file-2'
    )
    const state = new HostState({ pi: new FakePi(), tabStore: store, projects })
    await state.init()

    const snap = state.snapshot()
    expect(snap.files.map((f) => f.relPath)).toEqual(['a.ts', 'c.ts'])
    // 原来活动的那个没了 —— 落到剩下的最后一个
    expect(snap.activeFileId).toBe('file-3')

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('★ 全部文件都没了 → 列表为空，不是崩溃', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-ftabs-'))
    const { store, projects } = setup(
      [
        { id: 'file-1', path: join(dir, 'x.ts'), cwd: dir, relPath: 'x.ts' },
        { id: 'file-2', path: join(dir, 'y.ts'), cwd: dir, relPath: 'y.ts' }
      ],
      'file-1'
    )
    const state = new HostState({ pi: new FakePi(), tabStore: store, projects })
    await state.init()

    expect(state.snapshot().files).toEqual([])
    expect(state.snapshot().activeFileId).toBeNull()

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('打开 / 切换 / 关闭都会立刻落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-ftabs-'))
    const a = join(dir, 'a.ts')
    const b = join(dir, 'b.ts')
    writeFileSync(a, 'x')
    writeFileSync(b, 'x')

    const tabFile = join(dir, 'tabs.json')
    const store = new TabStore(tabFile)
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const state = new HostState({ pi: new FakePi(), tabStore: store, projects })
    await state.init()

    const readSaved = () => JSON.parse(readFileSync(tabFile, 'utf8')) as {
      files: StoredFile[]
      activeFileId: string | null
    }

    await state.openFile(dir, a)
    await state.openFile(dir, b)
    expect(readSaved().files).toHaveLength(2)
    expect(readSaved().files.map((f) => f.relPath)).toEqual(['a.ts', 'b.ts'])
    expect(readSaved().activeFileId).toBe(state.snapshot().activeFileId)

    // 切回第一个
    const first = state.snapshot().files[0]
    await state.activateFile(first.id)
    expect(readSaved().activeFileId).toBe(first.id)

    // 关掉第一个
    await state.closeFile(first.id)
    expect(readSaved().files).toHaveLength(1)
    expect(readSaved().files[0].relPath).toBe('b.ts')

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('同一个文件重复打开 → 切过去，不新建标签', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-ftabs-'))
    const a = join(dir, 'a.ts')
    writeFileSync(a, 'x')

    const tabFile = join(dir, 'tabs.json')
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const state = new HostState({ pi: new FakePi(), tabStore: new TabStore(tabFile), projects })
    await state.init()

    await state.openFile(dir, a)
    const firstId = state.snapshot().activeFileId
    await state.openFile(dir, a)
    expect(state.snapshot().files).toHaveLength(1)
    expect(state.snapshot().activeFileId).toBe(firstId)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('会话标签跟文件标签互不影响', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-ftabs-'))
    const a = join(dir, 'a.ts')
    writeFileSync(a, 'x')

    const tabFile = join(dir, 'tabs.json')
    const projects = new ProjectStore(join(dir, 'projects.json'))
    projects.add(dir)
    const state = new HostState({ pi: new FakePi(), tabStore: new TabStore(tabFile), projects })
    await state.init()
    // init() 会开一个「退路标签」—— 先清掉，从空标签栏开始
    for (const t of state.snapshot().tabs) await state.closeTab(t.id)

    await state.newConversation(dir)
    await state.openFile(dir, a)
    const snap = state.snapshot()
    expect(snap.tabs).toHaveLength(1) // 会话标签 1 个
    expect(snap.files).toHaveLength(1) // 文件标签 1 个

    // 关掉会话标签，文件标签还在
    await state.closeTab(snap.tabs[0].id)
    expect(state.snapshot().tabs).toHaveLength(0)
    expect(state.snapshot().files).toHaveLength(1)

    await state.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
})
