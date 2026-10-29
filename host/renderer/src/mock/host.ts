import type {
  CodeletApi,
  ConversationInfo,
  HostSnapshot,
  ProjectInfo,
  SessionEvent,
  StreamItem
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
      modified: new Date().toISOString(),
      messageCount: 24,
      cwd: '/Users/demo/Projects/codelet'
    },
    {
      id: 'c2',
      path: '/fake/codelet/2.jsonl',
      title: '类型声明生成',
      modified: new Date(Date.now() - 18 * 60_000).toISOString(),
      messageCount: 9,
      cwd: '/Users/demo/Projects/codelet'
    },
    {
      id: 'c3',
      path: '/fake/codelet/3.jsonl',
      title: '扫描依赖关系',
      modified: new Date(Date.now() - 26 * 3600_000).toISOString(),
      messageCount: 51,
      cwd: '/Users/demo/Projects/codelet'
    }
  ],
  '/Users/demo/Projects/pi-sdk': [],
  '/Users/demo/Projects/web': []
}

/** 假的内容流：够看出普通模式长什么样 */
const FAKE_ITEMS: StreamItem[] = [
  { kind: 'message', role: 'user', text: '把记忆索引改成增量更新，顺便把 `tokens.ts` 的导出整理一下。' },
  {
    kind: 'message',
    role: 'assistant',
    text: '好的。我先读了现有的索引实现，索引写入是全量重建，在 12k 条记忆上约 1.8s。'
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
    text: '已改为按 updatedAt 游标增量更新，并补上 3 个用例。测试全绿（42 passed / 42）。'
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
  let currentProject: ProjectInfo = FAKE_PROJECTS[0]
  let conversations: ConversationInfo[] = FAKE_CONVERSATIONS[currentProject.path] ?? []
  let sessionId: string | null = conversations[0]?.id ?? null
  const snapshotListeners = new Set<(snapshot: HostSnapshot) => void>()
  const eventListeners = new Set<(events: SessionEvent[]) => void>()
  let fakeItems: StreamItem[] = [...FAKE_ITEMS]

  function snapshot(): HostSnapshot {
    return {
      projects: FAKE_PROJECTS,
      currentProject,
      conversations,
      session: {
        ready: true,
        cwd: currentProject.path,
        sessionId,
        error: null
      }
    }
  }

  function publish(): HostSnapshot {
    const value = snapshot()
    for (const listener of snapshotListeners) listener(value)
    return value
  }

  function publishEvent(type: string, data: unknown): void {
    const events: SessionEvent[] = [{ type, data, at: Date.now() }]
    for (const listener of eventListeners) listener(events)
  }

  return {
    platform: 'browser',

    getSnapshot: async () => snapshot(),

    openProject: async () => publish(),

    switchProject: async (path) => {
      const found = FAKE_PROJECTS.find((p) => p.path === path)
      if (found) currentProject = found
      conversations = FAKE_CONVERSATIONS[currentProject.path] ?? []
      sessionId = conversations[0]?.id ?? null
      return publish()
    },

    newConversation: async () => {
      const fresh: ConversationInfo = {
        id: `c${Date.now()}`,
        path: `/fake/${currentProject.name}/${Date.now()}.jsonl`,
        title: '新对话',
        modified: new Date().toISOString(),
        messageCount: 0,
        cwd: currentProject.path
      }
      conversations = [fresh, ...conversations]
      sessionId = fresh.id
      fakeItems = []
      return publish()
    },

    switchConversation: async (path) => {
      const found = conversations.find((c) => c.path === path)
      if (found) sessionId = found.id
      fakeItems = [...FAKE_ITEMS]
      return publish()
    },

    getSessionEntries: async () => fakeItems,

    prompt: async (text) => {
      // 假的一次回复：用户消息 → 助手消息一点点长出来
      publishEvent('message_start', { message: { role: 'user', content: text } })
      publishEvent('message_end', { message: { role: 'user', content: text } })
      publishEvent('message_start', { message: { role: 'assistant', content: [] } })
      for (const chunk of FAKE_REPLY) {
        publishEvent('message_update', { type: 'text_delta', contentIndex: 0, delta: chunk })
      }
      publishEvent('message_end', {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: FAKE_REPLY.join('') },
            { type: 'toolCall', id: 'm1', name: 'bash', arguments: { command: 'npm test -- --run' } }
          ]
        }
      })

      // 工具跑起来：输出边跑边出来（R4）
      publishEvent('tool_execution_start', { toolCallId: 'm1', toolName: 'bash' })
      let acc = ''
      for (const line of FAKE_TOOL_LINES) {
        acc += line
        publishEvent('tool_execution_update', {
          toolCallId: 'm1',
          toolName: 'bash',
          partialResult: { content: [{ type: 'text', text: acc }] }
        })
      }
      publishEvent('tool_execution_end', { toolCallId: 'm1', toolName: 'bash', isError: false })
      publishEvent('message_start', {
        message: { role: 'toolResult', toolCallId: 'm1', content: [{ type: 'text', text: acc }] }
      })
      publishEvent('message_end', {
        message: { role: 'toolResult', toolCallId: 'm1', content: [{ type: 'text', text: acc }] }
      })
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
