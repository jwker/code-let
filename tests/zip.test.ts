import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeZip } from '../host/main/zip'

/**
 * 最小 zip 写入器。
 *
 * 用系统的 unzip 验一次 —— 自己写的格式，得让真正的解压器认。
 */
describe('zip 写入器', () => {
  it('打出来的包能被 unzip 读出来', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-zip-'))
    const path = join(dir, 'out.zip')
    const entries = [
      { name: 'manifest.json', data: Buffer.from('{"records":[]}', 'utf8') },
      { name: 'requests/t1-1.cgz', data: Buffer.from([1, 2, 3, 4, 5]) }
    ]
    const result = await writeZip(path, entries)
    expect(result.count).toBe(2)
    expect(result.bytes).toBe(entries[0]!.data.length + entries[1]!.data.length)

    const listing = execFileSync('unzip', ['-l', path], { encoding: 'utf8' })
    expect(listing).toContain('manifest.json')
    expect(listing).toContain('requests/t1-1.cgz')

    // 解出来的内容要一模一样
    execFileSync('unzip', ['-o', '-q', path, '-d', join(dir, 'out')], { encoding: 'utf8' })
    expect(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8')).toBe('{"records":[]}')
    expect([...readFileSync(join(dir, 'out', 'requests', 't1-1.cgz'))]).toEqual([1, 2, 3, 4, 5])
  })

  it('进度回调按条目数走', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-zip-'))
    const seen: number[] = []
    await writeZip(
      join(dir, 'out.zip'),
      [
        { name: 'a.txt', data: Buffer.from('a') },
        { name: 'b.txt', data: Buffer.from('bb') }
      ],
      (done) => seen.push(done)
    )
    expect(seen).toEqual([1, 2])
  })
})
