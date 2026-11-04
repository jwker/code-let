/**
 * 「思考中」—— 从用户发消息后一直显示到整轮流式输出结束。
 *
 * 中间可能有工具循环和多次模型请求；这段期间内容区始终保留一个“还在跑”的提示。
 * 三个点而不是转圈：转圈在这个应用里表示「后台在忙」（状态栏的刷新中），
 * 而这里是主流程在等一个回答，节奏该慢一点。
 */
export function Thinking() {
  return (
    <div className="thinking" role="status" aria-live="polite">
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      思考中
    </div>
  )
}
