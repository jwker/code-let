import { dialog } from 'electron'

/** 系统文件选择器；返回 null 表示用户取消 */
export async function pickFiles(): Promise<string[] | null> {
  const result = await dialog.showOpenDialog({
    title: '选择要上传的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '所有文件', extensions: ['*'] }]
  })
  return result.canceled ? null : result.filePaths
}
