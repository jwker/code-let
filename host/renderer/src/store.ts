import { create } from 'zustand'
import type {
  AnnotationState,
  BlockCitation,
  ConversationMode,
  DocEntry,
  DocGroup,
  GitDiff,
  GitDiffScope,
  GitStatus,
  HostSnapshot,
  FileContent,
  FileEntry,
  ModelOption,
  ProjectPane,
  SessionEvent,
  StreamItem
} from '@contract/index'
import { blockKey } from '@contract/index'
import { applyEvent, nextStreaming } from '@contract/stream'
import { host } from './host'

export type Theme = 'light' | 'dark'

const EMPTY_SNAPSHOT: HostSnapshot = {
  activeAgentId: null,
  projectTabs: [],
  activeProjectTabId: null,
  agents: [],
  projects: [],
  conversations: [],
  refreshing: false,
  aborting: [],
  files: [],
  activeFileId: null,
  extensionErrors: [],
  temporaryChat: null,
  session: {
    ready: false,
    cwd: null,
    sessionId: null,
    model: null,
    thinkingLevel: null,
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

const TREE_KEY = 'codelet:tree-expanded'

/**
 * 各项目展开的目录 —— 落 localStorage（PLAN.md D21：纯 UI 状态，不进宿主）。
 *
 * 存的是 `{ [cwd]: [展开的目录相对路径] }`。一个项目的目录再多也就几百条，
 * 单条路径一百来字节，离 localStorage 的额度还很远。
 */
function loadTreeExpanded(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TREE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, string[]> = {}
    for (const [cwd, dirs] of Object.entries(parsed)) {
      if (Array.isArray(dirs)) out[cwd] = dirs.filter((d): d is string => typeof d === 'string')
    }
    return out
  } catch {
    return {}
  }
}

function saveTreeExpanded(value: Record<string, string[]>): void {
  try {
    localStorage.setItem(TREE_KEY, JSON.stringify(value))
  } catch {
    // 存不下就算了
  }
}

const MODE_KEY = 'codelet:conversation-mode'

const PANE_KEY = 'codelet:pane'
const ZONE5_KEY = 'codelet:zone5-widths'


/** 代码区的两个 tab */
export type CodeMode = 'files' | 'changes'

/** Git 改动在渲染层的样子：区域 5 用列表、区域 6 用 diff */
export interface GitViewState {
  status: GitStatus | null
  loading: boolean
  error: string | null
  /** 当前选中的改动（路径 + 分组） */
  selected: { path: string; scope: GitDiffScope } | null
  diff: GitDiff | null
  diffLoading: boolean
  diffError: string | null
}

const EMPTY_GIT: GitViewState = {
  status: null,
  loading: false,
  error: null,
  selected: null,
  diff: null,
  diffLoading: false,
  diffError: null
}

/** 请求序号：后发的覆盖先发的，切项目时不会串 */
let gitSeq = 0
let diffSeq = 0
let docsSeq = 0
let docSeq = 0

/** 文档区在渲染层的样子 */
export interface DocsViewState {
  groups: DocGroup[]
  truncated: boolean
  loading: boolean
  error: string | null
  /** 当前选中的那一篇 */
  selected: { path: string; entry: DocEntry } | null
  /** 它的正文（只有文本类能读） */
  content: string | null
  contentLoading: boolean
  contentError: string | null
}

const EMPTY_DOCS: DocsViewState = {
  groups: [],
  truncated: false,
  loading: false,
  error: null,
  selected: null,
  content: null,
  contentLoading: false,
  contentError: null
}

/** 活动项目标签的目录 —— Git 是项目级的东西，都按它取 */
function activeCwd(snapshot: HostSnapshot): string {
  return snapshot.projectTabs.find((tab) => tab.id === snapshot.activeProjectTabId)?.cwd ?? ''
}

/**
 * 窄轨选中的入口。`'agent'` 表示看当前活动 agent 的对话。
 *
 * 放在渲染层而不是快照里：它是「我现在看哪儿」，不是事实。
 * 按项目分别记住要到 S7（项目标签接管入口状态）才做。
 */
export type PaneTarget = ProjectPane | 'agent'

const PANE_VALUES: readonly PaneTarget[] = ['code', 'docs', 'browser', 'settings', 'agent']

function loadPane(): PaneTarget {
  try {
    const raw = localStorage.getItem(PANE_KEY)
    if (raw && (PANE_VALUES as readonly string[]).includes(raw)) return raw as PaneTarget
  } catch {
    // 存不下就用默认
  }
  /*
   * 默认看**对话**，不是「代码」。
   *
   * 打开应用第一眼应该是上次那个 agent 在聊什么；代码区是「我要翻文件」时才去的地方，
   * 而且新项目里它是个空树 —— 拿空树当首页是劝退。记过选择的话用记的那个。
   */
  return 'agent'
}

function savePane(pane: PaneTarget): void {
  try {
    localStorage.setItem(PANE_KEY, pane)
  } catch {
    // 存不下就算了
  }
}

/** 区域 5 的宽度，按入口各记一份 —— 文件树和对话需要的宽度不一样 */
function loadZone5Widths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(ZONE5_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed ?? {})) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function saveZone5Widths(widths: Record<string, number>): void {
  try {
    localStorage.setItem(ZONE5_KEY, JSON.stringify(widths))
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
   * 窄轨当前选中的是什么（PLAN.md D51 / D52）。
   *
   * `'agent'` 表示看当前活动 agent 的对话；其余四个是项目级入口。
   * 区域 5 有没有、多宽，由 `PANE_LAYOUT` 决定，不在这里存。
   */
  pane: PaneTarget
  /** 对话区当前排版模式（PLAN.md D10） */
  mode: ConversationMode
  /** 亮 / 暗，默认亮色 */
  theme: Theme
  /** 会话流事件计数 —— 骨架阶段先只记账，不渲染 */
  eventCount: number
  /** agent 结束的计数；Git 面板用它触发防抖刷新 */
  gitRevision: number
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
  /**
   * 代码区的两个 tab：文件 / 改动（PLAN.md D52）。
   *
   * 纯界面状态 —— 不落盘到宿主。记住它是为了「点文件看 diff，再点文件树」时不用重新选。
   */
  codeMode: CodeMode
  /** Git 改动的状态、列表与当前选中的 diff —— 区域 5 显示列表，区域 6 显示 diff */
  git: GitViewState
  /** 文档区：分组清单、当前选中的一篇、它的内容 */
  docs: DocsViewState
  /**
   * 当前有几个浮层开着（气泡、菜单、对话框）。
   *
   * 浏览器页面是原生 view，画在 DOM 之上；有浮层时要把原生视图收起来，
   * 否则气泡被盖住、对话框点不到。见 `shell/useOverlay.ts`。
   */
  overlayCount: number
  /** 项目设置里选中的分类 */
  settingsCategory: 'agents' | 'conversations' | 'project'
  /** 区域 5 的宽度，按入口各记一份 */
  zone5Widths: Record<string, number>
  /** 从输入框发起的改名请求 —— 项目设置 → 会话管理看到后打开改名对话框 */
  renameRequest: { path: string; nonce: number } | null
  /** 新建对话请求 —— App 看到后弹出「先起名再建」的对话框 */
  newConversationRequest: { cwd: string; nonce: number } | null
  /** 模型选择器的锚点（null = 关着）。position: fixed 用，贴着触发它的控件上方 */
  modelPickerAnchor: { left: number; bottom: number } | null
  /** 临时对话是否收起成右下角胶囊 */
  tempMinimized: boolean
  /** 已配置凭据的模型清单（打开选择器时拉一次） */
  models: ModelOption[]
  /** 模型清单拉取中的提示 */
  modelsLoading: boolean
  /** 模型清单拉取失败的原因 */
  modelsError: string | null

  /**
   * 文件内容缓存（按绝对路径）。
   *
   * 不持久化 —— 内容会过期。切到某个文件时按需读。
   */
  fileContents: Record<string, FileContent>
  /**
   * 各项目展开的目录 —— **按 cwd 分开记**（D22）。
   *
   * 切回项目 A，A 的树恢复到你上次展开的样子。
   */
  treeExpanded: Record<string, string[]>
  /**
   * 各宿主的标注状态（开关、当前文件、块登记）—— 主进程推的事件驱动。
   *
   * 只有 `agent:<id>` 会有内容；工具栏的开关和「点得出块」都看它。
   */
  annotations: Record<string, AnnotationState>
  /**
   * 每个 agent 输入框里已经落下的引用，跟着输入框走。
   *
   * 一条引用对应页面上的一个常驻角标：加一个引用多一个角标，删掉引用角标一起撤。
   */
  citations: Record<string, BlockCitation[]>
  /** 收到一份标注状态（主进程推的开关、块登记、页面加载） */
  setAnnotation: (state: AnnotationState) => void
  /** 点了一块：追加引用；同一块重复点不新增 */
  addCitation: (agentId: string, citation: BlockCitation) => void
  /** 删掉一个引用（按文件 + 块号/临时号），角标跟着撤 */
  removeCitation: (agentId: string, file: string, key: string) => void
  /** 各项目已加载的目录内容（按 `cwd + 目录路径`） */
  treeEntries: Record<string, FileEntry[]>
  /** 某个目录为什么没读成 —— 越界的符号链接会写在这里 */
  treeErrors: Record<string, string>

  setSnapshot: (snapshot: HostSnapshot) => void
  setPane: (pane: PaneTarget) => void
  setCodeMode: (mode: CodeMode) => void
  /** 读 Git 状态（区域 5 的「改动」tab 用） */
  loadGitStatus: (cwd: string) => Promise<void>
  /** 选中一个改动 → 区域 6 读它的 diff */
  selectChange: (path: string, scope: GitDiffScope) => Promise<void>
  /** 关掉 diff（回到文件预览） */
  closeChange: () => void
  /** 读 AI 文档清单（区域 5 的文档区） */
  setSettingsCategory: (category: 'agents' | 'conversations' | 'project') => void
  /** 登记一个浮层（挂载时）/ 撤销（卸载时） */
  pushOverlay: () => void
  popOverlay: () => void
  loadDocs: (cwd: string) => Promise<void>
  /** 打开一篇文档 → 区域 6 读它的内容 */
  openDoc: (path: string) => Promise<void>
  setZone5Width: (pane: string, width: number) => void
  /** 选中某一轮，右侧上下文看截至这一轮的最后两次请求 */
  setMode: (mode: ConversationMode) => void
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
  /**
   * 把窄轨切到浏览器入口（agent 在操作浏览器时用）。
   *
   * agent 操作浏览器时调它 —— 用户不用自己找面板。
   */
  focusBrowser: () => void
  /** 请求改某条会话的名字 —— 屏幕上的项目设置 → 会话管理消费它 */
  requestRename: (path: string) => void
  /** 改名对话框已经处理掉请求 */
  consumeRenameRequest: () => void
  /** 请求新建对话（先起名） */
  requestNewConversation: (cwd: string) => void
  /** 新建对话对话框已经处理掉请求 */
  consumeNewConversationRequest: () => void
  bumpEvents: (count: number) => void
  /** 换会话时整体替换内容流（R5）—— 按标签存 */
  setItems: (tabId: string, items: StreamItem[]) => void
  /** 丢弃某个临时/标签的内容流（关闭临时对话时用） */
  clearTabItems: (tabId: string) => void
  /** 临时对话是否收起成右下角胶囊 */
  setTempMinimized: (value: boolean) => void
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
  /** 读某个文件（有缓存就复用） */
  loadFile: (path: string, cwd: string) => Promise<void>
  /**
   * 加载一个目录的条目 —— **只加载，不改展开状态**。
   *
   * 文件树第一次进来要先把根目录读出来（不然显示「加载中」），
   * 但那不等于「展开根目录」。所以这两个动作分开。
   */
  loadDir: (cwd: string, dir: string) => Promise<void>
  /** 展开 / 收起文件树里的一个目录 */
  toggleDir: (cwd: string, dir: string) => Promise<void>
  /** 打开某个文件（进文件标签栏） */
  openFile: (cwd: string, path: string) => Promise<void>
  /** 文件被外部改过之后重新加载：清掉内容缓存，重读一遍 */
  reloadFile: (fileId: string, path: string, cwd: string) => Promise<void>
  /** 拉模型清单 */
  loadModels: (tabId: string) => Promise<void>
  /** 切某个标签的模型（persist 时同时设为新会话默认） */
  selectModel: (tabId: string, provider: string, id: string, persist: boolean) => Promise<void>
}

export const useStore = create<RendererStore>((set, get) => ({
  snapshot: EMPTY_SNAPSHOT,
  pane: loadPane(),
  mode: 'normal',
  theme: loadTheme(),
  eventCount: 0,
  gitRevision: 0,
  items: {},
  streaming: {},
  expandedTools: {},
  codeMode: 'files',
  git: EMPTY_GIT,
  docs: EMPTY_DOCS,
  overlayCount: 0,
  settingsCategory: 'agents',
  zone5Widths: loadZone5Widths(),
  renameRequest: null,
  newConversationRequest: null,
  modelPickerAnchor: null,
  tempMinimized: false,
  models: [],
  modelsLoading: false,
  modelsError: null,
  fileContents: {},
  annotations: {},
  citations: {},
  treeExpanded: loadTreeExpanded(),
  treeEntries: {},
  treeErrors: {},

  setSnapshot: (snapshot) => {
    const previousSessionId = get().snapshot.session.sessionId
    const nextSessionId = snapshot.session.sessionId
    const previousTempId = get().snapshot.temporaryChat?.id
    const nextTempId = snapshot.temporaryChat?.id
    const tempChanged = previousTempId !== nextTempId
    if (previousSessionId === nextSessionId) {
      set({
        snapshot,
        ...(tempChanged ? { tempMinimized: false } : {})
      })
      return
    }
    // 换会话：把该会话上次的排版模式取回来（模式记在会话状态里）
    const modes = loadModes()
    const mode = (nextSessionId && modes[nextSessionId]) || 'normal'
    set({
      snapshot,
      mode,
          ...(tempChanged ? { tempMinimized: false } : {})
    })
  },


  setPane: (pane) => {
    savePane(pane)
    set({ pane })
  },

  setCodeMode: (mode) => set({ codeMode: mode }),

  setAnnotation: (state) => {
    set((current) => ({
      annotations: { ...current.annotations, [state.host]: state }
    }))
  },

  addCitation: (agentId, citation) => {
    const key = blockKey(citation)
    const current = get().citations[agentId] ?? []
    // 同一个块重复点不新增 —— 引用的数量要等于用户说的块的个数
    if (current.some((item) => blockKey(item) === key && item.file === citation.file)) return
    set((state) => ({ citations: { ...state.citations, [agentId]: [...current, citation] } }))
  },

  removeCitation: (agentId, file, key) => {
    const current = get().citations[agentId] ?? []
    set((state) => ({
      citations: {
        ...state.citations,
        // 键是「文件 + 块号」两段 —— 将来多屏原型里同名块号不会互相撤掉
        [agentId]: current.filter((item) => !(item.file === file && blockKey(item) === key))
      }
    }))
  },

  loadGitStatus: async (cwd) => {
    const seq = ++gitSeq
    set({ git: { ...get().git, loading: true, error: null } })
    try {
      const next = await host.getGitStatus(cwd)
      if (seq !== gitSeq) return
      const previous = get().git.selected
      // 选中的文件如果已经不在改动里了（提交了、还原了），把 diff 也收起来
      const still =
        previous && next[previous.scope].some((file) => file.path === previous.path) ? previous : null
      set({
        git: { ...get().git, status: next, loading: false, error: next.error, selected: still, diff: still ? get().git.diff : null }
      })
    } catch (caught) {
      if (seq !== gitSeq) return
      set({
        git: {
          ...get().git,
          loading: false,
          error: caught instanceof Error ? caught.message : String(caught)
        }
      })
    }
  },

  selectChange: async (path, scope) => {
    const cwd = activeCwd(get().snapshot)
    if (!cwd) return
    const seq = ++diffSeq
    set({ git: { ...get().git, selected: { path, scope }, diff: null, diffError: null, diffLoading: true } })
    try {
      const next = await host.getGitDiff(cwd, path, scope)
      if (seq !== diffSeq) return
      set({ git: { ...get().git, diff: next, diffError: next.error, diffLoading: false } })
    } catch (caught) {
      if (seq !== diffSeq) return
      set({
        git: {
          ...get().git,
          diffLoading: false,
          diffError: caught instanceof Error ? caught.message : String(caught)
        }
      })
    }
  },

  closeChange: () => {
    diffSeq += 1
    set({ git: { ...get().git, selected: null, diff: null, diffError: null, diffLoading: false } })
  },

  setSettingsCategory: (category) => set({ settingsCategory: category }),

  pushOverlay: () => set((state) => ({ overlayCount: state.overlayCount + 1 })),
  popOverlay: () => set((state) => ({ overlayCount: Math.max(0, state.overlayCount - 1) })),

  loadDocs: async (cwd) => {
    if (!cwd) {
      set({ docs: EMPTY_DOCS })
      return
    }
    const seq = ++docsSeq
    set({ docs: { ...get().docs, loading: true, error: null } })
    try {
      const next = await host.listDocs(cwd)
      if (seq !== docsSeq) return
      // 选中的那篇还在清单里就留着，不在就收起来
      const selected = get().docs.selected
      const still = selected && next.groups.some((group) => group.entries.some((item) => item.path === selected.path))
      set({
        docs: { ...get().docs, groups: next.groups, truncated: next.truncated, loading: false, selected: still ? selected : null }
      })
    } catch (caught) {
      if (seq !== docsSeq) return
      set({
        docs: {
          ...get().docs,
          loading: false,
          error: caught instanceof Error ? caught.message : String(caught)
        }
      })
    }
  },

  openDoc: async (path) => {
    const cwd = activeCwd(get().snapshot)
    if (!cwd) return
    const seq = ++docSeq
    const entry = get()
      .docs.groups.flatMap((group) => group.entries)
      .find((item) => item.path === path)
    set({
      docs: {
        ...get().docs,
        selected: entry ? { path, entry } : null,
        content: null,
        contentLoading: true,
        contentError: null
      }
    })
    try {
      const next = await host.readFile(cwd, path)
      if (seq !== docSeq) return
      set({
        docs: {
          ...get().docs,
          content: next.kind === 'text' ? next.text : null,
          // 只有文本能在这里读 —— 图片和二进制给一个说明，指去文件预览
          contentError:
            next.kind === 'text'
              ? next.tooLarge
                ? '这个文件太大，没有读进来'
                : null
              : next.kind === 'unsupported'
                ? next.reason
                : '这个格式不能在文档区里读，用文件预览打开',
          contentLoading: false
        }
      })
    } catch (caught) {
      if (seq !== docSeq) return
      set({
        docs: {
          ...get().docs,
          contentLoading: false,
          contentError: caught instanceof Error ? caught.message : String(caught)
        }
      })
    }
  },

  setZone5Width: (pane, width) => {
    const next = { ...get().zone5Widths, [pane]: width }
    saveZone5Widths(next)
    set({ zone5Widths: next })
  },

  setTempMinimized: (value) => set({ tempMinimized: value }),

  clearTabItems: (tabId) =>
    set((state) => {
      const items = { ...state.items }
      const streaming = { ...state.streaming }
      const expandedTools = { ...state.expandedTools }
      delete items[tabId]
      delete streaming[tabId]
      delete expandedTools[tabId]
      return { items, streaming, expandedTools }
    }),

  reloadTab: async (tabId) => {
    await host.reloadAgent(tabId)
    // 重建完 runtime 再从磁盘读一遍内容流 —— 少了这一步，屏幕还是旧的
    get().setItems(tabId, await host.getAgentEntries(tabId))
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
      const bucket = byTab.get(event.agentId)
      if (bucket) bucket.push(event)
      else byTab.set(event.agentId, [event])
    }
    const items = { ...get().items }
    const streaming = { ...get().streaming }
    for (const [tabId, list] of byTab) {
      let tabItems = items[tabId] ?? []
      let tabStreaming = streaming[tabId] ?? false
      for (const event of list) {
        tabItems = applyEvent(tabItems, event)
        tabStreaming = nextStreaming(tabStreaming, event)
      }
      items[tabId] = tabItems
      streaming[tabId] = tabStreaming
    }
    set({
      items,
      streaming,
      eventCount: get().eventCount + events.length,
      ...(events.some((event) => event.type === 'agent_settled')
        ? { gitRevision: get().gitRevision + 1 }
        : {})
    })
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

  focusBrowser: () => {
    // agent 操作浏览器时切到浏览器入口 —— 窄轨永远在，不用先展开什么
    savePane('browser')
    set({ pane: 'browser' })
  },



  requestRename: (path) => {
    set((state) => ({
      renameRequest: { path, nonce: (state.renameRequest?.nonce ?? 0) + 1 }
    }))
  },

  consumeRenameRequest: () => set({ renameRequest: null }),

  requestNewConversation: (cwd) => {
    set((state) => ({
      newConversationRequest: { cwd, nonce: (state.newConversationRequest?.nonce ?? 0) + 1 }
    }))
  },

  consumeNewConversationRequest: () => set({ newConversationRequest: null }),

  openModelPicker: (anchor) => {
    set({ modelPickerAnchor: anchor })
    const agentId = get().snapshot.activeAgentId
    if (agentId) void get().loadModels(agentId)
  },

  closeModelPicker: () => set({ modelPickerAnchor: null }),

  loadFile: async (path, cwd) => {
    if (get().fileContents[path]) return
    try {
      const content = await host.readFile(cwd, path)
      set((state) => ({ fileContents: { ...state.fileContents, [path]: content } }))
    } catch {
      set((state) => ({
        fileContents: {
          ...state.fileContents,
          [path]: { kind: 'unsupported', reason: '读不了这个文件' }
        }
      }))
    }
  },

  loadDir: async (cwd, dir) => {
    const key = `${cwd}\u0001${dir}`
    if (get().treeEntries[key]) return
    try {
      const result = await host.listFiles(cwd, dir)
      set((state) => ({
        treeEntries: { ...state.treeEntries, [key]: result.entries },
        treeErrors: result.error
          ? { ...state.treeErrors, [key]: result.error }
          : Object.fromEntries(Object.entries(state.treeErrors).filter(([k]) => k !== key))
      }))
    } catch (caught) {
      // 读不了（权限、被删）—— 记成空并写一句原因，别让界面一直转
      set((state) => ({
        treeEntries: { ...state.treeEntries, [key]: [] },
        treeErrors: {
          ...state.treeErrors,
          [key]: caught instanceof Error ? caught.message : String(caught)
        }
      }))
    }
  },

  toggleDir: async (cwd, dir) => {
    const expanded = get().treeExpanded[cwd] ?? []
    if (expanded.includes(dir)) {
      const next = { ...get().treeExpanded, [cwd]: expanded.filter((d) => d !== dir) }
      saveTreeExpanded(next)
      set({ treeExpanded: next })
      return
    }
    // 展开：还没加载过就先加载这一层
    await get().loadDir(cwd, dir)
    if (!get().treeEntries[`${cwd}\u0001${dir}`]) return
    const next = { ...get().treeExpanded, [cwd]: [...(get().treeExpanded[cwd] ?? []), dir] }
    saveTreeExpanded(next)
    set({ treeExpanded: next })
  },

  openFile: async (cwd, path) => {
    // 只负责「进标签栏」—— 内容由 FilePane 的 effect 按活动文件加载
    await host.openFile(cwd, path)
  },

  reloadFile: async (fileId, path, cwd) => {
    // 先清缓存再读 —— 不清的话 loadFile 看到有缓存就直接返回了
    set((state) => {
      const next = { ...state.fileContents }
      delete next[path]
      return { fileContents: next }
    })
    await host.reloadFile(fileId)
    await get().loadFile(path, cwd)
  },

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
