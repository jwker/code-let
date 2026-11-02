/**
 * 「思考中」—— 消息发出去到首个 token 回来之间的占位。
 *
 * 那段时间是 TTFT（发请求 + 等服务端开始输出），慢模型要好几秒。按钮虽然已经
 * 变成停止方块，但用户的视线在内容区 —— 那里必须有个动静，否则看起来像消息丢了。
 *
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
