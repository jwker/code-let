import type { FlatSessionTree, TreeNavigateResult } from '@contract/index'

/**
 * 树操作的空实现。
 *
 * 大多数宿主测试不碰会话树；`PiRuntimePort` 要求这几个方法，
 * 用不到它们的 FakePi 直接把这四个函数挂上去就行，不用每个文件抄一遍。
 */
export const treeStubs = {
  readTree: (): FlatSessionTree => ({ nodes: [], leafId: null }),
  navigateTree: async (): Promise<TreeNavigateResult> => ({ cancelled: true }),
  forkTree: async (): Promise<string> => {
    throw new Error('测试里没有另开会话')
  },
  labelTree: async (): Promise<void> => {}
}
