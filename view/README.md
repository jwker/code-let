# view/

React 组件（呈现层）。一组件一视图，位置写死（PLAN.md D5）。

规矩：

- 组件从渲染进程的 Zustand store 直接取数（selector 就是一层投影）。
- 组件数据由对应扩展自己存（工作区 json 文件），不经宿主中转。
- 令牌集中在内核：组件不得自带原始色值、字号、圆角、阴影，一律消费
  `host/renderer/src/styles/tokens.css` 里的 CSS 变量。
- 组件不进侧栏。侧栏归宿主（项目切换器 + 对话列表）。

当前：**空的**。组件还没写。
