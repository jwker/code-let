import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDocs } from '../host/main/docs'

/**
 * AI 文档清单（PLAN.md D52 / R38）。
 *
 * 组不是写死的：`.ai/` 下每个目录各成一组，外加项目根的 `AGENTS.md`。
 * 只列文档类扩展名，空组不返回。
 */

const dirs: string[] = []

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-docs-'))
  dirs.push(dir)
  return dir
}

function touch(path: string, content = 'x'): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('文档清单', () => {
  it('AGENTS.md 单独一组，排在 .ai/ 各组前面', async () => {
    const dir = makeProject()
    touch(join(dir, 'AGENTS.md'), '# 约定')
    touch(join(dir, '.ai/planning/plan.md'))

    const result = await listDocs(dir)
    expect(result.groups.map((group) => group.title)).toEqual(['项目说明', 'planning'])
    expect(result.groups[0].entries[0].relPath).toBe('AGENTS.md')
  })

  it('planning 排在其他目录前，其余按名字排', async () => {
    const dir = makeProject()
    touch(join(dir, '.ai/design/a.md'))
    touch(join(dir, '.ai/docs/b.md'))
    touch(join(dir, '.ai/planning/c.md'))
    touch(join(dir, '.ai/artifacts/d.md'))

    const result = await listDocs(dir)
    expect(result.groups.map((group) => group.title)).toEqual(['planning', 'artifacts', 'design', 'docs'])
  })

  it('组内按修改时间倒序 —— 刚写的那份在最前', async () => {
    const dir = makeProject()
    touch(join(dir, '.ai/planning/old.md'))
    touch(join(dir, '.ai/planning/new.md'))
    // 显式把 old.md 的时间推早，不依赖写入顺序
    const { utimesSync } = await import('node:fs')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, '.ai/planning/old.md'), past, past)

    const entries = (await listDocs(dir)).groups[0].entries
    expect(entries.map((entry) => entry.name)).toEqual(['new.md', 'old.md'])
  })

  it('只列文档类扩展名 —— 图片和压缩包不进文档区', async () => {
    const dir = makeProject()
    touch(join(dir, '.ai/design/draw.io.png'))
    touch(join(dir, '.ai/design/page.html'))
    touch(join(dir, '.ai/design/notes.md'))
    touch(join(dir, '.ai/design/bundle.zip'))

    const names = (await listDocs(dir)).groups[0].entries.map((entry) => entry.name).sort()
    expect(names).toEqual(['notes.md', 'page.html'])
  })

  it('空目录不返回空组', async () => {
    const dir = makeProject()
    mkdirSync(join(dir, '.ai/empty'), { recursive: true })
    touch(join(dir, '.ai/planning/a.md'))

    const result = await listDocs(dir)
    expect(result.groups.map((group) => group.title)).toEqual(['planning'])
  })

  it('没有 .ai/ 也没有 AGENTS.md 时是空清单', async () => {
    const dir = makeProject()
    const result = await listDocs(dir)
    expect(result.groups).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('子目录只下钻两层 —— design/screenshots 里的文件也收，但不再往下', async () => {
    const dir = makeProject()
    touch(join(dir, '.ai/design/screenshots/shot.md'))
    touch(join(dir, '.ai/design/a/b/c/deep.md'))

    const names = (await listDocs(dir)).groups[0].entries.map((entry) => entry.name)
    expect(names).toContain('shot.md')
    expect(names).not.toContain('deep.md')
  })

  it('路径是绝对路径 + 相对路径两份 —— 读内容用绝对，显示用相对', async () => {
    const dir = makeProject()
    touch(join(dir, '.ai/planning/a.md'))
    const entry = (await listDocs(dir)).groups[0].entries[0]
    expect(entry.path).toBe(join(dir, '.ai/planning/a.md'))
    expect(entry.relPath).toBe('.ai/planning/a.md')
    expect(entry.name).toBe('a.md')
    expect(entry.size).toBeGreaterThan(0)
  })
})
