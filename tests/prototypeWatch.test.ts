import { describe, expect, it } from 'vitest'
import { PrototypeWatch, sameStamp, type FileStamp } from '../host/main/prototypeWatch'

/**
 * 「这一轮动过原型文件没有」的判断。
 *
 * 一轮开始时拍下文件的时间戳与大小，轮结束时再拍一次比较 ——
 * 只比 mtime 不够：同一毫秒里写完的文件 mtime 可能一样，大小也会变。
 */

function stampQueue(...values: Array<FileStamp | null>): () => Promise<FileStamp | null> {
  let index = 0
  return async () => {
    const value = values[Math.min(index, values.length - 1)] ?? null
    index += 1
    return value
  }
}

describe('两份文件戳是不是同一个样子', () => {
  it('修改时间与大小都一样才算没变', () => {
    expect(sameStamp({ mtimeMs: 1, size: 10 }, { mtimeMs: 1, size: 10 })).toBe(true)
  })

  it('修改时间变了就算变过', () => {
    expect(sameStamp({ mtimeMs: 1, size: 10 }, { mtimeMs: 2, size: 10 })).toBe(false)
  })

  it('同一毫秒里写完，大小变了也算变过', () => {
    expect(sameStamp({ mtimeMs: 1, size: 10 }, { mtimeMs: 1, size: 12 })).toBe(false)
  })

  it('两边都没有这个文件算没变，从无到有算变过', () => {
    expect(sameStamp(null, null)).toBe(true)
    expect(sameStamp(null, { mtimeMs: 1, size: 10 })).toBe(false)
    expect(sameStamp({ mtimeMs: 1, size: 10 }, null)).toBe(false)
  })
})

describe('一轮里改没改原型文件', () => {
  it('改过：轮结束时报 true', async () => {
    const watch = new PrototypeWatch(
      stampQueue({ mtimeMs: 1, size: 10 }, { mtimeMs: 2, size: 12 })
    )
    await watch.begin('agent-1', '/project/preview/pricing.html')
    expect(await watch.end('agent-1', '/project/preview/pricing.html')).toBe(true)
  })

  it('没改过：false', async () => {
    const watch = new PrototypeWatch(
      stampQueue({ mtimeMs: 1, size: 10 }, { mtimeMs: 1, size: 10 })
    )
    await watch.begin('agent-1', '/project/preview/pricing.html')
    expect(await watch.end('agent-1', '/project/preview/pricing.html')).toBe(false)
  })

  it('开始得太晚也不怕：end 会等 begin 拍完', async () => {
    const watch = new PrototypeWatch(
      stampQueue({ mtimeMs: 1, size: 10 }, { mtimeMs: 2, size: 12 })
    )
    const started = watch.begin('agent-1', '/project/preview/pricing.html')
    expect(await watch.end('agent-1', '/project/preview/pricing.html')).toBe(true)
    await started
  })

  it('没有预览文件、或者根本没开始过：false', async () => {
    const watch = new PrototypeWatch(stampQueue({ mtimeMs: 2, size: 12 }))
    expect(await watch.end('agent-1', '/project/preview/pricing.html')).toBe(false)
    await watch.begin('agent-1', null)
    expect(await watch.end('agent-1', null)).toBe(false)
  })

  it('这一轮里页面换成了别的文件：false —— 预览已经自己切过去了', async () => {
    const watch = new PrototypeWatch(
      stampQueue({ mtimeMs: 1, size: 10 }, { mtimeMs: 2, size: 12 })
    )
    await watch.begin('agent-1', '/project/preview/pricing.html')
    expect(await watch.end('agent-1', '/project/preview/about.html')).toBe(false)
  })

  it('一轮结束后记录清掉：下一次 begin 重新拍', async () => {
    const watch = new PrototypeWatch(
      stampQueue(
        { mtimeMs: 1, size: 10 },
        { mtimeMs: 2, size: 12 },
        { mtimeMs: 3, size: 12 },
        { mtimeMs: 4, size: 14 }
      )
    )
    await watch.begin('agent-1', '/p.html')
    expect(await watch.end('agent-1', '/p.html')).toBe(true)
    await watch.begin('agent-1', '/p.html')
    expect(await watch.end('agent-1', '/p.html')).toBe(true)
  })

  it('多个 agent 各记各的', async () => {
    const gathered: Array<{ path: string; stamp: FileStamp | null }> = [
      { path: '/a.html', stamp: { mtimeMs: 1, size: 1 } },
      { path: '/b.html', stamp: { mtimeMs: 5, size: 5 } },
      { path: '/a.html', stamp: { mtimeMs: 2, size: 1 } },
      { path: '/b.html', stamp: { mtimeMs: 5, size: 5 } }
    ]
    let index = 0
    const watch = new PrototypeWatch(async () => {
      const next = gathered[index]
      index += 1
      return next.stamp
    })
    // 两个 agent 的 begin 交错，end 不能串味
    await watch.begin('agent-a', '/a.html')
    await watch.begin('agent-b', '/b.html')
    expect(await watch.end('agent-a', '/a.html')).toBe(true)
    expect(await watch.end('agent-b', '/b.html')).toBe(false)
  })
})
