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
  tabs: [],
  activeTabId: null,
  projects: [],
  conversations: [],
  refreshing: false,
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
  /**
   * 右侧面板当前显示哪个视图。
   *
   * 主区不看这个值，它永远是对话。
   * 一次只显示一个 —— 右侧面板里没有常驻内容。
   */
  nav: NavEntry
  /** 对话区当前排版模式（PLAN.md D10） */
  mode: ConversationMode
  /** 亮 / 暗，默认亮色 */
  theme: Theme
  /** 会话流事件计数 —— 骨架阶段先只记账，不渲染 */
  eventCount: number
  /**
   * 对话区的内容流 —— **按标签存**（PLAN.md D4 修订）。
   *
   * 多标签之后每个标签有自己的内容流：后台标签正在流式输出，事件得有地方堆着。
   * 两种排版读的是同一个数组（R3）。
   */
  items: Record<string, StreamItem[]>
  /** 助手正在回话（R2 —— 末尾跟一个光标），按标签存 */
  streaming: Record<string, boolean>
  /** 工具输出哪些是展开的（callId → 展开与否）。默认收起来，点开才看。按标签存 */
  expandedTools: Record<string, Record<string, boolean>>
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
  /** 换会话时整体替换内容流（R5）—— 按标签存 */
  setItems: (tabId: string, items: StreamItem[]) => void
  /**
   * 重新加载某个标签：重建 runtime 并把内容流也重读一遍。
   *
   * 两件事必须一起做 —— 只重建 runtime 的话，runtime 是新的、屏幕还是旧的。
   */
  reloadTab: (tabId: string) => Promise<void>
  /** 把实时事件落到内容流上（R2） */
  applySessionEvents: (events: SessionEvent[]) => void
  /** 展开 / 收起某个工具的输出 */
  setToolExpanded: (tabId: string, callId: string, expanded: boolean) => void
  /** 打开模型选择器（锚点是触发控件的视口坐标） */
  openModelPicker: (anchor: { left: number; bottom: number }) => void
  /** 关掉模型选择器 */
  closeModelPicker: () => void
  /** 拉模型清单 */
  loadModels: (tabId: string) => Promise<void>
  /** 切某个标签的模型（persist 时同时设为新会话默认） */
  selectModel: (tabId: string, provider: string, id: string, persist: boolean) => Promise<void>
}

export const useStore = create<RendererStore>((set, get) => ({
  snapshot: EMPTY_SNAPSHOT,
  nav: 'board',
  mode: 'normal',
  theme: loadTheme(),
  eventCount: 0,
  items: {},
  streaming: {},
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

  reloadTab: async (tabId) => {
    await host.reloadTab(tabId)
    // 重建完 runtime 再从磁盘读一遍内容流 —— 少了这一步，屏幕还是旧的
    get().setItems(tabId, await host.getTabEntries(tabId))
  },

  // 换会话：内容流和展开状态一起换（按标签存）
  setItems: (tabId, items) =>
    set((state) => ({
      items: { ...state.items, [tabId]: items },
      streaming: { ...state.streaming, [tabId]: false },
      expandedTools: { ...state.expandedTools, [tabId]: {} }
    })),

  setToolExpanded: (tabId, callId, expanded) =>
    set((state) => ({
      expandedTools: {
        ...state.expandedTools,
        [tabId]: { ...(state.expandedTools[tabId] ?? {}), [callId]: expanded }
      }
    })),

  applySessionEvents: (events) => {
    if (events.length === 0) return
    // 事件带着标签 id —— 按它分发到各自的内容流（后台标签也在流）
    const byTab = new Map<string, SessionEvent[]>()
    for (const event of events) {
      const bucket = byTab.get(event.tabId)
      if (bucket) bucket.push(event)
      else byTab.set(event.tabId, [event])
    }
    const items = { ...get().items }
    const streaming = { ...get().streaming }
    for (const [tabId, list] of byTab) {
      let tabItems = items[tabId] ?? []
      let tabStreaming = streaming[tabId] ?? false
      for (const event of list) {
        tabItems = applyEvent(tabItems, event)
        if (event.type === 'agent_settled') tabStreaming = false
        if (event.type === 'message_start') {
          const role = (event.data as { message?: { role?: string } } | undefined)?.message?.role
          if (role === 'assistant') tabStreaming = true
        }
      }
      items[tabId] = tabItems
      streaming[tabId] = tabStreaming
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
    const tabId = get().snapshot.activeTabId
    if (tabId) void get().loadModels(tabId)
  },

  closeModelPicker: () => set({ modelPickerAnchor: null }),

  loadModels: async (tabId) => {
    set({ modelsLoading: true, modelsError: null })
    try {
      const models = await host.listModels(tabId)
      set({ models, modelsLoading: false })
    } catch (error) {
      set({
        models: [],
        modelsLoading: false,
        modelsError: error instanceof Error ? error.message : String(error)
      })
    }
  },

  selectModel: async (tabId, provider, id, persist) => {
    // 主进程切完之后会推新快照，session.model 从那一路回来
    await host.selectModel(tabId, provider, id, persist)
  }
}))
