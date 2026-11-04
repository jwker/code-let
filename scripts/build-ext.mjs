import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/*
 * 编译项目内扩展：ext/**\/*.ts → out/ext/*.js。
 *
 * 不能「先清空 out/ext 再编译」：out/ext 是 Codelet 运行时实时读取的扩展目录，
 * 目录空着的这段时间里只要发生一次扩展重载，Pi 就会把扩展工具判定为消失，
 * 写进会话文件之后那个分支里就再也回不来了。
 *
 * 所以改成：编译到暂存目录 → 逐个 rename 进 out/ext → 删掉源文件已经不存在的旧产物。
 * 换成 rename 之后 out/ext 任何时刻都不会是空的，单个文件的替换也是原子的。
 * 编译失败就停在暂存目录，out/ext 保持上一次能用的产物。
 */

const staging = 'out/ext.tmp'
const target = 'out/ext'

rmSync(staging, { recursive: true, force: true })

try {
  execFileSync('tsc', ['-p', 'tsconfig.ext.json', '--outDir', staging], { stdio: 'inherit' })
} catch (error) {
  rmSync(staging, { recursive: true, force: true })
  const reason = error instanceof Error ? error.message : String(error)
  console.error(`扩展编译失败，保留上一次的 out/ext 产物：${reason}`)
  process.exit(1)
}

const produced = readdirSync(staging)
mkdirSync(target, { recursive: true })

for (const name of produced) {
  const dest = join(target, name)
  // 文件直接 rename 覆盖；同名目录先删掉，否则 rename 会因非空失败
  if (existsSync(dest) && statSync(dest).isDirectory()) rmSync(dest, { recursive: true, force: true })
  renameSync(join(staging, name), dest)
}

// 删掉源文件已经不存在的旧产物：不留着，否则 Pi 还会继续加载被删掉的扩展
const keep = new Set(produced)
for (const name of readdirSync(target)) {
  if (!keep.has(name)) rmSync(join(target, name), { recursive: true, force: true })
}

rmSync(staging, { recursive: true, force: true })
