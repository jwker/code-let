import { execFile } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { GitDiff, GitDiffScope, GitFile, GitStatus } from '@contract/index'

/**
 * Git 面板的只读数据面。
 *
 * 全部通过本机 git 命令读取，不直接解析 `.git`，也不引入 Git 库。
 * 状态用 porcelain v2（机器可读），diff 按文件按需读取；这里不执行任何写操作。
 */

const MAX_STATUS_BUFFER = 4 * 1024 * 1024
const MAX_DIFF_BUFFER = 4 * 1024 * 1024
const MAX_FILES = 2000
const MAX_DIFF_CHARS = 512 * 1024
const MAX_UNTRACKED_BYTES = 512 * 1024
const GIT_TIMEOUT_MS = 10_000

export function emptyGitStatus(error: string | null = null): GitStatus {
  return {
    repo: false,
    root: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicts: [],
    clean: true,
    truncated: false,
    error
  }
}

function runGit(cwd: string, args: string[], maxBuffer = MAX_STATUS_BUFFER): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer,
        timeout: GIT_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = String(stderr || error.message).trim()
          reject(new Error(message || 'git 命令执行失败'))
          return
        }
        resolvePromise(stdout)
      }
    )
  })
}

function gitError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 取仓库根；非仓库返回 null；git 不可用返回 error */
async function repositoryRoot(cwd: string): Promise<{ root: string | null; error: string | null }> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--show-toplevel'])
    const root = out.trim()
    return root ? { root, error: null } : { root: null, error: null }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { root: null, error: '找不到 git 命令' }
    return { root: null, error: null }
  }
}

/** porcelain v2 的一行普通记录。path 可能包含空格，所以按前 N 个字段切。 */
function fieldsAfter(record: string, count: number): string {
  let index = 0
  for (let i = 0; i < count; i += 1) {
    index = record.indexOf(' ', index)
    if (index < 0) return ''
    index += 1
  }
  return record.slice(index)
}

function statusFile(path: string, status: string, oldPath?: string): GitFile {
  return { path, status, ...(oldPath ? { oldPath } : {}) }
}

/** 解析 `git status --porcelain=v2 --branch -z` 的输出 */
export function parseGitStatus(output: string): GitStatus {
  const status = emptyGitStatus()
  const parts = output.split('\0')
  const staged: GitFile[] = []
  const unstaged: GitFile[] = []
  const untracked: GitFile[] = []
  const conflicts: GitFile[] = []
  let count = 0
  let truncated = false

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]
    if (!record) continue

    if (record.startsWith('# branch.head ')) {
      status.branch = record.slice('# branch.head '.length).trim() || null
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      status.upstream = record.slice('# branch.upstream '.length).trim() || null
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record)
      if (match) {
        status.ahead = Number(match[1])
        status.behind = Number(match[2])
      }
      continue
    }
    if (record.startsWith('#')) continue

    if (count >= MAX_FILES) {
      truncated = true
      break
    }

    if (record.startsWith('? ')) {
      untracked.push(statusFile(record.slice(2), '?'))
      count += 1
      continue
    }

    if (record.startsWith('! ')) continue

    if (record.startsWith('u ')) {
      // u <xy> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const path = fieldsAfter(record, 10)
      if (path) {
        conflicts.push(statusFile(path, 'U'))
        count += 1
      }
      continue
    }

    if (record.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const xy = record.slice(2, 4)
      const path = fieldsAfter(record, 8)
      if (!path) continue
      const indexStatus = xy[0]
      const worktreeStatus = xy[1]
      if (indexStatus && indexStatus !== '.') {
        staged.push(statusFile(path, indexStatus))
      }
      if (worktreeStatus && worktreeStatus !== '.') {
        unstaged.push(statusFile(path, worktreeStatus))
      }
      count += 1
      continue
    }

    if (record.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
      const xy = record.slice(2, 4)
      const path = fieldsAfter(record, 9)
      // -z：重命名的旧路径是下一条 NUL 记录
      const oldPath = parts[index + 1]
      if (oldPath) index += 1
      if (!path) continue
      if (xy[0] && xy[0] !== '.') staged.push(statusFile(path, xy[0], oldPath))
      if (xy[1] && xy[1] !== '.') unstaged.push(statusFile(path, xy[1], oldPath))
      count += 1
    }
  }

  status.repo = true
  status.root = null
  status.staged = staged
  status.unstaged = unstaged
  status.untracked = untracked
  status.conflicts = conflicts
  status.truncated = truncated
  status.clean = staged.length + unstaged.length + untracked.length + conflicts.length === 0
  return status
}

async function readNumstat(root: string, staged: boolean): Promise<Map<string, { additions: number; deletions: number }>> {
  const result = new Map<string, { additions: number; deletions: number }>()
  try {
    const args = ['diff', '--numstat', '--no-ext-diff']
    if (staged) args.push('--cached')
    const output = await runGit(root, args)
    for (const line of output.split('\n')) {
      if (!line) continue
      const [add, del, ...rest] = line.split('\t')
      const path = rest.join('\t')
      if (!path) continue
      result.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 })
    }
  } catch {
    // 统计失败不影响状态列表
  }
  return result
}

/** 读取某个 cwd 的仓库状态；cwd 不是仓库时返回 repo:false */
export async function readGitStatus(cwd: string): Promise<GitStatus> {
  const found = await repositoryRoot(cwd)
  if (found.error) return emptyGitStatus(found.error)
  if (!found.root) return emptyGitStatus()

  try {
    const output = await runGit(found.root, [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all',
      '-z'
    ])
    const status = parseGitStatus(output)
    status.root = found.root
    const [stagedStats, unstagedStats] = await Promise.all([
      readNumstat(found.root, true),
      readNumstat(found.root, false)
    ])
    for (const file of status.staged) {
      const stats = stagedStats.get(file.path)
      if (stats) Object.assign(file, stats)
    }
    for (const file of status.unstaged) {
      const stats = unstagedStats.get(file.path)
      if (stats) Object.assign(file, stats)
    }
    return status
  } catch (error) {
    const status = emptyGitStatus(gitError(error))
    status.root = found.root
    return status
  }
}

function insideRoot(root: string, path: string): string | null {
  if (!path || isAbsolute(path)) return null
  const absolute = resolve(root, path)
  const rel = relative(root, absolute)
  if (!rel || rel.startsWith('..') || rel.split(sep).includes('..')) return null
  return absolute
}

function isBinary(content: Buffer): boolean {
  const sample = content.subarray(0, 8000)
  return sample.includes(0)
}

function untrackedPatch(path: string, content: string, binary: boolean): string {
  if (binary) return ''
  const lines = content.split('\n')
  const body = lines.map((line) => `+${line}`).join('\n')
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    body
  ].join('\n')
}

/** 读取一个文件的 diff；scope 决定和 HEAD、index 还是空文件比较 */
export async function readGitDiff(
  cwd: string,
  path: string,
  scope: GitDiffScope
): Promise<GitDiff> {
  const found = await repositoryRoot(cwd)
  if (!found.root) {
    return {
      path,
      scope,
      patch: '',
      binary: false,
      truncated: false,
      error: found.error ?? '当前目录不是 Git 仓库'
    }
  }

  const absolute = insideRoot(found.root, path)
  if (!absolute) {
    return { path, scope, patch: '', binary: false, truncated: false, error: '文件路径不在仓库内' }
  }

  if (scope === 'untracked') {
    try {
      const info = statSync(absolute)
      const size = Math.min(info.size, MAX_UNTRACKED_BYTES)
      const buffer = Buffer.alloc(size)
      const fd = openSync(absolute, 'r')
      let read = 0
      try {
        read = readSync(fd, buffer, 0, size, 0)
      } finally {
        closeSync(fd)
      }
      const data = buffer.subarray(0, read)
      const binary = isBinary(data)
      const text = data.toString('utf8')
      const patch = untrackedPatch(path, text, binary)
      return {
        path,
        scope,
        patch: patch.slice(0, MAX_DIFF_CHARS),
        binary,
        truncated: info.size > MAX_UNTRACKED_BYTES || patch.length > MAX_DIFF_CHARS,
        error: null
      }
    } catch (error) {
      return { path, scope, patch: '', binary: false, truncated: false, error: gitError(error) }
    }
  }

  try {
    const args = ['diff', '--no-ext-diff', '--no-color', '--unified=3']
    if (scope === 'staged') args.push('--cached')
    args.push('--', path)
    const patch = await runGit(found.root, args, MAX_DIFF_BUFFER)
    const binary = /^Binary files .* differ$/m.test(patch) || /^GIT binary patch$/m.test(patch)
    return {
      path,
      scope,
      patch: patch.slice(0, MAX_DIFF_CHARS),
      binary,
      truncated: patch.length > MAX_DIFF_CHARS,
      error: null
    }
  } catch (error) {
    return { path, scope, patch: '', binary: false, truncated: false, error: gitError(error) }
  }
}
