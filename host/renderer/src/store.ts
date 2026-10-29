import { create } from 'zustand'
import type {
  ConversationMode,
  HostSnapshot,
  ModelOption,
  NavEntry,
  SessionEvent,
  StreamItem
} from '@contract/index'
import { applyEvent } from '@contract/stream'
import { host } from './host'

export type Theme = 'light' | 'dark'

const EMPTY_SNAPSHOT: HostSnapshot = {
  projects: [],
  currentProject: null,
  conversations: [],
  session: {
    ready: false,
    cwd: null,
    sessionId: null,
    model: null,
    modelFallback: null,
    error: null
  }
}

const THEME_KEY = 'codelet:theme'

/** 默认亮色；记不住就用亮色 */
function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // 存不下就算了
  }
}

const MODE_KEY = 'codelet:conversation-mode'

const INSPECTOR_KEY = 'codelet:inspector-open'

const SIDEBAR_KEY = 'codelet:sidebar-open'

/** 右侧检视器默认展开 */
function loadInspectorOpen(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_KEY) !== '0'
  } catch {
    return true
  }
}

function saveInspectorOpen(open: boolean): void {
  try {
    localStorage.setItem(INSPECTOR_KEY, open ? '1' : '0')
  } catch {
    // 存不下就算了
  }
}

/** 左侧栏默认展开 */
function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== '0'
  } catch {
    return true
  }
}

function saveSidebarOpen(open: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0')
  } catch {
    // 存不下就算了
  }
}

type ModeMap = Record<string, ConversationMode>

function loadModes(): ModeMap {
  try {
    const raw = localStorage.getItem(MODE_KEY)
    const parsed = raw ? (JSON.parse(raw) as ModeMap) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveModes(modes: ModeMap): void {
  try {
    localStorage.setItem(MODE_KEY, JSON.stringify(modes))
  } catch {
    // 存不下就算了，不影响使用
  }
}

interface RendererStore {
  snapshot: HostSnapshot
  /** 导航轨当前入口 */
  nav: NavEntry
  /** 对话区当前排版模式（PLAN.md D10） */
  mode: ConversationMode
  /** 亮 / 暗，默认亮色 */
  theme: Theme
  /** 会话流事件计数 —— 骨架阶段先只记账，不渲染 */
  eventCount: number
  /** 对话区的内容流 —— 两种排版读的是同一个数组（R3） */
  items: StreamItem[]
  /** 助手正在回话（R2 —— 末尾跟一个光标） */
  streaming: boolean
  /** 工具输出哪些是展开的（callId → 展开与否）。默认收起来，点开才看。 */
  expandedTools: Record<string, boolean>
  /** 右侧检视器是否展开 */
  inspectorOpen: boolean
  /** 左侧栏是否展开 */
  sidebarOpen: boolean
  /** 模型选择器的锚点（null = 关着）。position: fixed 用，贴着触发它的控件上方 */
  modelPickerAnchor: { left: number; bottom: number } | null
  /** 已配置凭据的模型清单（打开选择器时拉一次） */
  models: ModelOption[]
  /** 模型清单拉取中的提示 */
  modelsLoading: boolean
  /** 模型清单拉取失败的原因 */
  modelsError: string | null

  setSnapshot: (snapshot: HostSnapshot) => void
  setNav: (nav: NavEntry) => void
  setMode: (mode: ConversationMode) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  /** 展开 / 收起右侧检视器 */
  toggleInspector: () => void
  /** 展开 / 收起左侧栏 */
  toggleSidebar: () => void
  bumpEvents: (count: number) => void
  /** 换会话时整体替换内容流（R5） */
  setItems: (items: StreamItem[]) => void
  /** 把实时事件落到内容流上（R2） */
  applySessionEvents: (events: SessionEvent[]) => void
  /** 展开 / 收起某个工具的输出 */
  setToolExpanded: (callId: string, expanded: boolean) => void
  /** 打开模型选择器（锚点是触发控件的视口坐标） */
  openModelPicker: (anchor: { left: number; bottom: number }) => void
  /** 关掉模型选择器 */
  closeModelPicker: () => void
  /** 拉模型清单 */
  loadModels: () => Promise<void>
  /** 切当前会话的模型（persist 时同时设为新会话默认） */
  selectModel: (provider: string, id: string, persist: boolean) => Promise<void>
}

export const useStore = create<RendererStore>((set, get) => ({
  snapshot: EMPTY_SNAPSHOT,
  nav: 'session',
  mode: 'normal',
  theme: loadTheme(),
  eventCount: 0,
  items: [],
  streaming: false,
  expandedTools: {},
  inspectorOpen: loadInspectorOpen(),
  sidebarOpen: loadSidebarOpen(),
  modelPickerAnchor: null,
  models: [],
  modelsLoading: false,
  modelsError: null,

  setSnapshot: (snapshot) => {
    const previousSessionId = get().snapshot.session.sessionId
    const nextSessionId = snapshot.session.sessionId
    if (previousSessionId === nextSessionId) {
      set({ snapshot })
      return
    }
    // 换会话：把该会话上次的排版模式取回来（模式记在会话状态里）
    const modes = loadModes()
    const mode = (nextSessionId && modes[nextSessionId]) || 'normal'
    set({ snapshot, mode })
  },

  setNav: (nav) => set({ nav }),

  // 换会话：内容流和展开状态一起换
  setItems: (items) => set({ items, streaming: false, expandedTools: {} }),

  setToolExpanded: (callId, expanded) =>
    set((state) => ({ expandedTools: { ...state.expandedTools, [callId]: expanded } })),

  applySessionEvents: (events) => {
    if (events.length === 0) return
    let items = get().items
    let streaming = get().streaming
    for (const event of events) {
      items = applyEvent(items, event)
      if (event.type === 'agent_settled') streaming = false
      if (event.type === 'message_start') {
        const role = (event.data as { message?: { role?: string } } | undefined)?.message?.role
        if (role === 'assistant') streaming = true
      }
    }
    set({ items, streaming, eventCount: get().eventCount + events.length })
  },

  setMode: (mode) => {
    const sessionId = get().snapshot.session.sessionId
    const modes = loadModes()
    if (sessionId) {
      modes[sessionId] = mode
      saveModes(modes)
    }
    set({ mode })
  },

  bumpEvents: (count) => set((state) => ({ eventCount: state.eventCount + count })),

  setTheme: (theme) => {
    saveTheme(theme)
    set({ theme })
  },

  toggleTheme: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    saveTheme(next)
    set({ theme: next })
  },

  toggleInspector: () => {
    const next = !get().inspectorOpen
    saveInspectorOpen(next)
    set({ inspectorOpen: next })
  },

  toggleSidebar: () => {
    const next = !get().sidebarOpen
    saveSidebarOpen(next)
    set({ sidebarOpen: next })
  },

  openModelPicker: (anchor) => {
    set({ modelPickerAnchor: anchor })
    void get().loadModels()
  },

  closeModelPicker: () => set({ modelPickerAnchor: null }),

  loadModels: async () => {
    set({ modelsLoading: true, modelsError: null })
    try {
      const models = await host.listModels()
      set({ models, modelsLoading: false })
    } catch (error) {
      set({
        models: [],
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  selectModel: async (provider, id, persist) => {
    // 主进程切完之后会推新快照，session.model 从那一路回来
    await host.selectModel(provider, id, persist)
  }
}))
