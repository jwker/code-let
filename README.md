# Codelet

内嵌 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK 的桌面编码代理宿主。

决策记录在 [`.ai/PLAN.md`](./.ai/PLAN.md) —— **唯一权威文档**。视觉风格稿在
[`.ai/design/pi-desktop-style-draft.html`](./.ai/design/pi-desktop-style-draft.html)（`.ai/` 不进版本库）。

## 当前状态：骨架

仓库骨架与应用页面框架已搭好，**组件一个都还没写**。

已搭好的部分：

- 仓库骨架：electron-vite + TypeScript，主进程 ESM（`.mjs`）、preload CJS（`.cjs`）
- 主进程：Pi runtime 封装（按目录起会话、列对话、切会话、发消息）
- 宿主权威状态：项目列表（`userData`）+ 对话列表（`SessionManager.list(cwd)`）
- IPC：contextBridge + zod 校验，增量事件 16ms 合并窗口，单条载荷 256KB 上限
- 页面框架：导航轨 · 上下文侧栏（项目切换器 + 对话列表）· 主工作区 · 右侧检视器 · 底部状态栏
- 对话区骨架：普通 / 终端 / HTML 三种排版的切换器与空态容器
- 设计令牌 → CSS 变量，Tailwind v4 只消费令牌；亮暗两套主题，默认亮色，导航轨底部可切（记住选择）

还没写的部分（下一步）：

- 对话区的消息流、工具轨迹、滚动保持、HTML 模式的沙箱 iframe
- `ext/` + `view/` 里的组件（看板、记忆图谱、代码……）
- node-pty 终端面板（需 electron-rebuild 对齐 Electron ABI）
- HTML 模式按 D3 走 `<iframe sandbox="allow-scripts">`，内容不进主 frame

## 目录

```
repo/
├── host/
│   ├── main/                主进程：Pi SDK、状态权威、IPC
│   ├── preload/             contextBridge
│   └── renderer/            React + Zustand（含核心组件：对话区、侧栏项目切换器与对话列表）
├── ext/                     Pi 扩展（能力层），按路径加载
├── view/                    React 组件（呈现层），一组件一视图
└── contract/                ext 与 view 共享的纯类型 + IPC 规格
```

## 命令

```bash
npm install
npm run dev        # 开发（vite dev server + electron）
npm run build      # 构建到 out/
npm start          # 预览构建产物
npm run typecheck  # 主进程 / 渲染进程两套 tsconfig
npm run dist       # 打包（electron-builder）
```

## 浏览器预览模式

`npm run dev` 之后，直接在浏览器打开 `http://localhost:5173` 也能看到完整的页面框架。
数据是假的 —— 真实数据全在主进程，浏览器里没有 preload、没有 IPC。

- 渲染层不直接碰 `window.codelet`，统一走 `host/renderer/src/host.ts`；
  那里在 `window.codelet` 不存在时回落到 `mock/host.ts` 的假实现。
- 状态栏右下角会显示「浏览器预览 · 假数据」，提醒这不是真数据。
- Electron 里跑完全不受影响，preload 存在时走的是真 API。

浏览器端能开是**副产品**，不是产品形态：这个应用的数据面全在主进程，
浏览器版没有意义。之所以留这条兜底路径，是因为它让 UI 迭代可以脱离 Electron 单独跑。

## 几个不能碰的坑

- **Pi 必须外部化**。Pi 的扩展加载器用模块映射把 `@earendil-works/pi-ai` 等包强制解析到
  Pi 自己那份。electron-vite 若把 Pi 打进产物，就会出现两份类实例，`instanceof` 全部失效。
- **Pi 是 ESM-only**，所以主进程也是 ESM（`out/main/index.mjs`）。
- **preload 必须是 CJS**（`sandbox: true`）。
- **`app://` 协议要在 `app.ready` 之前注册**，否则相对路径、`fetch`、ES module 脚本失效。
- **photon-node 是 wasm**，打包时要 `asarUnpack`；node-pty 要 electron-rebuild。
- **Electron 二进制下得慢的话换源**：
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js`
