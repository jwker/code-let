/**
 * 文件相关的纯展示逻辑 —— 渲染进程用，不碰任何 IO。
 *
 * 主进程的 `host/main/files.ts` 里也有一份 `formatSize`，但那边带着 fs，
 * 渲染进程不能 import（边界 1）。两处同名不同源，改的时候都要改。
 */

/** 按扩展名给一个纯文字标记 —— 不引图标库，跟现有图标一样走线性风格 */
export function fileMark(name: string, kind: 'dir' | 'file'): string {
  if (kind === 'dir') return '▸'
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : ''
  if (ext === 'json') return '{}'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return '‹›'
  if (['md', 'markdown', 'txt'].includes(ext)) return '¶'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) return '◨'
  if (['html', 'htm'].includes(ext)) return '<>'
  if (['css', 'scss', 'less'].includes(ext)) return '#'
  return '·'
}

/** 可读的文件大小 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
