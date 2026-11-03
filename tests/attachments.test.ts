import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ATTACHMENT_LIMITS } from '@contract/index'
import { prepareAttachments } from '../host/main/attachments'

/**
 * `@` 内容附件（PLAN.md D26）。
 *
 * 渲染进程只传相对路径；读取、越界校验、大小限制、`<file>` 包装都在主进程。
 */

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'codelet-attach-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
  return root
}

describe('准备附件', () => {
  it('文本文件包成 <file> 块，重复路径只算一次', async () => {
    const root = setup()
    const prepared = await prepareAttachments(root, ['src/a.ts', 'src/a.ts'])
    expect(prepared.images).toEqual([])
    expect(prepared.text).toBe('<file name="src/a.ts">\nexport const a = 1\n\n</file>')
    rmSync(root, { recursive: true, force: true })
  })

  it('图片走 images，正文留一个空的 <file> 标记', async () => {
    const root = setup()
    const prepared = await prepareAttachments(root, ['pic.png'])
    expect(prepared.images).toHaveLength(1)
    expect(prepared.images[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect(prepared.images[0].data.length).toBeGreaterThan(0)
    expect(prepared.text).toBe('<file name="pic.png"></file>')
    rmSync(root, { recursive: true, force: true })
  })

  it('不存在的文件、项目外的路径、二进制文件都拒绝', async () => {
    const root = setup()
    await expect(prepareAttachments(root, ['nope.txt'])).rejects.toThrow(/附件/)
    await expect(prepareAttachments(root, ['../outside.txt'])).rejects.toThrow(/附件/)
    await expect(prepareAttachments(root, ['blob.bin'])).rejects.toThrow(/二进制/)
    rmSync(root, { recursive: true, force: true })
  })

  it('绝对路径拒绝 —— 附件只收项目内相对路径', async () => {
    const root = setup()
    await expect(prepareAttachments(root, [join(root, 'src/a.ts')])).rejects.toThrow(/相对路径/)
    rmSync(root, { recursive: true, force: true })
  })

  it('文本单文件超过上限拒绝', async () => {
    const root = setup()
    writeFileSync(join(root, 'big.txt'), Buffer.alloc(ATTACHMENT_LIMITS.maxTextFileBytes + 1, 0x61))
    await expect(prepareAttachments(root, ['big.txt'])).rejects.toThrow(/单文件上限/)
    rmSync(root, { recursive: true, force: true })
  })

  it('文本总量超过上限拒绝', async () => {
    const root = setup()
    const paths: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const name = `part-${index}.txt`
      // 每个 200KB：单个不超 256KB，6 个合计超过 1MB
      writeFileSync(join(root, name), Buffer.alloc(200 * 1024, 0x61))
      paths.push(name)
    }
    await expect(prepareAttachments(root, paths)).rejects.toThrow(/文本附件总量/)
    rmSync(root, { recursive: true, force: true })
  })

  it('附件数量超过上限拒绝', async () => {
    const root = setup()
    const paths = Array.from({ length: ATTACHMENT_LIMITS.maxCount + 1 }, (_, index) => `f${index}.ts`)
    await expect(prepareAttachments(root, paths)).rejects.toThrow(/最多/)
    rmSync(root, { recursive: true, force: true })
  })
})
