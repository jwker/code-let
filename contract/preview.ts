/**
 * 产品 agent 的原型预览：没有可恢复的地址时，从项目的原型目录里挑。
 *
 * 这里只放形状 —— 目录怎么读、该显示什么，都在主进程
 * （`host/main/prototypeFiles.ts`）。
 */

/** 原型目录里的一个文件 */
export interface PrototypeFile {
  /** 文件名（不含目录） */
  name: string
  /** 绝对路径 */
  path: string
  /** 打开它用的地址（`file:`） */
  url: string
  /** 修改时间（毫秒）—— 列表按它倒序 */
  modified: number
}

/** 一个项目的原型目录此刻的样子 */
export interface PrototypeListing {
  /** 解析后的绝对路径 */
  dir: string
  /** 目录存不存在；不存在时也算一种空态（跟「存在但没文件」分开说） */
  exists: boolean
  /** 顶层的 `.html` / `.htm`，按修改时间倒序 */
  files: PrototypeFile[]
}

/**
 * 预览区该显示什么。
 *
 * - `restore`：上次看的本地文件还能用，直接开回来；
 * - `list`：没有可恢复的地址，但目录里有原型，列出来让用户挑；
 * - `empty`：都没有 —— 看 `listing.exists` 决定是「目录还不存在」还是「目录里没有文件」。
 */
export type PreviewEntry =
  | { kind: 'restore'; url: string }
  | { kind: 'list'; listing: PrototypeListing }
  | { kind: 'empty'; listing: PrototypeListing }
