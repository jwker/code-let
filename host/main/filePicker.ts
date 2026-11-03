import { dialog } from 'electron'

/** 系统文件选择器；返回 null 表示用户取消 */
export async function pickFiles(): Promise<string[] | null> {
  // E2E 用：绕过系统对话框，直接返回测试指定的文件
  const fixture = process.env.CODELET_PICK_FILES
  if (fixture) {
    try {
      const parsed = JSON.parse(fixture) as unknown
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string')
    } catch {
      // 环境变量坏了就当没设置
    }
  }

  const result = await dialog.showOpenDialog({
    title: '选择要上传的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '所有文件', extensions: ['*'] }]
  })
  return result.canceled ? null : result.filePaths
}
