# Codelet

内嵌 [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) SDK 的桌面编码代理宿主。

Pi 是一个能在终端里读写代码、执行命令的编码代理。Codelet 把它装进一个桌面应用：多标签、多项目、
文件预览、可中断的对话 —— 用的是 Pi 自己的会话文件、凭据和扩展，不是另起一套。

## 功能

**多标签，互不打断。** 每个标签背后是一个独立的 Pi runtime（一套 services、一套扩展、一套事件总线）。
切标签不会 abort 正在跑的那一轮 —— 后台标签可以继续干活。

**项目与会话。** 侧栏按项目分组列出会话，项目清单存在应用数据目录里。移除项目只是从清单里去掉，
Pi 的会话文件一个字节都不动。

**对话区三种排版。** 普通（Markdown）、终端（ANSI）、HTML。前两种读同一份内容流。

**一轮对话分主次。** 一条用户消息之后的几十条助手消息和工具调用会折叠成一行「过程」，
最终答案单独顶格；下方一行元信息：复制、输出 token、缓存、耗时。

**随时叫停。** 发送按钮在生成中变成停止方块，`Esc` 同效。已经生成的内容会保留并标「已中止」。

**文件预览。** 右侧面板里浏览当前会话目录的文件树，预览 Markdown、图片、HTML（沙箱 iframe）、
代码（Shiki 高亮）和纯文本。

**模型切换。** 每个会话可以单独选模型，切换写进会话文件；也可以设为新会话的默认。

**外部改动检测。** 会话文件在别处被改过时，标签会标记为「需要重新加载」并暂时锁住输入 ——
避免用旧上下文覆盖别处写入的内容。

## 快速开始

```bash
npm install
npm run dev
```

首次启动会在系统应用数据目录里创建配置文件。Pi 的凭据默认读 `~/.pi/agent/`，
所以在终端里 `pi` 登录过的账号可以直接用。

## 架构

```
host/
├── main/        主进程：Pi SDK 封装、权威状态、IPC、文件读取
├── preload/     contextBridge（必须是 CJS）
└── renderer/    React + Zustand（含浏览器预览用的假宿主）
contract/        主进程与渲染进程共享的纯类型、IPC 规格、事件折叠逻辑
tests/           vitest（不启动 Electron）
build/           应用图标（源文件 + 生成产物）
scripts/         图标生成脚本
ext/ view/       预留：Pi 扩展与独立视图组件
```

几条贯穿全局的约定：

**主进程是唯一的数据面。** 渲染进程不碰文件系统、不碰 Pi，一切都过 IPC。
所有 IPC 入参用 zod 校验，事件按 16ms 合并窗口推送，单条载荷上限 256KB。

**事件不是类型化导入的。** 渲染进程用自己的 `{ type, data }` 接 Pi 的事件，
不 import SDK 的事件类型 —— 这样渲染进程不依赖 Pi，能单独构建和测试。

**状态分为「事实」和「怎么显示」。** 主进程只推事实（`refreshing: true`），
「延迟 200ms 才显示、显示了至少停 500ms」这类展示规则全在渲染进程，
可以在没有 Electron 的环境里单测。

## 容易踩的坑

- **Pi 必须外部化。** Pi 的扩展加载器用模块映射把 `@earendil-works/pi-ai` 等包强制解析到
  Pi 自己那份。electron-vite 若把 Pi 打进产物，就会出现两份类实例，`instanceof` 全部失效。
- **Pi 是 ESM-only**，所以主进程也是 ESM（`out/main/index.mjs`）。
- **preload 必须是 CJS**（`sandbox: true`）。
- **`app://` 协议要在 `app.ready` 之前注册**，否则相对路径、`fetch`、ES module 脚本失效。
- **`AgentSessionRuntime.dispose()` 不 await 正在跑的那一轮**。关标签或重建前必须先自己
  `await session.abort()`，否则半截轮次可能没落盘。
- **`switchSession()` 会 abort 当前轮**（内部 `teardownCurrent()`）。这也是为什么每个标签
  用独立 runtime 而不是共享一个。
- **Electron 二进制下载慢**：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 命令

```bash
npm run dev        # 开发（vite dev server + electron）
npm run build      # 构建到 out/
npm start          # 预览构建产物
npm run typecheck  # 主进程 / 渲染进程两套 tsconfig
npm test           # vitest
npm run icon       # 重新生成应用图标（需要 Electron）
npm run dist       # 打包（electron-builder）
```

## 浏览器预览模式

`npm run dev` 之后直接在浏览器打开 `http://localhost:5173` 也能看到完整界面，数据是假的。

渲染层统一从 `host/renderer/src/host.ts` 取宿主能力：`window.codelet` 存在时走 preload，
不存在时回落到 `mock/host.ts` 的假实现。状态栏右下角会显示「浏览器预览 · 假数据」。

这不是产品形态（应用的数据面全在主进程），只是让 UI 迭代能脱离 Electron 单独跑。

## 协议

[MIT](./LICENSE) © 2026 jwker
