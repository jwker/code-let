import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PrototypeListing } from '@contract/index'
import {
  choosePreviewEntry,
  isPrototypeFileName,
  listPrototypeFiles,
  prototypeFilesFrom
} from '../host/main/prototypeFiles'

/**
 * 原型目录的列表与「预览该显示什么」（票 03）。
 *
 * 列表只认顶层的 `.html` / `.htm`，按修改时间倒序；预览的选择只有一条链：
 * 上次的地址还能用就恢复，否则列目录，目录里也没有就空态。
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function listing(over: Partial<PrototypeListing> = {}): PrototypeListing {
  return { dir: '/repo/.codelet/prototype', exists: true, files: [], ...over }
}

function file(name: string, modified: number) {
  return { name, path: `/repo/.codelet/prototype/${name}`, url: `file:///repo/.codelet/prototype/${name}`, modified }
}

describe('哪些文件算原型', () => {
  it('只认 .html 与 .htm，忽略大小写', () => {
    for (const name of ['pricing.html', 'Pricing.HTML', 'about.htm', 'Old.Htm']) {
      expect(isPrototypeFileName(name)).toBe(true)
    }
    for (const name of ['pricing.html.txt', 'app.js', 'cover.png', 'html', '.html']) {
      expect(isPrototypeFileName(name)).toBe(false)
    }
  })
})

describe('原型文件清单', () => {
  it('过滤掉别的文件，按修改时间倒序；同一时刻按名字', () => {
    const files = prototypeFilesFrom(
      [
        { name: 'old.html', modified: 1_000 },
        { name: 'notes.txt', modified: 5_000 },
        { name: 'new.htm', modified: 3_000 },
        { name: 'b.html', modified: 2_000 },
        { name: 'a.html', modified: 2_000 }
      ],
      '/repo/.codelet/prototype'
    )
    expect(files.map((item) => item.name)).toEqual(['new.htm', 'a.html', 'b.html', 'old.html'])
    expect(files[0]).toEqual({
      name: 'new.htm',
      path: '/repo/.codelet/prototype/new.htm',
      url: 'file:///repo/.codelet/prototype/new.htm',
      modified: 3_000
    })
  })

  it('目录不存在时 exists 为 false，列表为空', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'codelet-protos-')), 'nope')
    dirs.push(dir)
    expect(await listPrototypeFiles(dir)).toEqual({ dir, exists: false, files: [] })
  })

  it('目录存在时读出顶层原型，按修改时间倒序', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-protos-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'first.html'), '<div>1</div>')
    writeFileSync(join(dir, 'second.HTML'), '<div>2</div>')
    writeFileSync(join(dir, 'readme.md'), '# x')
    utimesSync(join(dir, 'first.html'), new Date(1_000), new Date(1_000))
    utimesSync(join(dir, 'second.HTML'), new Date(2_000), new Date(2_000))

    const result = await listPrototypeFiles(dir)
    expect(result.exists).toBe(true)
    expect(result.files.map((item) => item.name)).toEqual(['second.HTML', 'first.html'])
  })
})

describe('预览该显示什么', () => {
  const withFiles = listing({ files: [file('pricing.html', 1_000)] })

  it('记录有效：直接恢复，哪怕目录里还有别的原型', () => {
    expect(choosePreviewEntry('file:///repo/.codelet/prototype/pricing.html', withFiles)).toEqual({
      kind: 'restore',
      url: 'file:///repo/.codelet/prototype/pricing.html'
    })
  })

  it('没有可用记录、目录里有原型：列出来让用户挑', () => {
    expect(choosePreviewEntry(null, withFiles)).toEqual({ kind: 'list', listing: withFiles })
  })

  it('目录存在但没有原型：空态（这一句是「还没有文件」）', () => {
    expect(choosePreviewEntry(null, listing())).toEqual({ kind: 'empty', listing: listing() })
  })

  it('目录不存在：空态（这一句是「目录还不存在」）', () => {
    const missing = listing({ exists: false })
    expect(choosePreviewEntry(null, missing)).toEqual({ kind: 'empty', listing: missing })
  })
})
