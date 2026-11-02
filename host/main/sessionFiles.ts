import { existsSync } from 'node:fs'
import type { DeleteConversationsResult } from '@contract/index'

/**
 * 把一批会话文件移到系统废纸篓。
 *
 * **只做这一件事**：不碰标签、不碰列表、不做路径校验 —— 调用方（`HostState`）
 * 先确认这些路径都在当前会话列表里，再关掉引用它们的标签，最后才调这里。
 *
 * `trash` 作为参数传入：生产代码传 `shell.trashItem`，测试注入假实现，
 * 这样删除流程能在不启动 Electron 的 vitest 里跑。
 *
 * 失败逐条报告，不因为一条失败就丢掉其他条的结果。文件本来就不在了算成功 ——
 * 目标（它不存在）已经达成。
 */
export async function moveSessionFilesToTrash(
  paths: readonly string[],
  trash: (path: string) => Promise<void>
): Promise<DeleteConversationsResult> {
  const unique = [...new Set(paths)]
  const deleted: string[] = []
  const failed: DeleteConversationsResult['failed'] = []

  for (const path of unique) {
    if (!existsSync(path)) {
      deleted.push(path)
      continue
    }
    try {
      await trash(path)
      deleted.push(path)
    } catch (error) {
      // 竞态：判断存在之后、移入废纸篓之前被别处删掉了 —— 同样算成功
      if (!existsSync(path)) {
        deleted.push(path)
        continue
      }
      failed.push({ path, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  return { deleted, failed }
}
