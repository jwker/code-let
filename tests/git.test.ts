import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGitStatus, readGitDiff, readGitStatus } from '../host/main/git'

const dirs: string[] = []

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-git-'))
  dirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Codelet Test'], { cwd: dir })
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Git 状态解析', () => {
  it('解析分支、暂存/未暂存、重命名、未跟踪和冲突', () => {
    const output = [
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 a b src/worktree.ts',
      '1 M. N... 100644 100644 100644 a b src/index.ts',
      '1 MM N... 100644 100644 100644 a b src/both.ts',
      '2 R. N... 100644 100644 100644 a b R100 src/new-name.ts',
      'src/old-name.ts',
      '? src/new-file.ts',
      'u UU N... 100644 100644 100644 100644 a b c src/conflict.ts'
    ].join('\0')

    const status = parseGitStatus(output)
    expect(status.repo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(1)
    expect(status.staged.map((file) => `${file.status}:${file.path}`)).toEqual([
      'M:src/index.ts',
      'M:src/both.ts',
      'R:src/new-name.ts'
    ])
    expect(status.staged.find((file) => file.status === 'R')?.oldPath).toBe('src/old-name.ts')
    expect(status.unstaged.map((file) => `${file.status}:${file.path}`)).toEqual([
      'M:src/worktree.ts',
      'M:src/both.ts'
    ])
    expect(status.untracked).toEqual([{ path: 'src/new-file.ts', status: '?' }])
    expect(status.conflicts).toEqual([{ path: 'src/conflict.ts', status: 'U' }])
    expect(status.clean).toBe(false)
  })

  it('真实仓库里正确分组并读取 diff', async () => {
    const dir = tempRepo()
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(dir, 'staged.txt'), 'staged\n')
    execFileSync('git', ['add', 'staged.txt'], { cwd: dir })
    writeFileSync(join(dir, 'new.txt'), 'new\n')

    const status = await readGitStatus(dir)
    expect(status.repo).toBe(true)
    expect(status.root).toBe(realpathSync(dir))
    expect(status.staged.some((file) => file.path === 'staged.txt')).toBe(true)
    expect(status.unstaged.some((file) => file.path === 'a.txt')).toBe(true)
    expect(status.unstaged.find((file) => file.path === 'a.txt')?.additions).toBe(1)
    expect(status.untracked.some((file) => file.path === 'new.txt')).toBe(true)

    const unstaged = await readGitDiff(dir, 'a.txt', 'unstaged')
    expect(unstaged.error).toBeNull()
    expect(unstaged.patch).toContain('+two')

    const untracked = await readGitDiff(dir, 'new.txt', 'untracked')
    expect(untracked.error).toBeNull()
    expect(untracked.patch).toContain('+new')

    const staged = await readGitDiff(dir, 'staged.txt', 'staged')
    expect(staged.error).toBeNull()
    expect(staged.patch).toContain('+staged')
  })

  it('非仓库返回 repo:false，不把错误当成干净仓库', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-not-git-'))
    dirs.push(dir)
    const status = await readGitStatus(dir)
    expect(status.repo).toBe(false)
    expect(status.root).toBeNull()
    expect(status.error).toBeNull()
  })
})
