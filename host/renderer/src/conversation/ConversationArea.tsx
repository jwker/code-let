import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CommandArgumentOption, CommandOption, FileSearchResult, StreamItem, ThinkingLevel } from '@contract/index'
import { useStore } from '../store'
import { host } from '../host'
import { useIndicator } from '../shell/useIndicator'
import { IconArrowUp, IconPaperclip, IconStop } from '../shell/icons'
import { ConversationNav } from './ConversationNav'
import { userTurnsOf } from './conversationTurns'
import { NormalStream } from './NormalStream'
import { ScrollJump } from './ScrollJump'
import { TerminalStream } from './TerminalStream'
import {
  attachmentOf,
  attachmentTotalError,
  codeletCommands,
  commandNameOf,
  filterCommands,
  findArgumentQuery,
  findAtQuery,
  findMentions,
  findSlashQuery,
  formatBytes,
  formatTokenEstimate,
  insertArgument,
  insertCommand,
  insertMention,
  isCodeletCommandName,
  mergeCommands,
  parseCodeletCommand,
  removeMentions,
  COMMAND_SOURCE_LABEL,
  type ComposerAttachment
} from './composerCommands'
import { useAutoScroll } from './useAutoScroll'

/** 还没有内容流时的空数组 —— 稳定引用，别每次渲染新建 */
const EMPTY_ITEMS: StreamItem[] = []

type ComposerMenuState = {
  kind: 'command' | 'file' | 'argument'
  /** 只有参数菜单用：不带斜杠的命令名 */
  commandName?: string
  query: string
  tokenStart: number
  tokenEnd: number
  active: number
}

type ComposerNotice = { kind: 'info' | 'error'; text: string }

/**
 * 对话区 —— 应用的核心组件（PLAN.md D10）。
 *
 * 一条内容流，三种排版。普通和终端读同一个数组（R3），
 * HTML 模式这一轮留空 —— 它不是排版，是 skill 的产物。
 */
export function ConversationArea() {
  const mode = useStore((s) => s.mode)
  const session = useStore((s) => s.snapshot.session)
  const activeTabId = useStore((s) => s.snapshot.activeTabId)
  // 内容流按标签存（D4 修订）—— 这里只读活动标签那一份
  const items = useStore((s) => (s.snapshot.activeTabId ? s.items[s.snapshot.activeTabId] : undefined) ?? EMPTY_ITEMS)
  const streaming = useStore(
    (s) => (s.snapshot.activeTabId ? s.streaming[s.snapshot.activeTabId] : undefined) ?? false
  )
  const openPicker = useStore((s) => s.openModelPicker)
  const reloadTab = useStore((s) => s.reloadTab)
  const conversations = useStore((s) => s.snapshot.conversations)
  const tabs = useStore((s) => s.snapshot.tabs)
  const sidebarOpen = useStore((s) => s.sidebarOpen)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const requestRename = useStore((s) => s.requestRename)
  /**
   * 这个标签正在中止 —— 主进程说的「abort 还没返回」。
   *
   * 不管「该不该显示停止中」—— 那是下面 `useIndicator` 的事。
   */
  const aborting = useStore(
    (s) => (s.snapshot.activeTabId ? s.snapshot.aborting.includes(s.snapshot.activeTabId) : false)
  )
  /*
   * 「停止中」的显示时机。多数中止在几十毫秒内就结束，直接显示会闪一下 ——
   * 跟状态栏的「刷新中」是同一套规则，共用同一份实现。
   */
  const stopping = useIndicator(aborting)
  /**
   * 这个会话在别处被改过 —— 内容流落后了，得先重新加载才能继续说话。
   *
   * 为什么不让输入：Codelet 这边的 runtime 还是旧上下文，
   * 这时候发消息会跟别处（比如 TUI）的写入冲突。
   */
  const stale = useStore((s) => {
    const tabId = s.snapshot.activeTabId
    return tabId ? (s.snapshot.tabs.find((t) => t.id === tabId)?.stale ?? false) : false
  })
  const [reloading, setReloading] = useState(false)
  const [draft, setDraft] = useState('')

  /*
   * 输入法组词状态。
   *
   * 为什么不能只靠 `event.nativeEvent.isComposing`：有些输入法在
   * `compositionend` **之后**才发 `keydown(Enter)`，那时 `isComposing` 已经是 false
   * —— 只看它会把「选词的回车」当成「发送的回车」，一句话就被发出去了。
   *
   * 所以两个条件都判：组词中（`composing`）或者刚结束组词的这一小段时间
   * （`composeEndedAt`，80ms）里的回车，都不发送。
   */
  const composing = useRef(false)
  const composeEndedAt = useRef(0)

  const [menu, setMenu] = useState<ComposerMenuState | null>(null)
  const [piCommands, setPiCommands] = useState<CommandOption[]>([])
  const [fileItems, setFileItems] = useState<FileSearchResult[]>([])
  const [fileLoading, setFileLoading] = useState(false)
  const [fileError, setFileError] = useState<string | null>(null)
  const [argumentItems, setArgumentItems] = useState<CommandArgumentOption[]>([])
  const [argumentLoading, setArgumentLoading] = useState(false)
  const [argumentError, setArgumentError] = useState<string | null>(null)
  const [notice, setNotice] = useState<ComposerNotice | null>(null)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const caretAfterInsert = useRef<number | null>(null)
  const refreshAfterInsert = useRef(false)
  // 插入后的一小段时间里压掉 onSelect 的重复刷新，避免用旧 DOM 值把菜单又打开
  const suppressRefreshUntil = useRef(0)
  const noticeTimer = useRef<number | null>(null)
  /** `@` 搜索的递增 id —— 每次 effect 一个，旧请求会被显式取消 */
  const searchSeq = useRef(0)

  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const cwd = activeTab?.cwd ?? session.cwd
  const canRename = Boolean(activeTab?.path && conversations.some((c) => c.path === activeTab.path))

  // `/` 的 Pi 命令按标签拉一次；runtime 还没就绪时是空数组，就绪后重拉
  useEffect(() => {
    if (!activeTabId) {
      setPiCommands([])
      return
    }
    let cancelled = false
    host
      .listCommands(activeTabId)
      .then((commands) => {
        if (!cancelled) setPiCommands(commands)
      })
      .catch(() => {
        if (!cancelled) setPiCommands([])
      })
    return () => {
      cancelled = true
    }
  }, [activeTabId, session.ready, session.sessionId])

  // 扩展命令 / `/thinking` 的参数候选：输入空格后拉一次，60ms 去抖
  useEffect(() => {
    if (menu?.kind !== 'argument' || !menu.commandName || !activeTabId) return
    let cancelled = false
    setArgumentLoading(true)
    setArgumentError(null)
    setArgumentItems([])
    const name = menu.commandName
    const query = menu.query
    const timer = setTimeout(() => {
      const request =
        name === 'thinking'
          ? host.listThinkingLevels(activeTabId).then((levels) =>
              levels
                .filter((level) => level.toLowerCase().startsWith(query.toLowerCase()))
                .map((level) => ({ value: level, label: level }))
            )
          : host.completeCommand(activeTabId, name, query)
      request
        .then((items) => {
          if (cancelled) return
          setArgumentItems(items)
          setArgumentLoading(false)
        })
        .catch((error) => {
          if (cancelled) return
          setArgumentItems([])
          setArgumentError(error instanceof Error ? error.message : String(error))
          setArgumentLoading(false)
        })
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [menu?.kind, menu?.commandName, menu?.query, activeTabId])

  // `/thinking` 的参数候选回来后，高亮当前等级；用户已经用方向键移动过就不动
  useEffect(() => {
    if (menu?.kind !== 'argument' || menu.commandName !== 'thinking') return
    const index = argumentItems.findIndex((item) => item.value === session.thinkingLevel)
    if (index < 0) return
    setMenu((current) =>
      current && current.kind === 'argument' && current.active === 0
        ? { ...current, active: index }
        : current
    )
  }, [argumentItems, menu?.kind, menu?.commandName, session.thinkingLevel])

  // `@` 搜索：query 变了就重搜，120ms 去抖；空 query 立刻列根目录
  useEffect(() => {
    if (menu?.kind !== 'file' || !cwd) return
    let cancelled = false
    const requestId = `files-${activeTabId ?? 'none'}-${++searchSeq.current}`
    setFileLoading(true)
    setFileError(null)
    setFileItems([])
    const timer = setTimeout(() => {
      host
        .searchFiles(cwd, menu.query, 50, requestId)
        .then((items) => {
          if (cancelled) return
          setFileItems(items)
          setFileLoading(false)
        })
        .catch((error) => {
          if (cancelled) return
          setFileItems([])
          setFileError(error instanceof Error ? error.message : String(error))
          setFileLoading(false)
        })
    }, menu.query ? 120 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
      // 查询变了/菜单关了：让主进程别再扫这个请求（索引构建会继续）
      void host.cancelFileSearch(requestId).catch(() => {})
    }
  }, [menu?.kind, menu?.query, cwd, activeTabId])

  useEffect(() => {
    setMenu(null)
    // 附件属于当前标签的 cwd；切标签就清掉，避免把 A 项目的路径发到 B 项目
    setAttachments([])
    attachmentsRef.current = []
  }, [activeTabId])

  // 状态里的附件是权威；ref 给异步的 attach / send 读最新值
  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // 输入框清空后菜单必须关 —— 发送时 onChange/select 的旧值可能把菜单又打开
  useEffect(() => {
    if (draft.trim() === '') setMenu(null)
  }, [draft])

  useEffect(() => {
    if (stale) setMenu(null)
  }, [stale])

  // 点菜单和输入框外面才关 —— 不能靠 textarea 的 blur，否则拖动菜单滚动条也会关
  useEffect(() => {
    if (!menu) return
    function onDown(event: MouseEvent): void {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || textareaRef.current?.contains(target)) return
      setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu])

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    },
    []
  )

  const codelet = useMemo(
    () =>
      codeletCommands({
        streaming,
        stopping,
        stale,
        hasCwd: Boolean(cwd),
        canRename,
        canModel: Boolean(session.model) && !streaming
      }),
    [streaming, stopping, stale, cwd, canRename, session.model]
  )

  // 流式期间：扩展命令放行；模板和技能仍然等这一轮结束
  const extensionCommandNames = useMemo(
    () =>
      new Set(
        piCommands
          .filter((command) => command.source === 'extension' && !isCodeletCommandName(command.name))
          .map((command) => command.name)
      ),
    [piCommands]
  )
  const blockedCommandNames = useMemo(
    () => new Set(piCommands.filter((command) => command.source !== 'extension').map((command) => command.name)),
    [piCommands]
  )

  const allCommands = useMemo(
    () =>
      mergeCommands(
        codelet,
        piCommands,
        streaming || stopping || stale ? '等这一轮结束再发' : undefined,
        ['template', 'skill']
      ),
    [codelet, piCommands, streaming, stopping, stale]
  )

  const commandItems = useMemo(
    () => filterCommands(allCommands, menu?.kind === 'command' ? menu.query : ''),
    [allCommands, menu?.kind, menu?.query]
  )

  const menuCount =
    menu?.kind === 'command'
      ? commandItems.length
      : menu?.kind === 'file'
        ? fileItems.length
        : menu?.kind === 'argument'
          ? argumentItems.length
          : 0

  // 结果数量变了，把高亮项夹回范围内
  useEffect(() => {
    setMenu((current) => {
      if (!current) return current
      const count =
        current.kind === 'command'
          ? commandItems.length
          : current.kind === 'file'
            ? fileItems.length
            : argumentItems.length
      const active = Math.min(current.active, Math.max(0, count - 1))
      return active === current.active ? current : { ...current, active }
    })
  }, [menu?.kind, commandItems.length, fileItems.length, argumentItems.length])

  // 插入后把光标放回去；`@` 选目录时保持菜单打开，继续搜下一层
  useLayoutEffect(() => {
    if (caretAfterInsert.current === null) return
    const caret = caretAfterInsert.current
    caretAfterInsert.current = null
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(caret, caret)
    if (refreshAfterInsert.current) {
      refreshAfterInsert.current = false
      refreshMenu(el.value, caret, true)
    }
  }, [draft])

  // 实时流往下长 —— 视图要跟着走，不然用户看不到刚出来的内容（R2）
  const { setRef, nodeRef: scrollRef, scrollToBottom, jumpTo, scrollable, atBottom } = useAutoScroll(
    items,
    streaming,
    session.sessionId
  )
  const hasNav = mode !== 'html' && userTurnsOf(items).length >= 2

  function showNotice(kind: ComposerNotice['kind'], text: string, timeout = 0): void {
    if (noticeTimer.current !== null) {
      window.clearTimeout(noticeTimer.current)
      noticeTimer.current = null
    }
    setNotice({ kind, text })
    if (timeout > 0) {
      noticeTimer.current = window.setTimeout(() => {
        setNotice(null)
        noticeTimer.current = null
      }, timeout)
    }
  }

  function updateAttachments(next: ComposerAttachment[]): void {
    attachmentsRef.current = next
    setAttachments(next)
  }

  async function attachFile(path: string): Promise<void> {
    if (!cwd) return
    if (attachmentsRef.current.some((item) => item.path === path)) return
    const tabId = activeTabId
    try {
      const content = await host.readFile(cwd, path)
      // 读文件期间切了标签 —— 这个附件不属于现在这个会话
      if (activeTabIdRef.current !== tabId) return
      const checked = attachmentOf(path, content)
      if ('error' in checked) {
        showNotice('error', `不能添加附件：${checked.error}`)
        return
      }
      const totalError = attachmentTotalError(attachmentsRef.current, checked.attachment)
      if (totalError) {
        showNotice('error', totalError)
        return
      }
      updateAttachments([...attachmentsRef.current, checked.attachment])
    } catch (error) {
      showNotice('error', `不能添加附件：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function attachmentKey(item: ComposerAttachment): string {
    return item.uploadId ?? item.path
  }

  function attachmentLabel(item: ComposerAttachment): string {
    return item.name ?? item.path
  }

  /** 正文里删掉 `@path` 时，同步去掉对应的 chip；上传附件不依赖正文，保留 */
  function syncAttachmentsWithDraft(text: string): void {
    if (attachmentsRef.current.length === 0) return
    const mentioned = new Set(findMentions(text).map((mention) => mention.path))
    const next = attachmentsRef.current.filter((item) => item.uploadId || mentioned.has(item.path))
    if (next.length !== attachmentsRef.current.length) updateAttachments(next)
  }

  function removeAttachment(item: ComposerAttachment): void {
    // 项目内附件：点 chip 的 × 时，把正文里的引用也删掉；上传附件没有正文引用
    if (!item.uploadId) {
      const result = removeMentions(draft, item.path, textareaRef.current?.selectionStart ?? draft.length)
      if (result) {
        caretAfterInsert.current = result.caret
        setDraft(result.text)
      }
    }
    updateAttachments(attachmentsRef.current.filter((next) => attachmentKey(next) !== attachmentKey(item)))
  }

  /** 系统文件选择器：选中的文件只留在主进程，渲染层拿到 id 和元信息 */
  async function pickUploads(): Promise<void> {
    if (!activeTabId || uploading) return
    const tabId = activeTabId
    setUploading(true)
    try {
      const result = await host.pickAttachments()
      if (activeTabIdRef.current !== tabId) return
      for (const picked of result.attachments) {
        const attachment: ComposerAttachment = {
          path: picked.name,
          name: picked.name,
          uploadId: picked.id,
          kind: picked.kind,
          size: picked.size,
          tokens: picked.tokens
        }
        if (attachmentsRef.current.some((item) => attachmentKey(item) === picked.id)) continue
        const totalError = attachmentTotalError(attachmentsRef.current, attachment)
        if (totalError) {
          showNotice('error', totalError)
          break
        }
        updateAttachments([...attachmentsRef.current, attachment])
      }
      if (result.errors.length > 0) showNotice('error', result.errors.join('；'))
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error))
    } finally {
      setUploading(false)
    }
  }

  /** 根据光标位置决定开 `/` 还是 `@` 菜单。text/caret 显式传入时用于插入后的重算 */
  function refreshMenu(text?: string, caret?: number, force = false): void {
    // onSelect 可能在 React 提交新值之前触发（拿到旧 DOM 值）—— 插入后短暂忽略
    if (!force && text === undefined && Date.now() < suppressRefreshUntil.current) return
    if (stale || !activeTabId) {
      setMenu(null)
      return
    }
    const el = textareaRef.current
    const value = text ?? el?.value ?? draft
    const at = caret ?? el?.selectionStart ?? value.length

    const slash = findSlashQuery(value, at)
    if (slash) {
      setMenu((current) =>
        current && current.kind === 'command' && current.query === slash.query && current.tokenStart === slash.tokenStart
          ? current
          : {
              kind: 'command',
              query: slash.query,
              tokenStart: slash.tokenStart,
              tokenEnd: slash.tokenEnd,
              active: 0
            }
      )
      return
    }

    const argument = findArgumentQuery(value, at)
    if (argument) {
      const command = allCommands.find(
        (candidate) => candidate.name === argument.commandName && candidate.hasArgumentCompletions
      )
      if (command && !command.disabled) {
        setMenu((current) =>
          current &&
          current.kind === 'argument' &&
          current.commandName === argument.commandName &&
          current.query === argument.prefix &&
          current.tokenStart === argument.tokenStart
            ? current
            : {
                kind: 'argument',
                commandName: argument.commandName,
                query: argument.prefix,
                tokenStart: argument.tokenStart,
                tokenEnd: argument.tokenEnd,
                active: 0
              }
        )
        return
      }
    }

    const mention = findAtQuery(value, at)
    if (mention && cwd) {
      setMenu((current) =>
        current && current.kind === 'file' && current.query === mention.query && current.tokenStart === mention.tokenStart
          ? current
          : {
              kind: 'file',
              query: mention.query,
              tokenStart: mention.tokenStart,
              tokenEnd: mention.tokenEnd,
              active: 0
            }
      )
      return
    }

    setMenu(null)
  }

  function applyInsert(result: { text: string; caret: number }, keepMenu: boolean): void {
    caretAfterInsert.current = result.caret
    refreshAfterInsert.current = keepMenu
    suppressRefreshUntil.current = Date.now() + 50
    setDraft(result.text)
  }

  function selectItem(index: number): void {
    if (!menu) return

    if (menu.kind === 'command') {
      const item = commandItems[index]
      if (!item || item.disabled) return
      if (item.source === 'codelet') {
        // `/thinking` 需要参数：先把命令插进去，让下一帧的 refreshMenu 弹参数候选
        if (item.hasArgumentCompletions) {
          applyInsert(insertCommand(draft, menu.tokenStart, menu.tokenEnd, item.name), true)
          return
        }
        void runCodeletCommand(item.name)
        return
      }
      const keepMenu = Boolean(item.hasArgumentCompletions)
      applyInsert(insertCommand(draft, menu.tokenStart, menu.tokenEnd, item.name), keepMenu)
      if (!keepMenu) setMenu(null)
      return
    }

    if (menu.kind === 'argument') {
      const item = argumentItems[index]
      if (!item) return
      if (menu.commandName === 'thinking') {
        void chooseThinking(item.value as ThinkingLevel)
        return
      }
      applyInsert(insertArgument(draft, menu.tokenStart, menu.tokenEnd, item.value), false)
      setMenu(null)
      return
    }

    const item = fileItems[index]
    if (!item) return
    // 目录不带空格、并且路径里没有空白时，保持菜单打开，继续选下一层
    const keepOpen = item.kind === 'dir' && !item.ignored && !/\s/.test(item.path)
    applyInsert(insertMention(draft, menu.tokenStart, menu.tokenEnd, item.path, item.kind), keepOpen)
    if (!keepOpen) setMenu(null)
    if (item.kind === 'file') void attachFile(item.path)
  }

  async function compact(): Promise<void> {
    if (!activeTabId) return
    showNotice('info', '正在压缩上下文…')
    try {
      await host.compactTab(activeTabId)
      showNotice('info', '上下文已压缩', 2500)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error))
    }
  }

  async function chooseThinking(level: ThinkingLevel): Promise<void> {
    if (!activeTabId) return
    setMenu(null)
    setDraft('')
    setNotice(null)
    try {
      await host.selectThinkingLevel(activeTabId, level)
      showNotice('info', `思考等级：${level}`, 2200)
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : String(error))
    }
  }

  async function runCodeletCommand(name: string, args = ''): Promise<void> {
    setMenu(null)
    setDraft('')
    setNotice(null)
    updateAttachments([])

    switch (name) {
      case 'new': {
        if (!cwd) {
          showNotice('error', '这个标签没有目录')
          return
        }
        void host.newConversation(cwd).catch((error) => {
          showNotice('error', error instanceof Error ? error.message : String(error))
        })
        return
      }
      case 'model': {
        if (streaming || stopping) {
          showNotice('error', '等这一轮结束再换模型')
          return
        }
        const rect = textareaRef.current?.getBoundingClientRect()
        if (rect) openPicker({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
        return
      }
      case 'rename': {
        const path = activeTab?.path
        if (!path || !conversations.some((conversation) => conversation.path === path)) {
          showNotice('error', '这个对话还没有保存到磁盘，不能改名')
          return
        }
        if (!sidebarOpen) toggleSidebar()
        requestRename(path)
        return
      }
      case 'compact': {
        if (streaming || stopping) {
          showNotice('error', '等这一轮结束再压缩')
          return
        }
        void compact()
        return
      }
      case 'reload': {
        if (streaming || stopping) {
          showNotice('error', '等这一轮结束再重新加载')
          return
        }
        if (!activeTabId) return
        setReloading(true)
        showNotice('info', '正在重新加载扩展和会话…')
        try {
          await reloadTab(activeTabId)
          // runtime 重建后命令集合可能变了；sessionId 不变时上面的 effect 不会重跑
          setPiCommands(await host.listCommands(activeTabId))
          showNotice('info', '已重新加载扩展和会话', 2500)
        } catch (error) {
          showNotice('error', error instanceof Error ? error.message : String(error))
        } finally {
          setReloading(false)
        }
        return
      }
      case 'stop': {
        stop()
        return
      }
      case 'thinking': {
        if (streaming || stopping) {
          showNotice('error', '等这一轮结束再改思考等级')
          return
        }
        if (!activeTabId) return
        let levels: ThinkingLevel[] = []
        try {
          levels = await host.listThinkingLevels(activeTabId)
        } catch (error) {
          showNotice('error', error instanceof Error ? error.message : String(error))
          return
        }
        if (levels.length === 0) {
          showNotice('error', '当前模型没有可选的思考等级')
          return
        }
        const requested = args.trim()
        if (requested) {
          if (!levels.includes(requested as ThinkingLevel)) {
            showNotice('error', `当前模型不支持 ${requested}；可选：${levels.join('、')}`)
            return
          }
          await chooseThinking(requested as ThinkingLevel)
          return
        }
        showNotice('info', `用法：/thinking <${levels.join('|')}>`, 0)
        return
      }
    }
  }

  async function send(): Promise<void> {
    const text = draft.trim()
    if (!text || !activeTabId) return
    // 有外部更新时不让发 —— runtime 是旧上下文，发出去会跟别处冲突。
    // 例外是 `/reload`：它本身就是用来从这个状态恢复的。
    const codeletCommand = parseCodeletCommand(text)
    if (stale && codeletCommand?.name !== 'reload') return

    // Codelet 自己的命令不发给模型，直接执行
    if (codeletCommand) {
      if (codeletCommand.name === 'thinking') {
        void runCodeletCommand('thinking', codeletCommand.args)
        return
      }
      if (codeletCommand.args) {
        showNotice('error', `/${codeletCommand.name} 不接受参数`)
        return
      }
      void runCodeletCommand(codeletCommand.name)
      return
    }

    const previousDraft = draft
    const previousAttachments = attachmentsRef.current
    // 以 / 开头的命令不携带附件；附件留在输入框里给下一条普通消息用
    const isSlash = text.startsWith('/')
    setDraft('')
    if (!isSlash) updateAttachments([])
    setMenu(null)
    setNotice(null)
    scrollToBottom()
    try {
      const projectPaths = previousAttachments.filter((item) => !item.uploadId).map((item) => item.path)
      const uploadIds = previousAttachments.flatMap((item) => (item.uploadId ? [item.uploadId] : []))
      await host.prompt(
        activeTabId,
        text,
        !isSlash && projectPaths.length > 0 ? projectPaths : undefined,
        !isSlash && uploadIds.length > 0 ? uploadIds : undefined
      )
    } catch (error) {
      // 发送失败（附件读不了、没有模型等）—— 用户还没开始写新内容就把草稿和附件放回去
      setDraft((current) => (current === '' ? previousDraft : current))
      if (!isSlash) {
        setAttachments((current) => {
          const next = current.length === 0 ? previousAttachments : current
          attachmentsRef.current = next
          return next
        })
      }
      showNotice('error', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * 中止这一轮。
   *
   * 不等它返回再改界面 —— `abort()` 可能要等好几秒（工具在执行），
   * 期间由主进程推的 `aborting` 驱动「停止中」。
   */
  function stop(): void {
    // 看 `aborting` 而不是 `stopping`：后者是延迟显示的状态，
    // 在延迟期内它是 false，但实例上已经在中止了 —— 那会儿不该再发一次。
    if (!activeTabId || aborting) return
    void host.abortPrompt(activeTabId)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface">
      {/*
        顶上留 12px：这条留白在滚动容器外面，不跟着内容滚走 ——
        内容往上滚时，文字离卡片上沿始终还有这一段距离。
        滚动容器自己给的 padding 做不到（跟着内容一起滚走）。
      */}
      <div className={`relative min-h-0 flex-1 pt-3 ${hasNav ? 'conv-has-nav' : ''}`}>
        <ConversationNav items={items} mode={mode} scrollRef={scrollRef} />
        {mode === 'normal' &&
          (items.length > 0 ? (
            <div className="conv-normal" ref={setRef}>
              <NormalStream items={items} streaming={streaming} tabId={activeTabId} />
            </div>
          ) : (
            <div className="conv-normal" ref={setRef}>
              <div className="placeholder">
                <div>普通模式 · 气泡消息流</div>
                <div className="text-[11.5px]">这个对话还没说过话</div>
              </div>
            </div>
          ))}

        {mode === 'terminal' &&
          (items.length > 0 ? (
            <div className="conv-terminal" ref={setRef}>
              <TerminalStream items={items} streaming={streaming} tabId={activeTabId} />
            </div>
          ) : (
            <div className="conv-terminal" ref={setRef}>
              <div className="placeholder font-sans">
                <div>终端模式 · 等宽执行流</div>
                <div className="text-[11.5px]">这个对话还没说过话</div>
              </div>
            </div>
          ))}

        {mode === 'html' && (
          <div className="conv-html" ref={setRef}>
            <div className="placeholder">
              <div>HTML 模式 · 这一轮留空</div>
              <div className="text-[11.5px]">它不是排版，是 skill 的产物</div>
            </div>
          </div>
        )}
      </div>

      <footer className="conv-footer flex-none pb-5 pt-2">
        <div className="relative mx-auto w-full max-w-[var(--content-max)]">
          {/*
            这个会话在别处被改过 —— 显眼地提示，并且挡住输入。
            不用自动同步：重建 runtime 会丢掉当前状态，而且别处还在写的话重建完很快又落后。
          */}
          {stale && (
            <div
              className="mb-2 flex items-center gap-2.5 rounded-xl border border-warn/40 bg-warn-wash px-3 py-1.5"
              title="这个会话在别处有更新（比如在终端里聊过）。这边的上下文还是旧的，重新加载之前不能继续输入。"
            >
              <span className="flex-none text-[12px] text-warn">▲</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2">这个会话在别处有更新</span>
              <button
                type="button"
                disabled={reloading}
                onClick={() => {
                  if (!activeTabId) return
                  setReloading(true)
                  void reloadTab(activeTabId).finally(() => setReloading(false))
                }}
                className="flex-none rounded-lg bg-warn px-2.5 py-0.5 text-[11.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
              >
                {reloading ? '加载中…' : '重新加载'}
              </button>
            </div>
          )}

          {notice && (
            <div
              role={notice.kind === 'error' ? 'alert' : 'status'}
              style={notice.kind === 'error' ? { borderColor: 'var(--danger-line)' } : undefined}
              className={[
                'mb-2 rounded-xl border px-3 py-1.5 text-[12px]',
                notice.kind === 'error'
                  ? 'bg-danger-wash text-danger'
                  : 'border-hairline bg-sunken text-fg-2'
              ].join(' ')}
            >
              {notice.text}
            </div>
          )}

          {/* 现阶段只有普通模式有这个钮（PLAN.md D14）；钉在内容列右下角、输入卡上方 */}
          {mode === 'normal' && (
            <ScrollJump scrollable={scrollable} atBottom={atBottom} onJump={jumpTo} />
          )}

          {/* `/` 命令面板与 `@` 文件引用面板；贴在输入卡上方 */}
          {menu && (
            <div
              ref={menuRef}
              className="absolute bottom-full left-0 right-0 z-50 mb-2 rounded-xl border border-hairline bg-raised p-1"
              style={{ boxShadow: 'var(--sh-md)' }}
            >
              <div
                id="composer-menu"
                role="listbox"
                aria-label={
                  menu.kind === 'command' ? '命令' : menu.kind === 'argument' ? '命令参数' : '引用文件'
                }
                className="max-h-[260px] overflow-y-auto"
              >
                {menu.kind === 'argument' ? (
                  <>
                    {argumentLoading && <div className="px-2.5 py-2 text-[11.5px] text-fg-3">加载参数…</div>}
                    {argumentError && <div className="px-2.5 py-2 text-[11.5px] text-danger">{argumentError}</div>}
                    {!argumentLoading && !argumentError && argumentItems.length === 0 && (
                      <div className="px-2.5 py-3 text-[11.5px] text-fg-3">
                        {menu.commandName === 'thinking' ? '当前没有可选的思考等级' : '没有匹配的参数'}
                      </div>
                    )}
                    {argumentItems.map((item, index) => (
                      <button
                        key={`${index}:${item.value}`}
                        id={`composer-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === menu.active}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() =>
                          setMenu((current) => (current ? { ...current, active: index } : current))
                        }
                        onClick={() => selectItem(index)}
                        className={[
                          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                          index === menu.active ? 'bg-accent-wash' : 'hover:bg-sunken'
                        ].join(' ')}
                      >
                        <span className="w-3.5 flex-none text-[11px] text-ok">
                          {menu.commandName === 'thinking' && session.thinkingLevel === item.value ? '✓' : ''}
                        </span>
                        <span className="flex-none font-mono text-[12.5px] text-fg-1">{item.label}</span>
                        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-3">
                          {item.description ?? ''}
                        </span>
                        {item.value !== item.label && (
                          <span className="flex-none font-mono text-[10px] text-fg-3">{item.value}</span>
                        )}
                      </button>
                    ))}
                  </>
                ) : menu.kind === 'command' ? (
                  commandItems.length === 0 ? (
                    <div className="px-2.5 py-3 text-[11.5px] text-fg-3">没有匹配的命令</div>
                  ) : (
                    commandItems.map((command, index) => (
                      <button
                        key={`${command.source}:${command.name}`}
                        id={`composer-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === menu.active}
                        aria-disabled={command.disabled || undefined}
                        title={command.disabled ? command.disabledReason : undefined}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() =>
                          setMenu((current) => (current ? { ...current, active: index } : current))
                        }
                        onClick={() => selectItem(index)}
                        className={[
                          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                          index === menu.active ? 'bg-accent-wash' : '',
                          command.disabled ? 'cursor-default opacity-50' : 'hover:bg-sunken'
                        ].join(' ')}
                      >
                        <span className="flex-none font-mono text-[12.5px] text-fg-1">/{command.name}</span>
                        {command.argumentHint && (
                          <span className="flex-none font-mono text-[10.5px] text-fg-3">
                            {command.argumentHint}
                          </span>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[11px] text-fg-3">
                          {command.description ?? ''}
                        </span>
                        <span className="flex-none rounded bg-sunken px-1.5 py-0.5 text-[9.5px] text-fg-3">
                          {COMMAND_SOURCE_LABEL[command.source]}
                        </span>
                      </button>
                    ))
                  )
                ) : (
                  <>
                    {fileLoading && <div className="px-2.5 py-2 text-[11.5px] text-fg-3">搜索中…</div>}
                    {fileError && <div className="px-2.5 py-2 text-[11.5px] text-danger">{fileError}</div>}
                    {!fileLoading && !fileError && fileItems.length === 0 && (
                      <div className="px-2.5 py-3 text-[11.5px] text-fg-3">没有匹配的文件</div>
                    )}
                    {fileItems.map((item, index) => (
                      <button
                        key={item.path}
                        id={`composer-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === menu.active}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() =>
                          setMenu((current) => (current ? { ...current, active: index } : current))
                        }
                        onClick={() => selectItem(index)}
                        className={[
                          'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                          index === menu.active ? 'bg-accent-wash' : 'hover:bg-sunken',
                          item.ignored ? 'opacity-60' : ''
                        ].join(' ')}
                      >
                        <span className="flex-none text-[11px] text-fg-3">
                          {item.kind === 'dir' ? '▸' : '·'}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-1">
                          {item.path}
                          {item.kind === 'dir' ? '/' : ''}
                        </span>
                        {item.ignored && <span className="flex-none text-[9.5px] text-fg-3">忽略</span>}
                      </button>
                    ))}
                  </>
                )}
              </div>
              <div className="mt-1 flex items-center gap-3 border-t border-hairline px-2.5 py-1.5 text-[10.5px] text-fg-3">
                <span>↑↓ 选择</span>
                <span>↵ 确认</span>
                <span>Esc 关闭</span>
                <span className="ml-auto">
                  {menu.kind === 'argument'
                    ? menu.commandName === 'thinking'
                      ? '选择思考等级'
                      : `/${menu.commandName} 参数`
                    : menu.kind === 'command' && (streaming || stopping) && extensionCommandNames.size > 0
                      ? '扩展命令可在生成中执行'
                      : menu.kind === 'command'
                        ? '/name 过滤'
                        : '@path 过滤'}
                </span>
              </div>
            </div>
          )}

          <div className="rounded-[18px] border border-hairline bg-raised p-3 shadow-[var(--sh-md)] transition-colors focus-within:border-hairline-strong">
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1 px-1">
                {attachments.map((item) => (
                  <span
                    key={attachmentKey(item)}
                    className="flex min-w-0 items-center gap-1 rounded-full border border-hairline bg-sunken py-0.5 pl-2 pr-1 text-[10.5px] text-fg-2"
                  >
                    <span className="flex-none text-fg-3">{item.kind === 'image' ? '▧' : '▤'}</span>
                    <span
                      className="min-w-0 max-w-[220px] truncate"
                      title={`${attachmentLabel(item)} · ${formatBytes(item.size)} · 约 ${item.tokens} tokens（估算）`}
                    >
                      {attachmentLabel(item)}
                    </span>
                    <span className="flex-none font-mono text-[9px] text-fg-3">
                      {formatBytes(item.size)}
                    </span>
                    <span className="flex-none font-mono text-[9px] text-fg-3">
                      {formatTokenEstimate(item.tokens)}
                    </span>
                    <button
                      type="button"
                      aria-label={`移除附件「${attachmentLabel(item)}」`}
                      title="移除附件"
                      onClick={() => removeAttachment(item)}
                      className="flex h-4 w-4 flex-none items-center justify-center rounded-full text-fg-3 transition-colors hover:bg-danger-wash hover:text-danger"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <span
                  className="ml-auto flex-none px-1 text-[9.5px] text-fg-3"
                  title="token 是估算值，实际以模型的 tokenizer 为准"
                >
                  共 {attachments.length} 个 · {formatBytes(attachments.reduce((sum, item) => sum + item.size, 0))} ·{' '}
                  {formatTokenEstimate(attachments.reduce((sum, item) => sum + item.tokens, 0))}
                </span>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                const value = event.target.value
                setDraft(value)
                syncAttachmentsWithDraft(value)
                refreshMenu(value, event.target.selectionStart ?? value.length)
              }}
              onSelect={() => refreshMenu()}
              onClick={() => refreshMenu()}
              onKeyUp={(event) => {
                // 只处理方向键/Home/End 这类「光标移动」；Esc/Enter 的 keyup 不能重开菜单
                if (
                  event.key === 'ArrowLeft' ||
                  event.key === 'ArrowRight' ||
                  event.key === 'ArrowUp' ||
                  event.key === 'ArrowDown' ||
                  event.key === 'Home' ||
                  event.key === 'End'
                ) {
                  refreshMenu()
                }
              }}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={() => {
                composing.current = false
                composeEndedAt.current = Date.now()
              }}
              onKeyDown={(event) => {
                /*
                 * 输入法相关的按键一律不处理：
                 * - 正在组词（`composing` / `isComposing`）
                 * - 刚结束组词 80ms 内 —— 覆盖「compositionend 之后才发 keydown」的输入法
                 *
                 * Enter 被当成发送会把半句话发出去；Esc 被当成停止会把打了一半的
                 * 中文吞掉（输入法用 Esc 取消本次输入）。两个坑是同一类。
                 */
                const composingNow = () =>
                  composing.current ||
                  event.nativeEvent.isComposing ||
                  Date.now() - composeEndedAt.current < 80

                if (composingNow()) return

                // 菜单开着时，方向键 / Enter / Tab / Esc 先归菜单
                if (menu) {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    if (menuCount === 0) return
                    const delta = event.key === 'ArrowDown' ? 1 : -1
                    setMenu((current) =>
                      current
                        ? { ...current, active: (current.active + delta + menuCount) % menuCount }
                        : current
                    )
                    return
                  }
                  if (event.key === 'Enter' && !event.shiftKey) {
                    // 有候选项就选；没有就关掉菜单，让这一下 Enter 当普通发送
                    if (menuCount > 0) {
                      event.preventDefault()
                      selectItem(menu.active)
                      return
                    }
                    setMenu(null)
                  } else if (event.key === 'Tab') {
                    event.preventDefault()
                    if (menuCount > 0) selectItem(menu.active)
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    setMenu(null)
                    return
                  }
                }

                // Esc：中止这一轮。只在有东西在跑的时候有意义
                if (event.key === 'Escape') {
                  if (!streaming) return
                  event.preventDefault()
                  stop()
                  return
                }

                if (event.key !== 'Enter') return
                // Shift+Enter 换行，交给 textarea 自己处理（不 preventDefault）
                if (event.shiftKey) return

                if (streaming || stopping) {
                  // Codelet 本地动作：/stop、/new、/rename
                  if (parseCodeletCommand(draft.trim())) {
                    event.preventDefault()
                    void send()
                    return
                  }
                  const name = commandNameOf(draft)
                  // 扩展命令在 Pi 里先于 streaming 检查执行 —— 放行
                  if (name && extensionCommandNames.has(name)) {
                    event.preventDefault()
                    void send()
                    return
                  }
                  // 模板 / 技能要展开成 prompt，仍然得等
                  if (name && blockedCommandNames.has(name)) {
                    showNotice('info', '这个命令要等这一轮结束再发')
                  }
                  return
                }

                event.preventDefault()
                void send()
              }}
              rows={2}
              disabled={stale}
              placeholder={stale ? '先点上面的「重新加载」' : '说点什么…（/ 命令，@ 引用文件）'}
              aria-expanded={Boolean(menu)}
              aria-controls={menu ? 'composer-menu' : undefined}
              aria-autocomplete="list"
              aria-activedescendant={menu && menuCount > 0 ? `composer-option-${menu.active}` : undefined}
              className="min-h-[52px] w-full resize-none border-0 bg-transparent px-2 pt-1 text-[14.5px] leading-6 text-fg-1 outline-none placeholder:text-fg-3 disabled:cursor-not-allowed disabled:opacity-60"
            />

            <div className="mt-1 flex items-center gap-3 px-2">
              {/*
                上传文件和图片：打开系统选择器。文件只留在主进程，
                渲染层拿到 id 和元信息；发送时只回传 id。
              */}
              <button
                type="button"
                disabled={!activeTabId || stale || uploading}
                onClick={() => void pickUploads()}
                aria-label="上传文件或图片"
                aria-busy={uploading}
                title={uploading ? '正在选择文件…' : '上传文件或图片'}
                className="grid h-6 w-6 flex-none place-items-center rounded-full text-fg-3 transition-colors hover:bg-sunken hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <IconPaperclip />
              </button>

              {/*
                模型：显示与切换的唯一位置（换模型是「准备发下一条」时做的决定）。
                生成中禁用 —— 本轮的模型已经定了，要换得等这轮结束。
              */}
              <button
                type="button"
                disabled={streaming || stale || !session.model}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect()
                  openPicker({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
                }}
                title={session.model ? `${session.model.provider}/${session.model.id}` : '未选模型'}
                className="conv-model flex min-w-0 max-w-[230px] items-center gap-1 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] text-fg-2 transition-colors hover:border-hairline-strong hover:bg-panel hover:text-fg-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex-none text-fg-3">◇</span>
                <span className="conv-model-name min-w-0 truncate font-mono">
                  {session.model ? session.model.name : '未选模型'}
                </span>
                <span className="conv-model-caret flex-none text-fg-3">▾</span>
              </button>
              {/*
                提示文字跟着**按钮**的状态走，不跟着 streaming。
                两者在「最短停留」那段时间里不一致（streaming 已经 false，
                但 stopping 还在撑）—— 跟着 streaming 的话会出现「按钮在转圈、
                提示却说可以发」的矛盾。
              */}
              <span className="conv-hint flex-none text-[11.5px] text-fg-3">
                {stopping ? '正在停止…' : streaming ? 'Esc 停止 · ⇧↵ 换行' : '↵ 发送 · ⇧↵ 换行'}
              </span>
              {session.error && (
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-danger" title={session.error}>
                  {session.error}
                </span>
              )}
              {streaming || stopping ? (
                <button
                  type="button"
                  onClick={stop}
                  disabled={stopping}
                  aria-label="停止"
                  title={stopping ? '正在停止…' : '停止（Esc）'}
                  className={`ml-auto grid h-8 w-8 flex-none place-items-center rounded-full bg-accent text-accent-fg transition-opacity hover:bg-accent-hover disabled:cursor-not-allowed ${stopping ? 'opacity-45' : ''}`}
                >
                  {stopping ? <span className="conv-stop-ring" aria-hidden="true" /> : <IconStop />}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={!draft.trim() || stale}
                  aria-label="发送"
                  title="发送"
                  className="ml-auto grid h-8 w-8 flex-none place-items-center rounded-full bg-accent text-accent-fg transition-opacity hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconArrowUp />
                </button>
              )}
            </div>
          </div>
        </div>
      </footer>
    </section>
  )
}
