/**
 * 右栏刷新要失效哪些缓存（纯函数，好测）。
 *
 * 只清**当前项目里用户真的打开过的东西**：已展开的目录各一层、当前文件的正文。
 * 根目录不在这里 —— 刷新动作每次都会重读根目录，跟有没有展开无关。
 * 别的项目的缓存一概不动：切回去不该白读一遍。
 */

export interface RefreshPlan {
  /** `treeEntries` 的键：`cwd\u0001目录相对路径` */
  treeKeys: string[]
  /** `fileContents` 的键：文件的绝对路径 */
  filePaths: string[]
}

export function planPanelRefresh(input: {
  cwd: string
  /** 文件树里展开的目录（相对 cwd） */
  expandedDirs: readonly string[]
  /** 当前选中的文件绝对路径；没有就是 null */
  activeFilePath: string | null
}): RefreshPlan {
  const { cwd, expandedDirs, activeFilePath } = input
  if (!cwd) return { treeKeys: [], filePaths: [] }

  const treeKeys: string[] = []
  const seen = new Set<string>()
  for (const dir of expandedDirs) {
    // 根目录由刷新动作无条件重读，不重复算进这里
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    treeKeys.push(`${cwd}\u0001${dir}`)
  }

  return {
    treeKeys,
    filePaths: activeFilePath ? [activeFilePath] : []
  }
}
