import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PathOutsideCwdError, formatSize, listDirectory, readFileContent, resolveInsideCwd } from '../host/main/files'

/**
 * 文件系统层 —— 重点是**路径越界校验**（PLAN.md D20 / R26）。
 *
 * 渲染进程可以传任意字符串进来，所以这一层必须挡住：`../`、绝对路径、
 * 符号链接指向外面。漏一条就是任意读文件。
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codelet-files-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'README.md'), '# 标题\n\n正文\n')
  writeFileSync(join(root, 'package.json'), '{}\n')
  writeFileSync(join(root, 'src', 'index.ts'), 'export const a = 1\n')
  writeFileSync(join(root, '.env'), 'SECRET=1\n')
  // 二进制：带 NUL
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))
  return root
}

describe('路径越界校验', () => {
  it('项目内的相对路径放行', async () => {
    const root = setup()
    expect(await resolveInsideCwd(root, 'src/index.ts')).toBe(join(root, 'src/index.ts'))
    expect(await resolveInsideCwd(root, '')).toBe(root)
    expect(await resolveInsideCwd(root, '.')).toBe(root)
    rmSync(root, { recursive: true, force: true })
  })

  it('★ ../ 越界被拒', async () => {
    const root = setup()
    await expect(resolveInsideCwd(root, '../etc/passwd')).rejects.toThrow(PathOutsideCwdError)
    await expect(resolveInsideCwd(root, 'src/../../outside')).rejects.toThrow(PathOutsideCwdError)
    await expect(resolveInsideCwd(root, '../../../../../../etc/passwd')).rejects.toThrow(PathOutsideCwdError)
    rmSync(root, { recursive: true, force: true })
  })

  it('绝对路径指向项目外被拒', async () => {
    const root = setup()
    await expect(resolveInsideCwd(root, '/etc/passwd')).rejects.toThrow(PathOutsideCwdError)
    rmSync(root, { recursive: true, force: true })
  })

  it('★ 前缀相同的兄弟目录不算项目内 —— /a/bc 不是 /a/b 的子路径', async () => {
    const root = setup()
    // 构造 root + 'x'，它是 root 的兄弟目录
    const sibling = `${root}x`
    mkdirSync(sibling)
    await expect(resolveInsideCwd(root, `${sibling}/file.txt`)).rejects.toThrow(PathOutsideCwdError)
    rmSync(root, { recursive: true, force: true })
    rmSync(sibling, { recursive: true, force: true })
  })

  it('★ 符号链接指向项目外被拒 —— realpath 之后再校验一次', async () => {
    const root = setup()
    const outside = mkdtempSync(join(tmpdir(), 'codelet-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(root, 'link'))
    // 字符串上 link/secret.txt 看着在 root 里，但 realpath 会解析到 outside
    await expect(resolveInsideCwd(root, 'link/secret.txt')).rejects.toThrow(PathOutsideCwdError)
    await expect(readFileContent(root, 'link/secret.txt')).rejects.toThrow(PathOutsideCwdError)
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('符号链接指向项目内 —— 放行，但返回的是传入路径（不换成 realpath 结果）', async () => {
    const root = setup()
    symlinkSync(join(root, 'src'), join(root, 'srclink'))
    // 返回的是 srclink/index.ts 的绝对形式 —— 不是 src/index.ts。
    // 换成 realpath 会让同一个文件有两种写法，去重和缓存都对不上。
    expect(await resolveInsideCwd(root, 'srclink/index.ts')).toBe(join(root, 'srclink', 'index.ts'))
    // 内容仍然读得到（realpath 只在内部校验时用）
    const content = await readFileContent(root, 'srclink/index.ts')
    expect(content.kind === 'text' && content.text.includes('export const a')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('列目录', () => {
  it('文件夹在前、按名字；文件在后、按名字', async () => {
    const root = setup()
    const entries = await listDirectory(root, '')
    const names = entries.map((e) => `${e.kind}:${e.name}`)
    expect(names[0]).toBe('dir:src')
    // 之后是文件，按名字
    const files = entries.filter((e) => e.kind === 'file').map((e) => e.name)
    expect(files).toEqual([...files].sort((a, b) => a.localeCompare(b)))
    rmSync(root, { recursive: true, force: true })
  })

  it('隐藏文件照常列出来', async () => {
    const root = setup()
    const entries = await listDirectory(root, '')
    expect(entries.some((e) => e.name === '.env')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('越界的目录被拒', async () => {
    const root = setup()
    await expect(listDirectory(root, '../..')).rejects.toThrow(PathOutsideCwdError)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('读文件', () => {
  it('文本文件返回内容和行数', async () => {
    const root = setup()
    const content = await readFileContent(root, 'README.md')
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') return
    expect(content.text).toContain('# 标题')
    expect(content.lines).toBe(3) // # 标题 / 空 / 正文
    expect(content.binary).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('★ 二进制文件被识别出来，不返回乱码', async () => {
    const root = setup()
    const content = await readFileContent(root, 'blob.bin')
    expect(content.kind).toBe('text')
    if (content.kind !== 'text') return
    expect(content.binary).toBe(true)
    expect(content.text).toBe('')
    rmSync(root, { recursive: true, force: true })
  })

  it('越界的路径被拒', async () => {
    const root = setup()
    await expect(readFileContent(root, '../../etc/passwd')).rejects.toThrow(PathOutsideCwdError)
    rmSync(root, { recursive: true, force: true })
  })

  it('目录不当文件读', async () => {
    const root = setup()
    const content = await readFileContent(root, 'src')
    expect(content.kind).toBe('unsupported')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('formatSize', () => {
  it('按大小换单位', async () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(2048)).toBe('2.0 KB')
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})
