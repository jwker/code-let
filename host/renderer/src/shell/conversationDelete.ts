import type { ConversationInfo, TabInfo } from '@contract/index'

/**
 * 删除会话的确认文案与受影响标签的统计（纯函数，好测）。
 *
 * 文案要回答三件事：文件去哪儿、哪些标签会关、哪些轮次会中止。
 * 数量从当前快照现算，不写死。
 */

export interface DeleteCopy {
  title: string
  body: string
  /** 危险提示：会关标签 / 会中止。没有就不显示 */
  warning?: string
  confirmText: string
}

export interface AffectedTabs {
  tabCount: number
  streamingCount: number
}

/** 选中的会话里，有多少开着标签、多少正在跑 */
export function countAffectedTabs(paths: readonly string[], tabs: readonly TabInfo[]): AffectedTabs {
  const wanted = new Set(paths)
  let tabCount = 0
  let streamingCount = 0
  for (const tab of tabs) {
    if (!tab.path || !wanted.has(tab.path)) continue
    tabCount += 1
    if (tab.streaming) streamingCount += 1
  }
  return { tabCount, streamingCount }
}

/** 单条删除的确认文案 */
export function singleDeleteCopy(title: string, affected: AffectedTabs): DeleteCopy {
  const warning =
    affected.streamingCount > 0
      ? '它开着的标签会一起关掉；agent 正在跑的话，会先中止再删除。'
      : affected.tabCount > 0
        ? '它开着的标签会一起关掉。'
        : undefined
  return {
    title: '删除这个对话？',
    body: `「${title}」的会话文件会移到系统废纸篓，可以从废纸篓恢复。`,
    warning,
    confirmText: affected.streamingCount > 0 ? '中止并删除' : '删除'
  }
}

/** 批量删除的确认文案 */
export function batchDeleteCopy(count: number, projects: readonly string[], affected: AffectedTabs): DeleteCopy {
  const parts: string[] = []
  if (affected.tabCount > 0) parts.push(`其中 ${affected.tabCount} 个开着标签，会一起关掉`)
  if (affected.streamingCount > 0) {
    parts.push(
      `${parts.length > 0 ? '' : '其中 '}${affected.streamingCount} 个正在生成，会先中止再删除`
    )
  }

  const projectLine =
    projects.length > 1
      ? `\n来自 ${projects.length} 个项目：${projects.slice(0, 3).join('、')}${projects.length > 3 ? ' 等' : ''}。`
      : ''

  return {
    title: `删除 ${count} 个对话？`,
    body: `这 ${count} 个会话文件会移到系统废纸篓，可以从废纸篓恢复。${projectLine}`,
    warning: parts.length > 0 ? `${parts.join('；')}。` : undefined,
    confirmText: affected.streamingCount > 0 ? '中止并删除' : '删除'
  }
}

/**
 * 选中的会话来自哪几个项目（按项目清单的顺序，名字去重）。
 *
 * 侧栏只列清单里的项目，所以会话的 cwd 一定能在这里找到。
 */
export function projectNamesOf(
  paths: readonly string[],
  conversations: readonly ConversationInfo[],
  projects: readonly { path: string; name: string }[]
): string[] {
  const wanted = new Set(paths)
  const cwds = new Set(conversations.filter((c) => wanted.has(c.path)).map((c) => c.cwd))
  return projects.filter((project) => cwds.has(project.path)).map((project) => project.name)
}
