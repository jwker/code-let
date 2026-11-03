import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

/**
 * Codelet 自带的第一个项目内扩展。
 *
 * `/repo-status` 只是读 `git status` 并把结果用 `pi.sendMessage()` 发出来 ——
 * 不改文件、不调模型，适合验证「ext 构建 → Pi 加载 → / 菜单 → 执行 → custom 消息」
 * 整条链路。它也验证了扩展命令在流式期间执行时不会打断当前轮。
 */
export default function repoStatus(pi: ExtensionAPI): void {
  pi.registerCommand('repo-status', {
    description: '显示当前仓库的 git 状态',
    handler: async () => {
      try {
        const result = await pi.exec('git', ['-c', 'core.quotePath=false', 'status', '--short', '--branch'])
        const output = result.stdout.trim()
        const content =
          result.code === 0
            ? output || '工作区干净'
            : `git status 失败：${result.stderr.trim() || `exit ${result.code}`}`
        const body = content.length > 8000 ? `${content.slice(0, 8000)}\n…（截断）` : content
        // 用代码块包住：git 的分支行以 ## 开头，裸 Markdown 会把它当标题吃掉；
        // 代码块同时保留缩进和引号。core.quotePath=false 让中文路径不变成八进制。
        pi.sendMessage({
          customType: 'repo-status',
          content: `\`\`\`text\n${body}\n\`\`\``,
          display: true
        })
      } catch (error) {
        pi.sendMessage({
          customType: 'repo-status',
          content: `\`\`\`text\ngit status 执行失败：${error instanceof Error ? error.message : String(error)}\n\`\`\``,
          display: true
        })
      }
    }
  })
}
