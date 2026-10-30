import { ConversationArea } from '../conversation/ConversationArea'

/**
 * 主工作区 —— 一张卡，**永远是对话**。
 *
 * 导航（看板 / 记忆 / 代码 / 终端）现在只在右侧面板里打开，
 * 不再把主区换掉：对话始终在，切视图不打断你正在看的那一轮。
 */
export function MainArea() {
  return (
    <main className="shell-card main">
      <div className="shell-main">
        <ConversationArea />
      </div>
    </main>
  )
}
