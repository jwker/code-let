import { dialog } from 'electron'
import { normalize } from 'node:path'

/**
 * 系统目录选择器。
 *
 * 单独一个模块，宿主状态才能在测试里拿假实现跑 —— 测试不引 electron 的窗口 API。
 */
export async function pickDirectory(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: '打开项目',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return normalize(result.filePaths[0])
}
