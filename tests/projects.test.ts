import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PROTOTYPE_DIR, ProjectStore } from '../host/main/projects'

/**
 * 项目清单的落盘与恢复，以及原型图目录这一项（票 02）。
 *
 * `projects.json` 原来只是一串路径；升级之后每条带一个可选的 `prototypeDir`。
 * 旧的纯字符串数组必须能原样读进来 —— 用户的清单不能因为升级丢掉。
 */

const dirs: string[] = []

function makeStore(): { store: ProjectStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'codelet-projects-'))
  dirs.push(dir)
  const file = join(dir, 'projects.json')
  return { store: new ProjectStore(file), file }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('项目清单', () => {
  it('旧的纯字符串清单能读进来，原型目录按默认值', () => {
    const { file } = makeStore()
    writeFileSync(file, JSON.stringify({ projects: ['/a', '/b'] }))
    const store = new ProjectStore(file)
    expect(store.list().map((project) => project.path)).toEqual(['/a', '/b'])
    expect(store.list().map((project) => project.prototypeDir)).toEqual([
      DEFAULT_PROTOTYPE_DIR,
      DEFAULT_PROTOTYPE_DIR
    ])
  })

  it('没设置过原型目录的记录也按默认值', () => {
    const { file } = makeStore()
    writeFileSync(file, JSON.stringify({ projects: [{ path: '/a' }] }))
    expect(new ProjectStore(file).list()[0].prototypeDir).toBe(DEFAULT_PROTOTYPE_DIR)
  })

  it('设置过原型目录的记录能读回来', () => {
    const { store, file } = makeStore()
    store.add('/a')
    store.setPrototypeDir('/a', 'design/protos')
    const reloaded = new ProjectStore(file)
    expect(reloaded.list()[0]).toEqual(
      expect.objectContaining({ path: '/a', prototypeDir: 'design/protos' })
    )
  })

  it('手改坏的值按默认值读，不丢项目', () => {
    const { file } = makeStore()
    writeFileSync(file, JSON.stringify({ projects: [{ path: '/a', prototypeDir: '../outside' }] }))
    const list = new ProjectStore(file).list()
    expect(list).toHaveLength(1)
    expect(list[0].prototypeDir).toBe(DEFAULT_PROTOTYPE_DIR)
  })

  it('保存时只写这个项目的原型目录，别的项目不动', () => {
    const { store, file } = makeStore()
    store.add('/a')
    store.add('/b')
    store.setPrototypeDir('/a', 'protos')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      projects: Array<{ path: string; prototypeDir?: string }>
    }
    expect(raw.projects.find((item) => item.path === '/a')?.prototypeDir).toBe('protos')
    expect(raw.projects.find((item) => item.path === '/b')?.prototypeDir).toBeUndefined()
  })

  it('给清单里没有的项目设目录是空操作', () => {
    const { store } = makeStore()
    store.add('/a')
    store.setPrototypeDir('/nope', 'protos')
    expect(store.list()[0].prototypeDir).toBe(DEFAULT_PROTOTYPE_DIR)
  })
})
