import type {
  CodeletApi,
  CommandOption,
  ContextDiffSession,
  ContextDiffView,
  ContextSnapshotRef,
  ConversationInfo,
  FileEntry,
  FileSearchResult,
  FileTab,
  HostSnapshot,
  ModelOption,
  ProjectInfo,
  SessionEvent,
  StreamItem,
  ThinkingLevel
} from '@contract/index'

/**
 * 浏览器预览用的假宿主。
 *
 * 渲染进程在 Electron 里靠 preload 暴露的 window.codelet 拿数据；
 * 直接在浏览器里打开时那个 API 不存在。与其崩成白屏，不如给一份假数据，
 * 让页面骨架能单独调 —— 布局、模式切换、主题都能在浏览器里迭代。
 *
 * 假数据只到「长得像」为止：不连 Pi，不落盘，不发消息。
 */

const FAKE_CONTEXT_BASELINE: ContextSnapshotRef = {
  id: 'fake-session:1',
  sessionId: 'fake-session',
  sessionPath: '/fake/session.jsonl',
  sessionName: '上一次请求',
  turn: 3,
  request: 1,
  capturedAt: Date.now() - 60_000,
  totalTokens: 12_400
}

const FAKE_CONTEXT_CURRENT: ContextSnapshotRef = {
  id: 'fake-session:2',
  sessionId: 'fake-session',
  sessionPath: '/fake/session.jsonl',
  sessionName: '本会话',
  turn: 3,
  request: 2,
  capturedAt: Date.now(),
  totalTokens: 13_100
}

const FAKE_CONTEXT_DIFF: ContextDiffView = {
  current: FAKE_CONTEXT_CURRENT,
  baseline: FAKE_CONTEXT_BASELINE,
  tokens: { before: 12_400, after: 13_100 },
  system: 'same',
  tools: 'same',
  toolsApproximate: true,
  counts: { added: 3, removed: 0, modified: 0, shared: 42 },
  groups: [
    {
      kind: 'added',
      label: '新增',
      messages: [
        { key: 'u1', role: 'user', hash: 'u1', tokens: 34, preview: '我补充一下：这里应该按游标增量读，不要每次全量扫描。' },
        { key: 't1', role: 'toolResult', hash: 't1', tokens: 412, preview: 'read · src/memory/index.ts · 已返回 212 行' },
        { key: 'a1', role: 'assistant', hash: 'a1', tokens: 254, preview: '已改为按 updatedAt 游标读取，补了游标回退的边界。' }
      ]
    }
  ]
}

const FAKE_CONTEXT_SESSIONS: ContextDiffSession[] = [
  {
    sessionId: 'fake-session',
    sessionName: '本会话',
    sessionPath: '/fake/session.jsonl',
    first: FAKE_CONTEXT_BASELINE,
    last: FAKE_CONTEXT_CURRENT
  }
]

const FAKE_PROJECTS: ProjectInfo[] = [
  { path: '/Users/demo/Projects/codelet', name: 'codelet' },
  { path: '/Users/demo/Projects/pi-sdk', name: 'pi-sdk' },
  { path: '/Users/demo/Projects/web', name: 'web' }
]

const FAKE_CONVERSATIONS: Record<string, ConversationInfo[]> = {
  '/Users/demo/Projects/codelet': [
    {
      id: 'c1',
      path: '/fake/codelet/1.jsonl',
      title: '记忆索引重构',
      name: null,
      modified: new Date().toISOString(),
      messageCount: 24,
      cwd: '/Users/demo/Projects/codelet'
    },
    {
      id: 'c2',
      path: '/fake/codelet/2.jsonl',
      title: '类型声明生成',
      name: null,
      modified: new Date(Date.now() - 18 * 60_000).toISOString(),
      messageCount: 9,
      cwd: '/Users/demo/Projects/codelet'
    },
    {
      id: 'c3',
      path: '/fake/codelet/3.jsonl',
      title: '扫描依赖关系',
      name: null,
      modified: new Date(Date.now() - 26 * 3600_000).toISOString(),
      messageCount: 51,
      cwd: '/Users/demo/Projects/codelet'
    }
  ],
  '/Users/demo/Projects/pi-sdk': [
    {
      id: 'c4',
      path: '/fake/pi-sdk/1.jsonl',
      title: '流式输出的三种写法',
      name: null,
      modified: new Date(Date.now() - 40 * 60_000).toISOString(),
      messageCount: 12,
      cwd: '/Users/demo/Projects/pi-sdk'
    }
  ],
  '/Users/demo/Projects/web': []
}

/** 假文件树：够看出文件浏览器长什么样 */
const FAKE_TREE: Record<string, FileEntry[]> = {
  '': [
    { name: '.git', kind: 'dir' },
    { name: 'src', kind: 'dir' },
    { name: 'package.json', kind: 'file', size: 812 },
    { name: 'README.md', kind: 'file', size: 1420 },
    { name: 'tsconfig.json', kind: 'file', size: 336 }
  ],
  src: [
    { name: 'memory', kind: 'dir' },
    { name: 'index.ts', kind: 'file', size: 2048 },
    { name: 'tokens.ts', kind: 'file', size: 640 }
  ],
  'src/memory': [
    { name: 'cursor.ts', kind: 'file', size: 1180 },
    { name: 'index.ts', kind: 'file', size: 3460 }
  ]
}

/** 假文件内容：按扩展名给一份能看出渲染效果的东西 */
const FAKE_FILES: Record<string, string> = {
  'README.md':
    '# 记忆索引重构\n\n' +
    '索引写入从**全量重建**改成了增量。\n\n' +
    '## 改动\n\n' +
    '- 按 `updatedAt` 游标增量更新\n' +
    '- 补了 3 个用例\n\n' +
    '| 用例 | 结果 |\n| --- | --- |\n| rebuildIndex | passed |\n| cursor 边界 | passed |\n',
  'package.json': '{\n  "name": "codelet",\n  "version": "0.1.0"\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n',
  'src/index.ts':
    "import { readIndex, writeIndex } from './memory'\n\n" +
    'export async function rebuild(): Promise<void> {\n' +
    '  const index = await readIndex()\n' +
    '  await writeIndex(index)\n' +
    '}\n',
  'src/tokens.ts': 'export const tokens = { fg: "#1B1B19" }\n',
  'src/memory/index.ts': 'export async function readIndex() {\n  return []\n}\n',
  'src/memory/cursor.ts': 'export const cursorVersion = 3\n'
}

/** `@` 搜索用的假文件列表（相对项目根） */
const FAKE_SEARCH_PATHS: FileSearchResult[] = [
  { path: 'src', kind: 'dir' },
  { path: 'src/index.ts', kind: 'file' },
  { path: 'src/tokens.ts', kind: 'file' },
  { path: 'src/memory', kind: 'dir' },
  { path: 'src/memory/index.ts', kind: 'file' },
  { path: 'src/memory/cursor.ts', kind: 'file' },
  { path: 'package.json', kind: 'file' },
  { path: 'README.md', kind: 'file' },
  { path: 'tsconfig.json', kind: 'file' }
]

/** 假命令列表：模板 / 扩展 / 技能各一条 */
const FAKE_COMMANDS: CommandOption[] = [
  { name: 'review', description: '代码审查模板', source: 'template' },
  { name: 'deploy', description: '发布到预发环境', source: 'extension', hasArgumentCompletions: true },
  { name: 'skill:pdf', description: 'PDF 处理技能', source: 'skill' }
]

/** 假的内容流：够看出普通模式长什么样 */
const FAKE_ITEMS: StreamItem[] = [
  { kind: 'message', role: 'user', text: '把记忆索引改成增量更新，顺便把 `tokens.ts` 的导出整理一下。' },
  {
    kind: 'message',
    role: 'assistant',
    text: '好的。我先读了现有的索引实现，索引写入是全量重建，在 12k 条记忆上约 1.8s。',
    stats: { input: 6214, output: 93, cacheRead: 189, cacheWrite: 0, durationMs: 4044, startedAt: Date.now() - 60_000 }
  },
  { kind: 'tool', callId: 'c1', name: 'read', status: 'ok' },
  { kind: 'tool', callId: 'c2', name: 'grep', status: 'ok' },
  { kind: 'tool', callId: 'c3', name: 'edit', status: 'ok' },
  { kind: 'tool', callId: 'c4', name: 'bash', status: 'running', label: 'npm test -- --run' },
  {
    kind: 'message',
    role: 'toolResult',
    // 带 ANSI 的测试输出：终端模式要还原颜色（R4）
    callId: 'c4',
    text:
      '\u001b[32m✓\u001b[0m src/memory/index.ts\n' +
      '\u001b[32m✓\u001b[0m src/memory/cursor.ts\n' +
      '\u001b[31m✗\u001b[0m src/memory/legacy.ts\n\n' +
      '\u001b[1m42 passed / 42\u001b[0m'
  },
  {
    kind: 'message',
    role: 'assistant',
    text: '已改为按 updatedAt 游标增量更新，并补上 3 个用例。测试全绿（42 passed / 42）。',
    stats: { input: 7960, output: 601, cacheRead: 6764, cacheWrite: 0, durationMs: 5521, startedAt: Date.now() - 60_000 }
  },
  { kind: 'message', role: 'user', text: '再补一个迁移脚本，把旧的 legacy 索引整个删掉，别留下半套。' },
  {
    kind: 'message',
    role: 'assistant',
    text:
      '迁移脚本在 `scripts/migrate-index.ts`，做三件事：先按 `updatedAt` 重算一遍游标，' +
      '再删掉 `legacy.ts` 留下的那份全量索引文件，最后写一个新版本号。\n\n' +
      '**幂等**：跑第二遍时游标已经是最新的、旧索引文件也不在，直接跳过，输出 `nothing to do`。\n\n' +
      '**失败回滚**：重算完成之前不动旧文件 —— 中途失败就还是旧索引在服务，不会出现两边都没有的空档。'
  },
  { kind: 'tool', callId: 'c5', name: 'bash', status: 'ok', label: 'node scripts/migrate-index.ts --dry-run' },
  {
    kind: 'message',
    role: 'toolResult',
    callId: 'c5',
    text:
      '\u001b[32m✓\u001b[0m reindexed 12480 memories\n' +
      '  would remove ~/.codelet/index/legacy.bin (3.2 MB)\n' +
      '\u001b[32m✓\u001b[0m validated manifest\n\n' +
      '\u001b[1mdry run · nothing written\u001b[0m'
  },
  {
    kind: 'message',
    role: 'assistant',
    text:
      '试运行没问题，接着把正式迁移和清理也做完了。现在的顺序是这样：\n\n' +
      '1. 读 `manifest.json`，确认版本号比当前代码要求的低\n' +
      '2. 按 `updatedAt` 重算游标，写进 `cursor.json`（先写临时文件再 rename，断电也不会半截）\n' +
      '3. 删 `legacy.bin`，删掉 `legacy.ts` 里的三条老接口\n' +
      '4. 最后一步才把版本号推到 3，前一步失败就整轮重来\n\n' +
      '顺手把 `tokens.ts` 的导出收成了两个：`tokens` 和 `themeVars`。原来散着的十几个具名导出没别的地方在用，' +
      '清单我放在下面，命名和顺序都没动，只是从「到处 import 单个变量」变成「import 一个对象」。'
  },
  { kind: 'message', role: 'user', text: '好，那就这样。把改动整理成一条提交信息给我。' }
]

/**
 * 假的可用模型清单。
 *
 * 名字用真实目录里的写法 —— 有的带空格（`DeepSeek V4.1 Flash`）、
 * 有的带 provider 前缀（`Qwen/Qwen3-8B`）。早先这些假名字直接用了 id，
 * 把「显示时把名字截成最后一个词」的 bug 盖住了。
 */
const FAKE_MODELS: ModelOption[] = [
  { provider: 'minimax-cn', id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', contextWindow: 200_000, reasoning: true, cost: { input: 0.2, output: 1.1 } },
  { provider: 'minimax-cn', id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 200_000, reasoning: true, cost: { input: 0.6, output: 2.4 } },
  { provider: 'minimax-cn-openai', id: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash OpenAI', contextWindow: 200_000, reasoning: true, cost: { input: 0.2, output: 1.1 } },
  { provider: 'deepseek', id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', contextWindow: 128_000, reasoning: true, cost: { input: 0.1, output: 0.4 } },
  { provider: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 128_000, reasoning: true, cost: { input: 0.8, output: 3.2 } },
  { provider: 'siliconflow', id: 'Qwen/Qwen3-8B', name: 'Qwen/Qwen3-8B', contextWindow: 32_000, reasoning: false, cost: { input: 0, output: 0 } }
]

/** 假回复：一段带格式的文字，一段段吐出来 */
const FAKE_REPLY = [
  '### 改完了\n\n',
  '已改为按 `updatedAt` 游标增量更新，并补上 3 个用例。\n\n',
  '- 索引写入：**全量重建 → 增量**\n',
  '- 12k 条记忆：**1.8s → 120ms**\n\n',
  '| 用例 | 结果 |\n| --- | --- |\n| rebuildIndex | passed |\n| cursor 边界 | passed |\n\n',
  '测试全绿（42 passed / 42）。'
]

/** 假工具输出：一行行吐出来，工具还在跑的时候就能看见（R4） */
const FAKE_TOOL_LINES = [
  '\u001b[32m✓\u001b[0m src/memory/index.ts\n',
  '\u001b[32m✓\u001b[0m src/memory/cursor.ts\n',
  '\u001b[31m✗\u001b[0m src/memory/legacy.ts\n',
  '\u001b[1m42 passed / 42\u001b[0m'
]

export function createMockApi(): CodeletApi {
  /** 假标签：每个标签一个会话 */
  interface FakeTab {
    id: string
    cwd: string
    path: string | null
    title: string
    items: StreamItem[]
    model: ModelOption | null
    thinkingLevel: ThinkingLevel
    streaming: boolean
  }

  const tabs: FakeTab[] = []
  let activeTabId: string | null = null
  /** 浏览器预览里的临时对话 */
  let temporary: { id: string; cwd: string; model: ModelOption | null; streaming: boolean } | null = null
  let temporarySeq = 0
  let conversations: ConversationInfo[] = []
  /** 假数据里被删掉的会话 —— FAKE_CONVERSATIONS 是静态的，删完要记住 */
  const removedConversations = new Set<string>()
  /** 假数据里改过的名字 —— 没改过的用静态标题 */
  const renamedConversations = new Map<string, string>()
  /** 假数据里「用户选中的项目」 */
  let projects: ProjectInfo[] = FAKE_PROJECTS.map((p) => ({ ...p }))
  /** 假宿主的文件标签 */
  let files: FileTab[] = []
  let activeFileId: string | null = null
  let fileSeq = 0
  let seq = 0

  const snapshotListeners = new Set<(snapshot: HostSnapshot) => void>()
  const eventListeners = new Set<(events: SessionEvent[]) => void>()
  /** 收到中止请求的标签 —— prompt 的循环靠它提前退出 */
  const aborted = new Set<string>()
  /** 正在中止的标签 —— 快照里暴露出去，界面靠它显示「停止中」 */
  const abortingTabs = new Set<string>()

  function addTab(options: { cwd: string; path?: string; title?: string; items?: StreamItem[] }): FakeTab {
    seq += 1
    const tab: FakeTab = {
      id: `t${seq}`,
      cwd: options.cwd,
      path: options.path ?? null,
      title: options.title ?? '新对话',
      items: options.items ?? [],
      model: FAKE_MODELS[0],
      thinkingLevel: 'medium',
      streaming: false
    }
    tabs.push(tab)
    activeTabId = tab.id
    return tab
  }

  function snapshot(): HostSnapshot {
    const active = tabs.find((t) => t.id === activeTabId)
    return {
      tabs: tabs.map((tab) => ({
        id: tab.id,
        sessionId: `s-${tab.id}`,
        path: tab.path,
        cwd: tab.cwd,
        title: tab.title,
        projectName: basenameOf(tab.cwd),
        streaming: tab.streaming,
        ready: true,
        removed: !projects.some((p) => p.path === tab.cwd),
        stale: false,
        model: tab.model,
        modelFallback: null,
        error: null
      })),
      activeTabId,
      projects,
      conversations,
      refreshing: false,
      aborting: [...abortingTabs],
      files: files,
      activeFileId: activeFileId,
      extensionErrors: [],
      temporaryChat: temporary ? { ...temporary, error: null } : null,
      contextDiff: FAKE_CONTEXT_DIFF,
      session: {
        ready: Boolean(active),
        cwd: active?.cwd ?? null,
        sessionId: active ? `s-${active.id}` : null,
        model: active?.model ?? null,
        thinkingLevel: active?.thinkingLevel ?? null,
        modelFallback: null,
        error: null
      }
    }
  }

  function publish(): HostSnapshot {
    const value = snapshot()
    for (const listener of snapshotListeners) listener(value)
    return value
  }

  /** 事件带着 tabId —— 渲染进程按它分发到各自的内容流（D4 修订） */
  function publishEvent(tabId: string, type: string, data: unknown): void {
    const events: SessionEvent[] = [{ type, data, at: Date.now(), tabId }]
    for (const listener of eventListeners) listener(events)
  }

  /** 假数据里这些项目的会话 */
  function allConversations(): ConversationInfo[] {
    return projects.flatMap((project) =>
      (FAKE_CONVERSATIONS[project.path] ?? [])
        .filter((c) => !removedConversations.has(c.path))
        .map((c) => {
          const renamed = renamedConversations.get(c.path)
          if (!renamed) return c
          // 跟宿主一样：显示标题截到 60 字，自定义名保留原文
          return { ...c, name: renamed, title: renamed.length > 60 ? `${renamed.slice(0, 60)}…` : renamed }
        })
    )
  }

  // 开场就有一个标签
  conversations = allConversations()
  addTab({
    cwd: FAKE_PROJECTS[0].path,
    path: FAKE_CONVERSATIONS[FAKE_PROJECTS[0].path][0]?.path ?? null,
    title: FAKE_CONVERSATIONS[FAKE_PROJECTS[0].path][0]?.title ?? '记忆索引重构',
    items: [...FAKE_ITEMS]
  })

  return {
    platform: 'browser',

    getSnapshot: async () => snapshot(),

    openProject: async () => {
      const project = FAKE_PROJECTS[tabs.length % FAKE_PROJECTS.length]
      if (!projects.some((p) => p.path === project.path)) {
        projects = [project, ...projects]
      }
      // 加了项目要重读会话 —— 会话清单只列清单里的项目
      conversations = allConversations()
      addTab({ cwd: project.path, title: '新对话' })
      return publish()
    },

    removeProject: async (path) => {
      // 只是从清单里移除 —— 对话数据不动
      projects = projects.filter((p) => p.path !== path)
      conversations = allConversations()
      return publish()
    },

    deleteConversations: async (paths) => {
      const deleted = paths.filter((path) => conversations.some((c) => c.path === path))
      const wanted = new Set(deleted)
      for (const path of deleted) removedConversations.add(path)
      conversations = allConversations()

      // 关掉引用这些会话的标签
      for (const path of deleted) {
        let index = tabs.findIndex((t) => t.path === path)
        while (index >= 0) {
          const wasActive = activeTabId === tabs[index].id
          // 让还在跑的假回复下一段自己退出
          aborted.add(tabs[index].id)
          tabs.splice(index, 1)
          if (wasActive) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null
          index = tabs.findIndex((t) => t.path === path)
        }
      }

      // 同路径的文件标签也一起关
      for (const file of files.filter((f) => wanted.has(f.path))) {
        const index = files.findIndex((f) => f.id === file.id)
        if (index < 0) continue
        files.splice(index, 1)
        if (activeFileId === file.id) activeFileId = files[Math.min(index, files.length - 1)]?.id ?? null
      }

      publish()
      return { deleted, failed: [] }
    },

    renameConversation: async (path, name) => {
      if (!conversations.some((c) => c.path === path)) {
        throw new Error(`不在当前对话列表里：${path}`)
      }
      const next = name.trim()
      if (next) renamedConversations.set(path, next)
      else renamedConversations.delete(path)
      conversations = allConversations()
      const updated = conversations.find((c) => c.path === path)
      const tab = tabs.find((t) => t.path === path)
      if (updated && tab) tab.title = updated.title
      return publish()
    },

    openConversation: async (path, cwd) => {
      const found = conversations.find((c) => c.path === path)
      // 已经在标签栏里开着 → 切过去，不重复开
      const existing = tabs.find((t) => t.path === path)
      if (existing) {
        activeTabId = existing.id
        return publish()
      }
      addTab({ cwd, path, title: found?.title ?? '对话', items: [...FAKE_ITEMS] })
      return publish()
    },

    newConversation: async (cwd) => {
      if (!projects.some((p) => p.path === cwd)) {
        projects = [{ path: cwd, name: basenameOf(cwd) }, ...projects]
      }
      addTab({ cwd, title: '新对话' })
      return publish()
    },

    activateTab: async (tabId) => {
      if (tabs.some((t) => t.id === tabId)) activeTabId = tabId
      return publish()
    },

    reloadTab: async (tabId) => {
      // 假宿主里没有「外部修改」，重载就等于重读自己的条目
      const tab = tabs.find((t) => t.id === tabId)
      if (tab) tab.items = [...FAKE_ITEMS]
      return publish()
    },

    closeTab: async (tabId) => {
      const index = tabs.findIndex((t) => t.id === tabId)
      if (index < 0) return publish()
      tabs.splice(index, 1)
      if (activeTabId === tabId) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null
      return publish()
    },

    getTabEntries: async (tabId) => tabs.find((t) => t.id === tabId)?.items ?? [],

    listFiles: async (_cwd, dir) => {
      const rel = dir === '' || dir === '.' ? '' : dir.replace(/^\.\//, '')
      return FAKE_TREE[rel] ?? []
    },

    readFile: async (_cwd, path) => {
      const rel = path.replace(/^.*?\/src\//, 'src/').replace(/^.*\/(?=[^/]+$)/, (m) => (path.includes('/src/') ? '' : m))
      const key = rel.replace(/^\/+/, '')
      const text = FAKE_FILES[key] ?? FAKE_FILES[path.split('/').pop() ?? ''] ?? ''
      if (!text) {
        return { kind: 'unsupported', reason: '假数据里没有这个文件的内容' }
      }
      return {
        kind: 'text',
        text,
        lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
        binary: false,
        tooLarge: false,
        size: text.length
      }
    },

    openFile: async (cwd, path) => {
      const existing = files.find((f) => f.path === path)
      if (existing) {
        activeFileId = existing.id
        return publish()
      }
      fileSeq += 1
      const name = path.split('/').slice(-1)[0] ?? path
      files = [...files, { id: `file-${fileSeq}`, path, cwd, relPath: name }]
      activeFileId = `file-${fileSeq}`
      return publish()
    },

    closeFile: async (fileId) => {
      files = files.filter((f) => f.id !== fileId)
      if (activeFileId === fileId) activeFileId = files[files.length - 1]?.id ?? null
      return publish()
    },

    activateFile: async (fileId) => {
      if (files.some((f) => f.id === fileId)) activeFileId = fileId
      return publish()
    },

    openFileExternal: async () => {
      // 浏览器预览里没有系统程序可开
    },

    reloadFile: async () => publish(),

    listModels: async () => FAKE_MODELS,

    compactTab: async () => {
      // 假宿主里压缩就是等一下
      await new Promise((resolve) => setTimeout(resolve, 500))
    },

    listCommands: async () => FAKE_COMMANDS,

    completeCommand: async (_tabId, name, prefix) => {
      if (name !== 'deploy') return []
      return ['staging', 'production']
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }))
    },

    listThinkingLevels: async () => ['off', 'low', 'medium', 'high', 'xhigh'],

    selectThinkingLevel: async (tabId, level) => {
      const tab = tabs.find((item) => item.id === tabId)
      if (tab) tab.thinkingLevel = level as ThinkingLevel
      publish()
    },

    dismissExtensionErrors: async () => publish(),

    cancelFileSearch: async () => {},

    pickAttachments: async () => {
      // 浏览器预览没有 Electron 的 dialog，用隐藏的 <input type=file> 演示 chip
      if (typeof document === 'undefined') return { attachments: [], errors: [] }
      const files = await new Promise<File[]>((resolve) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.onchange = () => resolve([...(input.files ?? [])])
        input.oncancel = () => resolve([])
        input.click()
      })
      return {
        attachments: files.map((file, index) => {
          const image = file.type.startsWith('image/')
          return {
            id: `preview-${Date.now()}-${index}`,
            name: file.name,
            kind: image ? 'image' : 'text',
            size: file.size,
            tokens: image ? 1200 : Math.ceil(file.size / 4) + 8
          }
        }),
        errors: []
      }
    },

    getContextDiff: async () => FAKE_CONTEXT_DIFF,
    getContextDiffForTurn: async () => FAKE_CONTEXT_DIFF,
    listContextDiffSessions: async () => FAKE_CONTEXT_SESSIONS,
    listContextDiffSnapshots: async () => [FAKE_CONTEXT_BASELINE, FAKE_CONTEXT_CURRENT],
    getContextDiffDetail: async (_tabId, _snapshotId, key) => {
      const message = FAKE_CONTEXT_DIFF.groups
        .flatMap((group) => group.messages)
        .find((item) => item.key === key)
      return message ? { text: message.preview, truncated: false } : null
    },

    openTemporaryChat: async () => {
      if (!temporary) {
        const active = tabs.find((tab) => tab.id === activeTabId)
        temporary = {
          id: `temp-preview-${++temporarySeq}`,
          cwd: active?.cwd ?? FAKE_PROJECTS[0].path,
          model: active?.model ?? FAKE_MODELS[0] ?? null,
          streaming: false
        }
      }
      return publish()
    },

    closeTemporaryChat: async () => {
      temporary = null
      return publish()
    },

    promptTemporary: async (id, text) => {
      if (!temporary || temporary.id !== id) return
      temporary.streaming = true
      publish()
      publishEvent(id, 'agent_start', {})
      publishEvent(id, 'message_start', { message: { role: 'user', content: text } })
      publishEvent(id, 'message_end', { message: { role: 'user', content: text } })
      window.setTimeout(() => {
        if (!temporary || temporary.id !== id) return
        publishEvent(id, 'message_start', { message: { role: 'assistant', content: [] } })
        publishEvent(id, 'message_update', {
          type: 'text_delta',
          contentIndex: 0,
          delta: '这是浏览器预览里的临时对话回复。'
        })
        publishEvent(id, 'message_end', {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '这是浏览器预览里的临时对话回复。' }]
          }
        })
        temporary.streaming = false
        publishEvent(id, 'agent_settled', {})
        publish()
      }, 500)
    },

    abortTemporary: async (id) => {
      if (!temporary || temporary.id !== id) return
      temporary.streaming = false
      publishEvent(id, 'agent_settled', { aborted: true })
      publish()
    },

    listTemporaryModels: async () => FAKE_MODELS,

    selectTemporaryModel: async (id, provider, modelId) => {
      if (!temporary || temporary.id !== id) return publish()
      const found = FAKE_MODELS.find((model) => model.provider === provider && model.id === modelId)
      if (found) temporary.model = found
      return publish()
    },

    searchFiles: async (_cwd, query, limit) => {
      const q = query.trim().toLowerCase()
      const matched = q
        ? FAKE_SEARCH_PATHS.filter((item) => item.path.toLowerCase().includes(q))
        : FAKE_SEARCH_PATHS.filter((item) => !item.path.includes('/'))
      return matched.slice(0, limit).map((item) => ({ ...item }))
    },

    selectModel: async (tabId, provider, id) => {
      const found = FAKE_MODELS.find((m) => m.provider === provider && m.id === id)
      if (!found) throw new Error(`模型不存在：${provider}/${id}`)
      const tab = tabs.find((t) => t.id === tabId)
      if (tab) tab.model = found
      publish()
    },

    copyText: async (text: string) => {
      // 浏览器预览里没有系统剪贴板权限时也别报错
      if (!navigator.clipboard) return
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // 忽略：预览环境不保证剪贴板可用
      }
    },

    abortPrompt: async (tabId) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab || !tab.streaming) return
      // 设个标志，正在跑的那个循环下一段就会自己退出，由它发收尾事件
      aborted.add(tabId)
      /*
       * 先把自己记进 aborting 再推快照 —— 界面靠这个显示「停止中」。
       * 真宿主也是这个顺序（state.abortPrompt 里先 add 再 emit）。
       */
      abortingTabs.add(tabId)
      publish()
      // 等一下，模拟 abort() 内部的 waitForIdle()
      await new Promise((r) => setTimeout(r, 260))
      abortingTabs.delete(tabId)
      publish()
    },

    prompt: async (tabId, text) => {
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return

      // 假扩展命令：流式期间也能执行，只发一条 custom 消息，不启动新的一轮
      if (text.trimStart().startsWith('/deploy')) {
        const message = {
          role: 'custom',
          customType: 'deploy',
          display: true,
          content: '部署已触发（浏览器预览假数据）',
          timestamp: Date.now()
        }
        publishEvent(tabId, 'message_start', { message })
        publishEvent(tabId, 'message_end', { message })
        return
      }

      tab.streaming = true
      /*
       * 跟 Pi 一样的顺序：agent_start 在最前（runAgentLoop 开头就发），
       * 然后才是用户消息。中间那段是等首 token —— 真 Pi 这里是
       * `await streamFunction(...)`，几秒钟；这里用 700ms 模拟。
       */
      publishEvent(tabId, 'agent_start', {})
      publishEvent(tabId, 'message_start', { message: { role: 'user', content: text } })
      publishEvent(tabId, 'message_end', { message: { role: 'user', content: text } })

      /*
       * TTFT：真实里这段时间界面上什么新内容都没有，只有「在跑」的指示。
       * 切成小段轮询而不是一次 sleep 700ms —— 不然这段里按 Esc 停不下来，
       * 真 Pi 的 abort() 是能打断等首 token 的。
       */
      for (let i = 0; i < 7 && !aborted.has(tabId); i += 1) {
        await new Promise((r) => setTimeout(r, 100))
      }
      if (aborted.delete(tabId)) {
        tab.streaming = false
        /*
         * 真 Pi 在首 token 前被中止也会产生一条消息：`streamAssistantResponse`
         * 结尾是 `await result()` 然后无条件发 message_start + message_end，
         * 哪怕流一个字都没吐。内容为空、stopReason 是 aborted。
         *
         * 这条空消息到渲染层会被丢掉（没有正文、没有工具调用就没有 item），
         * 所以界面上不会出现「已中止」—— 那是「一个字都没生成」时的必然结果，
         * 不是漏了。
         */
        publishEvent(tabId, 'message_start', { message: { role: 'assistant', content: [] } })
        publishEvent(tabId, 'message_end', {
          message: {
            role: 'assistant',
            content: [],
            stopReason: 'aborted',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            durationMs: 0,
            timestamp: Date.now()
          }
        })
        publishEvent(tabId, 'agent_settled', { aborted: true })
        return
      }

      const startedAt = Date.now()
      publishEvent(tabId, 'message_start', {
        message: {
          role: 'assistant',
          content: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          timestamp: startedAt
        }
      })
      // 一段段吐出来，中间留出空隙 —— 不然浏览器预览里根本来不及点「停止」
      for (const chunk of FAKE_REPLY) {
        if (aborted.has(tabId)) break
        publishEvent(tabId, 'message_update', { type: 'text_delta', contentIndex: 0, delta: chunk })
        await new Promise((r) => setTimeout(r, 140))
      }

      /*
       * 被中止：照 Pi 的行为来 —— 已经生成的部分算一条 stopReason 为 aborted
       * 的助手消息（真 Pi 也会把它写进会话文件），然后发 agent_settled。
       */
      if (aborted.delete(tabId)) {
        tab.streaming = false
        publishEvent(tabId, 'message_end', {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: FAKE_REPLY.slice(0, 3).join('') }],
            stopReason: 'aborted',
            usage: { input: 6214, output: 128, cacheRead: 0, cacheWrite: 0 },
            durationMs: 1200,
            timestamp: startedAt
          }
        })
        publishEvent(tabId, 'agent_settled', { aborted: true })
        return
      }
      publishEvent(tabId, 'message_end', {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: FAKE_REPLY.join('') },
            { type: 'toolCall', id: 'm1', name: 'bash', arguments: { command: 'npm test -- --run' } }
          ],
          usage: { input: 6214, output: 601, cacheRead: 189, cacheWrite: 0 },
          durationMs: 4044,
          timestamp: startedAt
        }
      })

      // 工具跑起来：输出边跑边出来（R4）
      publishEvent(tabId, 'tool_execution_start', { toolCallId: 'm1', toolName: 'bash' })
      let acc = ''
      for (const line of FAKE_TOOL_LINES) {
        acc += line
        publishEvent(tabId, 'tool_execution_update', {
          toolCallId: 'm1',
          toolName: 'bash',
          partialResult: { content: [{ type: 'text', text: acc }] }
        })
      }
      publishEvent(tabId, 'tool_execution_end', { toolCallId: 'm1', toolName: 'bash', isError: false })
      publishEvent(tabId, 'message_start', {
        message: { role: 'toolResult', toolCallId: 'm1', content: [{ type: 'text', text: acc }] }
      })
      publishEvent(tabId, 'message_end', {
        message: { role: 'toolResult', toolCallId: 'm1', content: [{ type: 'text', text: acc }] }
      })

      // 一轮结束 —— 真的 Pi 会发这个。不发的话预览里 streaming 永远为真，
      // 元信息行会停在跳动的计时器上、复制按钮一直禁用。
      tab.streaming = false
      publishEvent(tabId, 'agent_settled', { aborted: false })
    },

    onSnapshot: (listener) => {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },

    onSessionEvent: (listener) => {
      eventListeners.add(listener)
      return () => eventListeners.delete(listener)
    }
  }
}

/** 目录名 —— 标签要能看出属于哪个项目 */
function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || path
}
