# ext/

Pi 扩展（能力层）。跑在主进程内，由 Pi 的扩展运行时按路径加载。

## 规矩

- 只能用 `node:` 内置和 Pi 提供的包，**不得** import 渲染层库（`react`、`view/`）。
- Pi 提供的包（`@earendil-works/pi-ai`、`pi-agent-core`、`pi-coding-agent`、`pi-tui`、`typebox`）
  不得有物理副本 —— 由 Pi 的模块映射供给，本目录不要 `npm install` 它们。
- 扩展与宿主的通信走 Pi 的 EventBus（`pi.events`），不走 IPC。
- 扩展入口是**默认导出**一个函数：

  ```ts
  import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

  export default function myExtension(pi: ExtensionAPI): void {
    pi.registerCommand('my-command', {
      description: '做什么',
      handler: async () => {
        pi.sendMessage({ customType: 'my-command', content: '结果', display: true })
      }
    })
  }
  ```

命令可以提供参数补全。Codelet 在输入 `/deploy ` 后把当前参数前缀交给 `getArgumentCompletions`，
菜单里列出返回的候选；选中后只替换光标所在的参数 token。

```ts
pi.registerCommand('deploy', {
  description: '发布到指定环境',
  getArgumentCompletions: (prefix) =>
    ['staging', 'production']
      .filter((value) => value.startsWith(prefix))
      .map((value) => ({ value, label: value })),
  handler: async (args, ctx) => {
    // args 是用户输入的命令参数
  }
})
```

候选是 `{ value, label, description? }`；参数按空白分隔，带空格的值这一版不补全。
取不到候选或抛错时 Codelet 只是不显示菜单，不影响正常输入。

## 构建与加载

- `ext/**/*.ts` 由 `tsc -p tsconfig.ext.json` 编译到 `out/ext/`；`npm run dev` 和 `npm run build`
  都会先跑 `npm run build:ext`。
- 主进程的 `PiRuntime` 把 `out/ext` 通过 `createAgentSessionServices` 的
  `resourceLoaderOptions.additionalExtensionPaths` 交给 Pi；Pi 默认的
  `~/.pi/agent/extensions/` 和 `<cwd>/.pi/extensions/` 仍然照常发现。
- `out/main/index.mjs` → `new URL('../ext', import.meta.url)` 就是 `out/ext`；
  打包时 `electron-builder.yml` 的 `asarUnpack` 把 `out/ext/**` 解包，避免 asar 里的动态加载问题。
- `PiRuntime` 自己枚举 `out/ext` 下的顶层 `.js`，每个文件作为一个扩展入口传给 Pi；
  所以顶层每个 `.ts` 就是一颗扩展，多个扩展就放多个顶层文件。公共辅助代码放子目录 ——
  子目录不会作为入口，由顶层扩展 import。
- 加载/执行失败会显示在主区顶部（红色提示条），可以整批清除。

## 当前

`repo-status.ts` 注册 `/repo-status`：读 `git status --short --branch`（`core.quotePath=false`），
结果包在 `text` 代码块里，用 `pi.sendMessage()` 发成 custom 消息。
它验证了「编译 → 加载 → `/` 菜单 → 执行 → custom 消息」整条链路，也验证了扩展命令在流式期间执行。

`context-diff.ts` 是 Codelet 的内置观察扩展：监听 `context_with_system`，把请求前的 transcript
压成索引通过 EventBus 交给主进程。它不注册命令，也不修改模型请求；完整文本留在主进程的有限缓存里，
不是用户扩展，不需要手动调用。

改完 `ext/` 后先跑 `npm run build:ext`，再在输入框执行 `/reload`；它重载的是 `out/ext` 里编译后的 `.js`，不会替你编译源码。现在没有 `tsc --watch`，也不会热重载扩展产物。
