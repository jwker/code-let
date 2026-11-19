# Codelet 项目约定

这份文件由 Pi（以及嵌入 Pi 的 Codelet 自己）在每次会话开始时读入，所以只写**跨会话有效**的约定，
一次性的任务说明不要写在这里 —— 那些放 `.ai/planning/task.md`。

## 测试

**跑测试按改动挑相关文件，不默认全量。**

- 改某个模块的逻辑 → `npx vitest run tests/<相关>.test.ts`
- 改某个界面流程 → `npx playwright test e2e/<相关>.spec.ts`
- 只改 CSS 或文案 → 不跑测试，用下面的预览方式截图确认

`npm run typecheck` 要分开看：它没法只查一个文件（必须带上项目配置），但可以只跑涉及的工程
（`tsc -p tsconfig.node.json` 或 `tsc -p tsconfig.web.json`），单个工程两到四秒。

**需要全量时先问，不要自己决定。** 这三种算「需要」：

- **动了跨进程契约**（`contract/`、IPC 通道、preload 暴露面）。这类断裂不会在局部测试里露头：
  2026-11-17 那次 preload 的浏览器方法漏传 `host`，编译是过的（TypeScript 允许少参数的函数
  赋给多参数类型），只有跑全量 e2e 才抓到 —— 真机上一个浏览器标签都建不出来。
- **重命名公共 API 或数据结构字段。**
- **升级依赖**（Pi SDK、Electron）。

**e2e 有一个盲区**：原生 view 盖住 DOM 时，Playwright 的 `isVisible()` 照样返回 true。
浏览器面板用的 `WebContentsView` 就是这样 —— 气泡、菜单、对话框被它盖住，测试说「可见」，
人眼看是空的。这类覆盖关系只能靠截图确认。

## 测试钩子

只在设置了 `CODELET_USER_DATA` 的测试环境里挂，生产路径没有这些全局：

- `__codeletBrowser`：直接驱动浏览器（`tool(name, args, host)`、`getState(host)`、
  `annotationState(host)`），不必为浏览器工具准备真实模型。
- `__codeletSessionEvent(event)`：把一条 Pi 会话事件送进宿主，用来合成「一轮开始 / 结束」。
- `__codeletSystemPrompt(agentId)`：读某个 agent 当前的系统提示（验证按 runtime 注入的提示）。
- `__codeletLastPrompt`：主进程收到的上一条用户消息正文。配合 `CODELET_ECHO_PROMPT=1`，
  prompt 只记账、不调模型 —— 只关心「发出去的是什么」的用例用它。
- `__codeletSaveDialog`：导出保存对话框的替身。

**e2e 一律把 `PI_CODING_AGENT_DIR` 指到临时目录**，否则 Pi 会往真实的 agent 目录写会话。
要验重启行为的用例（预览恢复、原型目录）用同一个 `CODELET_USER_DATA` 启动两次。

## 代码

- 注释跟着它描述的声明走。新增方法或字段时不要插进已有 JSDoc 和它的声明之间 ——
  读的人会把注释安到新成员上（这次实现里连着犯过两次）。
- 页面上的 DOM 顺序不是契约。断言「画了哪几个号」这类集合先排序：鼠标恰好停在某一块上时，
  它的悬停角标会最后画，顺序就变了。

## 不用 Electron 的预览

改界面时不必起 Electron，也不用真模型：

```sh
npx vite --config vite.preview.config.ts   # http://localhost:5174
```

渲染进程会退回假宿主（`host/renderer/src/mock/host.ts`）：有项目、agent、会话、Git 改动、
文件和浏览器面板的假数据，但没有真 runtime。适合看布局、配色和状态组合。
要验真实宿主行为（原生 view、窗口、IPC）才需要 `npm run dev` 或 e2e。

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/` (spec + one file per ticket); gitignored.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, label strings equal to their names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the root, decisions in `docs/adr/`. See `docs/agents/domain.md`.
