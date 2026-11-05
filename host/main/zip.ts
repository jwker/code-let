import { createWriteStream } from 'node:fs'

/**
 * 最小 zip 写入器。
 *
 * 只支持「不压缩」（store）这一种方式 —— 要打包的文件本来就是压缩过的
 * （容器是 gzip 成员、图片是二进制），再压一遍收益很小。
 *
 * zip 格式：本地文件头 + 数据 + 中央目录 + 中央目录结束记录。
 */

export interface ZipEntry {
  /** 包里的路径，用 / 分隔 */
  name: string
  data: Buffer
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS 时间日期 */
function dosTime(date: Date): { time: number; date: number } {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

/**
 * 把条目写成一个 zip 文件。
 *
 * 边读边写：条目按顺序追加到文件流上，不在内存里攒一整个包 ——
 * 几个 GB 的导出不能全放在内存里。
 */
export async function writeZip(
  path: string,
  entries: AsyncIterable<ZipEntry> | Iterable<ZipEntry>,
  onProgress?: (done: number, bytes: number) => void
): Promise<{ bytes: number; count: number }> {
  const stream = createWriteStream(path)
  const central: Array<{
    name: Buffer
    crc: number
    size: number
    offset: number
    time: number
    date: number
  }> = []
  let offset = 0
  let totalBytes = 0
  let count = 0

  const write = (buffer: Buffer): Promise<void> =>
    new Promise((resolve, reject) => {
      stream.write(buffer, (error) => (error ? reject(error) : resolve()))
    })

  for await (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const { time, date } = dosTime(new Date())
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed
    header.writeUInt16LE(0, 6) // flags
    header.writeUInt16LE(0, 8) // method: store
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(entry.data.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28) // extra length
    await write(header)
    await write(name)
    await write(entry.data)
    central.push({ name, crc, size: entry.data.length, offset, time, date })
    offset += header.length + name.length + entry.data.length
    totalBytes += entry.data.length
    count += 1
    onProgress?.(count, totalBytes)
  }

  const centralStart = offset
  for (const item of central) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4) // version made by
    header.writeUInt16LE(20, 6) // version needed
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10) // method: store
    header.writeUInt16LE(item.time, 12)
    header.writeUInt16LE(item.date, 14)
    header.writeUInt32LE(item.crc, 16)
    header.writeUInt32LE(item.size, 20)
    header.writeUInt32LE(item.size, 24)
    header.writeUInt16LE(item.name.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // disk
    header.writeUInt16LE(0, 36) // internal attrs
    header.writeUInt32LE(0, 38) // external attrs
    header.writeUInt32LE(item.offset, 42)
    await write(header)
    await write(item.name)
    offset += header.length + item.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  await write(end)

  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()))
  })

  return { bytes: totalBytes, count }
}
