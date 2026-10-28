# ext/

Pi 扩展（能力层）。跑在主进程内，由 Pi 的扩展运行时按路径加载。

规矩（PLAN.md 边界 5 / 6 / 7）：

- 只能用 `node:` 内置和 Pi 提供的包，**不得** import 渲染层库（`react`、`view/`）。
- Pi 提供的包（`@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`）
  不得有物理副本 —— 由 Pi 的模块映射供给，本目录不要 `npm install` 它们。
- 扩展与宿主的通信走 Pi 的 EventBus（`pi.events`），不走 IPC。
- 扩展产物由 electron-vite 编译成 `.js`，主进程把产物目录交给 Pi 加载；
  主进程不直接 import 扩展模块。

当前：**空的**。组件还没写。
