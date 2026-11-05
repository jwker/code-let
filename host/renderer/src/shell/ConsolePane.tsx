import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConsoleExportProgress,
  ConsoleItemSkeleton,
  ConsoleRecordMeta,
  ConsoleShell,
  ConsoleStats
} from '@contract/index'
import { host } from '../host'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * 右侧检视器的调试控制台。
 *
 * 列表在窄面板里，详情是一层覆盖主区的抽屉 —— 一次请求的 transcript 动辄几百 KB，
 * 340px 的面板放不下全文。
 *
 * 内容按需取：索引里已经有每个节点的骨架，所以展开一级节点不用等；
 * 点某一条消息才去读那一条的正文。
 */

const NODES = [
  { key: 'meta', label: 'meta', note: '这条记录的基本信息：时间、会话、模型、状态码。' },
  { key: 'transcript', label: 'transcript', note: 'Pi 侧拼好的上下文，含系统消息、对话消息、工具调用与工具结果。' },
  { key: 'provider', label: 'provider', note: 'provider 真正收到的原始请求体。' },
  { key: 'response', label: 'response', note: 'provider 的状态码、响应头，以及最终那条助手消息。' }
] as const

type NodeKey = (typeof NODES)[number]['key']

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}

/**
 * 一行显示的标题 —— 这次请求本身。
 *
 * 优先用触发这次请求的那条用户消息（同一个会话里的多次请求靠它区分），
 * 没有就退回会话名。
 */
function labelOf(record: ConsoleRecordMeta): string {
  return record.prompt ?? sessionLabelOf(record)
}

/**
 * 会话名（筛选器、跨会话时显示的那个）。
 *
 * 有会话标题就用标题（自定义名字或首条用户消息），
 * 标题推不出来时用项目目录名兼底。
 */
function sessionLabelOf(record: ConsoleRecordMeta): string {
  if (record.sessionTitle) return record.sessionTitle
  const project = record.cwd ? dirName(record.cwd) : ''
  return project ? `未命名会话 · ${project}` : '未命名会话'
}

/** 目录路径的最后一段 —— 渲染进程里没有 node:path，自己切一下 */
function dirName(path: string): string {
  const parts = path.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] ?? ''
}

/** 耗时的写法：不到一秒用毫秒，超过一秒用秒 */
function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一个已经取回来的字段 */
interface LoadedField {
  path: string
  shell?: ConsoleShell
  value?: unknown
  oversize?: boolean
  bytes?: number
  error?: string
}

export function ConsolePane({ detached = false }: { detached?: boolean }) {
  const [records, setRecords] = useState<ConsoleRecordMeta[]>([])
  const [stats, setStats] = useState<ConsoleStats | null>(null)
  const [sessionFilter, setSessionFilter] = useState<string>('')
  const [query, setQuery] = useState('')
  const [checkedIds, setSelectedIds] = useState<string[]>([])
  const [selected, setSelected] = useState<ConsoleRecordMeta | null>(null)
  const [node, setNode] = useState<NodeKey>('transcript')
  const [fields, setFields] = useState<Record<string, LoadedField>>({})
  const [confirm, setConfirm] = useState<null | {
    title: string
    body: string
    run: () => Promise<void>
  }>(null)
  const [exportProgress, setExportProgress] = useState<ConsoleExportProgress | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const listSeq = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const seq = ++listSeq.current
    try {
      const [list, nextStats] = await Promise.all([
        host.listConsoleRecords(),
        host.getConsoleStats()
      ])
      if (seq !== listSeq.current) return
      setRecords(list.records)
      setStats(nextStats)
    } catch (error) {
      if (seq === listSeq.current) {
        setMessage(error instanceof Error ? error.message : String(error))
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 有新记录落盘就刷新列表 —— 存储那边会推事件过来
  useEffect(() => {
    return host.onConsoleEvent((event) => {
      if (event.type === 'updated') {
        void load()
        return
      }
      if (event.type === 'export') {
        setExportProgress(event.progress)
      }
    })
  }, [load])

  /** 会话 → 显示名（取该会话里第一条记录的会话标题） */
  const sessions = useMemo(() => {
    const map = new Map<string, string>()
    for (const record of records) {
      if (!map.has(record.sessionId)) {
        map.set(record.sessionId, sessionLabelOf(record))
      }
    }
    return [...map.entries()]
  }, [records])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return records.filter((record) => {
      if (sessionFilter && record.sessionId !== sessionFilter) return false
      if (!keyword) return true
      return (
        labelOf(record).toLowerCase().includes(keyword) ||
        record.prompt?.toLowerCase().includes(keyword) ||
        record.model?.id.toLowerCase().includes(keyword) ||
        record.sessionId.toLowerCase().includes(keyword)
      )
    })
  }, [records, sessionFilter, query])

  /** 列出来的记录跨了几个会话 —— 跨会话时每行才带上会话名 */
  const multiSession = useMemo(
    () => new Set(visible.map((record) => record.sessionId)).size > 1,
    [visible]
  )

  /** 打开一条记录：先取一级节点的骨架 */
  const open = useCallback(async (record: ConsoleRecordMeta): Promise<void> => {
    setSelected(record)
    setFields({})
    setNode('transcript')
    await loadField(record.id, 'transcript')
  }, [])

  const loadField = useCallback(async (recordId: string, path: string): Promise<void> => {
    const result = await host.getConsoleField(recordId, path)
    setFields((previous) => ({
      ...previous,
      [path]: {
        path,
        shell: result?.shell,
        value: result?.value,
        oversize: result?.oversize,
        bytes: result?.bytes,
        error: result?.error
      }
    }))
  }, [])

  const switchNode = useCallback(
    async (key: NodeKey): Promise<void> => {
      setNode(key)
      if (!selected) return
      if (fields[key]) return
      await loadField(selected.id, key)
    },
    [selected, fields, loadField]
  )

  const removeRecord = useCallback(
    async (record: ConsoleRecordMeta): Promise<void> => {
      await host.deleteConsoleRecord(record.id)
      setSelected(null)
      await load()
    },
    [load]
  )

  const removeSelected = useCallback(
    async (ids: string[]): Promise<void> => {
      const result = await host.deleteConsoleRecords(ids)
      setSelectedIds([])
      await load()
      setMessage(`已删除 ${result.deleted} 条记录`)
    },
    [load]
  )

  /** 勾选 / 取消勾选一条 */
  const toggleSelect = useCallback((id: string): void => {
    setSelectedIds((previous) =>
      previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]
    )
  }, [])

  const exportRecords = useCallback(
    async (scope: 'record' | 'records' | 'sessions' | 'all', ids?: string[]): Promise<void> => {
      setExportProgress({
        jobId: '',
        state: 'running',
        done: 0,
        total: 0,
        bytes: 0
      })
      const result = await host.exportConsole({
        scope,
        ...(scope === 'record' && ids?.[0] ? { recordId: ids[0] } : {}),
        ...(scope === 'records' ? { recordIds: ids ?? [] } : {}),
        ...(scope === 'sessions'
          ? { sessionIds: sessionFilter ? [sessionFilter] : sessions.map(([id]) => id) }
          : {})
      })
      if (result.cancelled) {
        setExportProgress(null)
        return
      }
      if (!result.ok) {
        setExportProgress(null)
        setMessage(result.message ?? '导出失败')
        return
      }
      setMessage(`已导出到 ${result.path}`)
    },
    [sessionFilter, sessions]
  )

  const selectedSession = selected ? sessions.find(([id]) => id === selected.sessionId) : null

  return (
    <div className="insp-body">
      {!selected && (
      <div className="flex min-h-0 flex-1 flex-col">
        <header
          className={[
            'flex flex-none items-center px-3 text-[13px] font-medium text-fg-1',
            detached ? 'h-8' : 'h-10 border-b border-hairline'
          ].join(' ')}
        >
          {detached ? null : '控制台'}
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              title="全选当前列出的记录"
              className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-sunken hover:text-fg-1"
              onClick={() => {
                const ids = visible.map((record) => record.id)
                setSelectedIds((previous) =>
                  ids.length > 0 && ids.every((id) => previous.includes(id)) ? [] : ids
                )
              }}
            >
              {visible.length > 0 && visible.every((record) => checkedIds.includes(record.id))
                ? '取消全选'
                : '全选'}
            </button>
            <button
              type="button"
              title="打开存储目录"
              className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-sunken hover:text-fg-1"
              onClick={() => void host.revealConsoleDir()}
            >
              目录
            </button>
            {!detached && (
              <button
                type="button"
                title="分离成独立窗口"
                className="rounded-md px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-sunken hover:text-fg-1"
                onClick={() => void host.openConsoleWindow()}
              >
                分离
              </button>
            )}
          </div>
        </header>

        <div className="flex-none px-3 pb-2 text-[11px] text-fg-3">
          {stats ? (
            <span>
              <span className="text-fg-2">{stats.count}</span> 条 ·{' '}
              <span className="text-fg-2">{formatBytes(stats.totalBytes)}</span>
              {stats.writing > 0 ? ' · 写入中…' : ''}
              {stats.failed > 0 ? ` · 失败 ${stats.failed} 条` : ''}
            </span>
          ) : (
            '读取中…'
          )}
        </div>

        <div className="flex flex-none gap-1.5 px-3 pb-2">
          <select
            value={sessionFilter}
            onChange={(event) => setSessionFilter(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-hairline bg-surface px-1.5 py-0.5 text-[11px] text-fg-2"
          >
            <option value="">全部会话</option>
            {sessions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索提示 / 会话 / 模型"
            className="min-w-0 flex-1 rounded-md border border-hairline bg-sunken px-1.5 py-0.5 text-[11px] text-fg-2 placeholder:text-fg-3"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-fg-3">
              {records.length === 0 ? '还没有记录' : '没有匹配的记录'}
            </div>
          ) : (
            visible.map((record) => {
              const checked = checkedIds.includes(record.id)
              return (
                <div
                  key={record.id}
                  className={[
                    'flex items-start gap-1.5 border-b border-hairline px-2 py-2',
                    checked ? 'bg-accent-wash' : 'hover:bg-sunken'
                  ].join(' ')}
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    aria-label={`选中 ${labelOf(record)} ${formatTime(record.capturedAt)}`}
                    onClick={() => toggleSelect(record.id)}
                    className={[
                      'mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded border text-[10px]',
                      checked
                        ? 'border-fg-1 bg-fg-1 text-accent-fg'
                        : 'border-hairline-strong bg-surface text-transparent'
                    ].join(' ')}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    onClick={() => void open(record)}
                    className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                  >
                    <div className="flex items-center gap-2 text-[11.5px]">
                      <span className="font-mono text-[10.5px] text-fg-2">
                        {formatTime(record.capturedAt)}
                      </span>
                      {record.requestNo !== undefined && (
                        <span className="shrink-0 font-mono text-[10px] text-fg-3">
                          第{record.requestNo}次
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-fg-1">
                        {record.prompt ?? labelOf(record)}
                      </span>
                      {record.durationMs !== null && (
                        <span className="font-mono text-[10px] text-fg-3">
                          {formatDuration(record.durationMs)}
                        </span>
                      )}
                      {record.providerStatus !== null && (
                        <span
                          className={
                            record.providerStatus >= 400
                              ? 'font-mono text-[10px] text-danger'
                              : 'font-mono text-[10px] text-ok'
                          }
                        >
                          {record.providerStatus}
                        </span>
                      )}
                    </div>
                    <div
                      className="flex items-center gap-1 truncate text-[10.5px] text-fg-3"
                      title="transcript / provider payload / 响应，各占多少"
                    >
                      {multiSession && (
                        <span className="shrink-0 text-fg-3">{sessionLabelOf(record)} ·</span>
                      )}
                      <span className="shrink-0 font-mono">
                        {formatBytes(record.sizes.transcript)} / {formatBytes(record.sizes.provider)} /{' '}
                        {formatBytes(record.sizes.response)}
                      </span>
                      {record.truncated && <span className="shrink-0 text-warn">· 已降级</span>}
                    </div>
                  </button>
                </div>
              )
            })
          )}
        </div>

        {checkedIds.length > 0 && (
          <div className="flex flex-none items-center gap-2 border-t border-hairline bg-panel px-3 py-2">
            <span className="text-[11.5px] text-fg-2">
              已选 <span className="font-mono text-fg-1">{checkedIds.length}</span> 条
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void exportRecords('records', checkedIds)}
                className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-fg-2 hover:text-fg-1"
              >
                导出所选
              </button>
              <button
                type="button"
                onClick={() =>
                  setConfirm({
                    title: `删除选中的 ${checkedIds.length} 条记录？`,
                    body: '删完不可恢复。已经导出的包不受影响。',
                    run: () => removeSelected(checkedIds)
                  })
                }
                className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-danger hover:bg-danger-wash"
              >
                删除所选
              </button>
            </div>
          </div>
        )}
      </div>
      )}

      {message && (
        <div className="flex-none border-t border-hairline px-3 py-1.5 text-[11px] text-fg-3">
          {message}
        </div>
      )}

      {selected && (
        <ConsoleDetail
          record={selected}
          node={node}
          fields={fields}
          exportProgress={exportProgress}
          sessionName={selectedSession?.[1] ?? '未命名会话'}
          onClose={() => setSelected(null)}
          onSwitchNode={(key) => void switchNode(key)}
          onLoadField={(path) => void loadField(selected.id, path)}
          onExport={() => void exportRecords('record', [selected.id])}
          onDelete={() =>
            setConfirm({
              title: '删除这次请求的记录？',
              body: `${formatDate(selected.capturedAt)} ${formatTime(selected.capturedAt)} · ${
                selected.model?.id ?? '未知模型'
              }\n删除后不可恢复。已经导出的包不受影响。`,
              run: () => removeRecord(selected)
            })
          }
        />
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmText="删除"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const run = confirm.run
            setConfirm(null)
            void run()
          }}
        />
      )}
    </div>
  )
}

/** 详情：就在右侧面板里，不盖住主区 */
function ConsoleDetail({
  record,
  node,
  fields,
  exportProgress,
  sessionName,
  onClose,
  onSwitchNode,
  onLoadField,
  onExport,
  onDelete
}: {
  record: ConsoleRecordMeta
  node: NodeKey
  fields: Record<string, LoadedField>
  exportProgress: ConsoleExportProgress | null
  sessionName: string
  onClose: () => void
  onSwitchNode: (key: NodeKey) => void
  onLoadField: (path: string) => void
  onExport: () => void
  onDelete: () => void
}) {
  const current = fields[node]
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 flex-none items-center gap-2 border-b border-hairline px-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-hairline px-1.5 py-0.5 text-[11.5px] text-fg-2 hover:text-fg-1"
        >
          ‹ 列表
        </button>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg-1">{sessionName}</span>
        <button
          type="button"
          title="导出这一条"
          onClick={onExport}
          className="rounded-md border border-hairline px-1.5 py-0.5 text-[11px] text-fg-2 hover:text-fg-1"
        >
          导出
        </button>
        <button
          type="button"
          title="删除这一条"
          onClick={onDelete}
          className="rounded-md border border-hairline px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger-wash"
        >
          删除
        </button>
      </div>

      <div className="flex-none truncate border-b border-hairline px-3 py-1 font-mono text-[10.5px] text-fg-3">
        {formatDate(record.capturedAt)} {formatTime(record.capturedAt)} · {record.model?.id ?? '未知模型'}
        {record.durationMs !== null ? ` · ${formatDuration(record.durationMs)}` : ''} ·{' '}
        {formatBytes(record.sizes.transcript + record.sizes.provider + record.sizes.response)}
      </div>

      <div className="flex flex-none gap-0.5 overflow-x-auto border-b border-hairline px-2 pt-1.5">
        {NODES.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => onSwitchNode(item.key)}
            className={[
              'flex flex-none items-center gap-1 rounded-t-md border-b-2 px-2 py-1 text-[11.5px]',
              node === item.key
                ? 'border-fg-1 font-semibold text-fg-1'
                : 'border-transparent text-fg-2 hover:text-fg-1'
            ].join(' ')}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        className="flex-none truncate border-b border-hairline px-3 py-1 text-[10.5px] leading-snug text-fg-3"
        title={NODES.find((item) => item.key === node)?.note}
      >
        {NODES.find((item) => item.key === node)?.label} · {formatBytes(record.sizes[node])} ·{' '}
        {NODES.find((item) => item.key === node)?.note}
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-sunken p-2.5">
        {exportProgress && exportProgress.state === 'running' && (
          <div className="mb-2 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-[11px] text-fg-2">
            {exportProgress.total === 0
              ? '准备导出…'
              : `正在导出 · ${exportProgress.done} / ${exportProgress.total} · ${formatBytes(exportProgress.bytes)}`}
          </div>
        )}
        {current?.error && <div className="text-[11.5px] text-warn">{current.error}</div>}
        {current?.oversize && (
          <div className="text-[11.5px] text-warn">
            这一块有 {formatBytes(current.bytes ?? 0)}，太大不进界面 —— 导出后自己看。
          </div>
        )}
        {current?.shell && <ShellView shell={current.shell} onOpen={onLoadField} loaded={fields} />}
        {current?.value !== undefined && (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-2">
            {JSON.stringify(current.value, null, 2)}
          </pre>
        )}
        {!current && <div className="text-[11.5px] text-fg-3">读取中…</div>}
      </div>
    </div>
  )
}

/** 骨架：一级节点的字段 + 被拆开的数组 */
function ShellView({
  shell,
  onOpen,
  loaded
}: {
  shell: ConsoleShell
  onOpen: (path: string) => void
  loaded: Record<string, LoadedField>
}) {
  const entries = Object.entries(shell.fields ?? {})
  return (
    <div className="font-mono text-[11.5px] leading-relaxed">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <span className="shrink-0 text-fg-1">{key}</span>
          <span className="min-w-0 break-words text-fg-2">{formatValue(value)}</span>
        </div>
      ))}
      {shell.array && (
        <div className="mt-1">
          <div className="text-fg-1">
            {shell.array.key} <span className="text-fg-3">（{shell.array.count} 条）</span>
          </div>
          <div className="ml-2 border-l border-hairline pl-2">
            {shell.array.items.map((item) => (
              <ItemRow
                key={item.index}
                item={item}
                path={`${shell.path}.${shell.array!.key}[${item.index}]`}
                loaded={loaded}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      )}
      {shell.items && shell.items.length > 0 && (
        <div className="ml-2 border-l border-hairline pl-2">
          {shell.items.map((item) => (
            <ItemRow
              key={`standalone-${item.index}`}
              item={item}
              path={`${shell.path}.message`}
              loaded={loaded}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 数组里的一条：默认闭合，点开才去取正文 */
function ItemRow({
  item,
  path,
  loaded,
  onOpen
}: {
  item: ConsoleItemSkeleton
  path: string
  loaded: Record<string, LoadedField>
  onOpen: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  const field = loaded[path]
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next && !field) onOpen(path)
        }}
        className="flex w-full items-center gap-2 text-left text-fg-2 hover:text-fg-1"
      >
        <span className="w-2 shrink-0 text-[9px] text-fg-3">{open ? '▼' : '▶'}</span>
        <span className="shrink-0 text-fg-1">{path.split('.').pop()}</span>
        {item.role && <span className="shrink-0 text-ok">"{item.role}"</span>}
        <span className="min-w-0 flex-1 truncate text-fg-3">{item.preview}</span>
        <span className="shrink-0 text-[10px] text-fg-3">{formatBytes(item.bytes)}</span>
      </button>
      {open && (
        <div className="ml-4 border-l border-hairline pl-2">
          {field?.error && <div className="text-[11px] text-warn">{field.error}</div>}
          {field?.oversize && (
            <div className="text-[11px] text-warn">
              这一条有 {formatBytes(field.bytes ?? 0)}，太大不进界面 —— 导出后自己看。
            </div>
          )}
          {field?.shell && <ShellView shell={field.shell} onOpen={onOpen} loaded={loaded} />}
          {field?.value !== undefined && (
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-2">
              {JSON.stringify(field.value, null, 2)}
            </pre>
          )}
          {field && !field.error && !field.oversize && field.value === undefined && !field.shell && (
            <div className="text-[11px] text-fg-3">读取中…</div>
          )}
        </div>
      )}
    </div>
  )
}

/** 字段值怎么显示 */
function formatValue(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'string') return `"${value}"`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}
