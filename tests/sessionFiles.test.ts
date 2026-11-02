import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { moveSessionFilesToTrash } from '../host/main/sessionFiles'

/**
 * 把会话文件移到废纸篓（PLAN.md D23）。
 *
 * 这一层只负责「移文件」：逐条报告结果，文件本来就不在算成功，
 * 一条失败不影响其他条。关标签、校验路径是 `HostState` 的事。
 */

const dirs: string[] = []

function makeFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-trash-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, '{}\n')
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('会话文件移入废纸篓', () => {
  it('重复路径只处理一次', async () => {
    const path = makeFile('a.jsonl')
    const calls: string[] = []
    const result = await moveSessionFilesToTrash([path, path], async (target) => {
      calls.push(target)
      rmSync(target, { force: true })
    })

    expect(calls).toEqual([path])
    expect(result).toEqual({ deleted: [path], failed: [] })
  })

  it('文件不在磁盘上算删掉，不调 trash', async () => {
    const path = join(tmpdir(), 'codelet-trash-missing', 'nope.jsonl')
    const calls: string[] = []
    const result = await moveSessionFilesToTrash([path], async (target) => {
      calls.push(target)
    })

    expect(calls).toEqual([])
    expect(result.deleted).toEqual([path])
    expect(result.failed).toEqual([])
  })

  it('trash 失败但文件已经不在了 —— 算删掉', async () => {
    const path = makeFile('b.jsonl')
    const result = await moveSessionFilesToTrash([path], async (target) => {
      rmSync(target, { force: true })
      throw new Error('回收站不可用')
    })

    expect(result.deleted).toEqual([path])
    expect(result.failed).toEqual([])
  })

  it('trash 失败且文件还在 —— 记失败和原因，其他条照常处理', async () => {
    const ok = makeFile('ok.jsonl')
    const bad = makeFile('bad.jsonl')
    const result = await moveSessionFilesToTrash([ok, bad], async (target) => {
      if (target === bad) throw new Error('系统废纸篓不可用')
      rmSync(target, { force: true })
    })

    expect(result.deleted).toEqual([ok])
    expect(result.failed).toEqual([{ path: bad, reason: '系统废纸篓不可用' }])
  })
})
