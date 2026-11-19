import { stat } from 'node:fs/promises'

/**
 * 「这一轮动过原型文件没有」的记账。
 *
 * 一轮开始时拍下预览文件的**修改时间与大小**，轮结束时再拍一次比较。
 * 只比 mtime 不够：同一毫秒里写完的文件 mtime 可能一样，大小会变。
 *
 * 两处用它：
 * - 自动刷新：动过就重新加载预览，没动过就不动（别把用户的滚动位置带走）；
 * - 保号校验（下一票）：动过才需要读文件比对锚点。
 *
 * 判据是「同一个路径」：这一轮里预览自己换到了别的页面，预览已经在显示新东西了，
 * 不该再按旧文件去刷它。
 */

/** 一个文件的时刻：修改时间（毫秒）与字节数；文件不在时整份是 null */
export interface FileStamp {
  mtimeMs: number
  size: number
}

/** 拍一个文件的时间戳；文件不在（或读不了）就是 null */
export async function stampFile(path: string): Promise<FileStamp | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) return null
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    // 还没建出来的文件、或者路径已经不是文件 —— 都当「不在」
    return null
  }
}

/** 两份时间戳是不是同一个样子（都没变） */
export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  if (!a || !b) return a === b
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

interface BeginState {
  /** 这一轮开始时预览指向的文件；null = 当时没有可看的本地文件 */
  path: string | null
  stamp: FileStamp | null
}

export class PrototypeWatch {
  private readonly before = new Map<string, BeginState>()
  /** 上一次 begin 的异步任务：begin 和 end 离得太近时，end 要等它拍完 */
  private readonly pending = new Map<string, Promise<void>>()

  /** `stamp` 可注入 —— 测试里不用碰磁盘 */
  constructor(private readonly stamp: (path: string) => Promise<FileStamp | null> = stampFile) {}

  /** 一轮开始：记下文件此刻的样子 */
  begin(agentId: string, path: string | null): Promise<void> {
    const task = (this.pending.get(agentId) ?? Promise.resolve()).then(async () => {
      this.before.set(agentId, { path, stamp: path ? await this.stamp(path) : null })
    })
    this.pending.set(agentId, task)
    return task
  }

  /**
   * 一轮结束：这一轮动过文件没有？
   *
   * 没开始过、没有预览文件、或者这一轮里预览已经换到别的文件 —— 都算没动过。
   * 无论结论如何，这一次的记账都清掉，下一轮重新拍。
   */
  async end(agentId: string, path: string | null): Promise<boolean> {
    await (this.pending.get(agentId) ?? Promise.resolve()).catch(() => undefined)
    const state = this.before.get(agentId)
    this.before.delete(agentId)
    this.pending.delete(agentId)
    if (!state || !state.path || !path || state.path !== path) return false
    return !sameStamp(state.stamp, await this.stamp(path))
  }

  clear(): void {
    this.before.clear()
    this.pending.clear()
  }
}
