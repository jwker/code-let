import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AGENT_COLORS,
  AGENT_COLOR_LABEL,
  AGENT_TYPE_LIMITS,
  UNKNOWN_AGENT_TYPE_LABEL,
  UNKNOWN_AGENT_TYPE_NAME,
  charCount,
  leastUsedColor,
  validateTypeDraft,
  type AgentTypeDef,
  type AgentTypeDraft
} from '@contract/index'
import { host } from '../host'
import { AgentAvatar } from './AgentAvatar'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * 全局设置里的「agent 类型」面板（ADR-0004）。
 *
 * 左边是列表：内置三个置顶且顺序固定，自定义 agent 按创建顺序；底部「新建」。
 * 右边是编辑区：自定义 agent 的名字、说明、颜色、提示词都能改；内置三个只开放提示词，
 * 其余字段显示成只读文本并注明「由应用提供」。
 *
 * 为什么是两栏而不是行内展开：设置窗口最小 960 宽，左边导航 160，右边还有 800，
 * 两栏放得下；而行内展开会把「列表」和「编辑 4000 字」挤在同一列里。
 *
 * 有未保存改动时切行会先问一句 —— 提示词是长文本，静默丢弃等于丢用户的东西。
 * 关掉设置窗口不拦：那是用户主动结束。
 */

/** 正在编辑的缓冲。`id === null` 表示这一行还没创建 */
interface Editing {
  id: string | null
  draft: AgentTypeDraft
}

export function AgentTypeManagement() {
  const [types, setTypes] = useState<AgentTypeDef[]>([])
  const [agents, setAgents] = useState<Array<{ type: string }>>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** 想切走但还有未保存改动时，暂存在这儿等确认 */
  const [pendingSelect, setPendingSelect] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<AgentTypeDef | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [nextTypes, snapshot] = await Promise.all([host.listAgentTypes(), host.getSnapshot()])
    setTypes(nextTypes)
    setAgents(snapshot.agents)
    return
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 主进程推了新清单（另一个窗口改过）就整份换上；正在编辑的那份不动
  useEffect(() => host.onAgentTypesChanged((next) => setTypes(next)), [])

  // 第一次拿到清单时选中「基础」
  useEffect(() => {
    if (selectedId !== null || types.length === 0) return
    const first = types[0]!
    setSelectedId(first.id)
    setEditing({ id: first.id, draft: toDraft(first) })
  }, [types, selectedId])

  const selected = useMemo(
    () => types.find((def) => def.id === selectedId) ?? null,
    [types, selectedId]
  )

  /** 每个类型有几个 agent 在用（含归档的 —— 记录还在） */
  const usage = useMemo(() => {
    const map = new Map<string, number>()
    for (const agent of agents) map.set(agent.type, (map.get(agent.type) ?? 0) + 1)
    return map
  }, [agents])

  /** 有 agent 在用、但类型清单里没有的 —— 数据损坏或手改过文件 */
  const unknownCount = useMemo(
    () => agents.filter((agent) => !types.some((def) => def.id === agent.type)).length,
    [agents, types]
  )

  const creating = editing !== null && editing.id === null
  const atLimit = types.filter((def) => !def.builtin).length >= AGENT_TYPE_LIMITS.custom

  function toDraft(def: AgentTypeDef): AgentTypeDraft {
    return {
      name: def.name,
      description: def.description,
      prompt: def.prompt,
      color: def.color ?? leastUsedColor(types)
    }
  }

  function select(id: string): void {
    if (id === selectedId) return
    if (dirty) {
      setPendingSelect(id)
      return
    }
    applySelect(id)
  }

  function applySelect(id: string): void {
    const def = types.find((item) => item.id === id)
    if (!def) return
    setSelectedId(id)
    setEditing({ id, draft: toDraft(def) })
    setDirty(false)
    setError(null)
    setMessage(null)
  }

  function startCreate(): void {
    if (atLimit) return
    if (dirty) {
      setPendingSelect(NEW_ROW)
      return
    }
    setSelectedId(NEW_ROW)
    setEditing({
      id: null,
      draft: { name: '', description: '', prompt: '', color: leastUsedColor(types) }
    })
    setDirty(false)
    setError(null)
    setMessage(null)
  }

  function change(patch: Partial<AgentTypeDraft>): void {
    setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))
    setDirty(true)
    setError(null)
    setMessage(null)
  }

  async function save(): Promise<void> {
    if (!editing || busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      if (editing.id === null) {
        const result = await host.createAgentType(editing.draft)
        if (!result.ok) {
          setError(result.error)
          return
        }
        await load()
        setSelectedId(result.type.id)
        setEditing({ id: result.type.id, draft: toDraft(result.type) })
        setDirty(false)
        setMessage(`已新增「${result.type.name}」`)
        return
      }
      const result = await host.updateAgentType(editing.id, editing.draft)
      if (!result.ok) {
        setError(result.error)
        return
      }
      await load()
      setSelectedId(result.type.id)
      setEditing({ id: result.type.id, draft: toDraft(result.type) })
      setDirty(false)
      setMessage('已保存。已开的会话不受影响，新建或 /reload 之后才用新提示词。')
    } finally {
      setBusy(false)
    }
  }

  async function remove(def: AgentTypeDef): Promise<void> {
    const result = await host.removeAgentType(def.id)
    if (!result.ok) {
      setError(result.error)
      return
    }
    await load()
    setConfirmDelete(null)
    const next = types.find((item) => item.id !== def.id)
    if (next) applySelect(next.id)
    setMessage(`已删除「${def.name}」`)
  }

  /** 当前草稿能不能存 —— 只用来给按钮上色，点了还是会走一遍真实校验 */
  const draftError = editing
    ? dirty
      ? validateTypeDraft(editing.draft, types, editing.id ?? undefined)
      : { ok: true as const, value: editing.draft }
    : null
  const canSave = Boolean(editing) && dirty && draftError?.ok === true && !busy

  return (
    <div className="flex min-h-0 gap-4">
      {/* —— 左栏：列表 —— */}
      <div
        className="flex w-60 flex-none flex-col rounded-lg border border-hairline bg-surface"
        aria-label="agent 类型列表"
      >
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {types.map((def) => {
            const active = def.id === selectedId
            const used = usage.get(def.id) ?? 0
            return (
              <div key={def.id} className="group/row relative">
                <button
                  type="button"
                  onClick={() => select(def.id)}
                  aria-current={active}
                  className={[
                    'flex w-full items-center gap-2 px-2 py-1.5 text-left',
                    active ? 'bg-accent-wash' : 'hover:bg-sunken'
                  ].join(' ')}
                >
                  <AgentAvatar def={def} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-1">{def.name}</span>
                  {def.builtin ? (
                    <span className="flex-none rounded border border-hairline px-1 text-[10px] leading-4 text-fg-3">
                      内置
                    </span>
                  ) : (
                    <span
                      className="flex-none rounded-full"
                      style={{
                        width: 8,
                        height: 8,
                        background: `var(--av-c-${def.color}-bg)`,
                        boxShadow: `0 0 0 1px var(--av-c-${def.color}-fg)`
                      }}
                      title={def.color ? AGENT_COLOR_LABEL[def.color] : ''}
                    />
                  )}
                </button>
                {/* 在用就不给删按钮 —— 不是藏起来，是根本点不到 */}
                {!def.builtin && used === 0 && (
                  <button
                    type="button"
                    aria-label={`删除 ${def.name}`}
                    onClick={() => setConfirmDelete(def)}
                    className="absolute right-6 top-1/2 hidden -translate-y-1/2 rounded px-1 text-[11px] text-fg-3 hover:text-danger group-hover/row:block"
                  >
                    ✕
                  </button>
                )}
              </div>
            )
          })}

          {creating && (
            <div className="flex items-center gap-2 bg-accent-wash px-2 py-1.5">
              <span className="h-6 w-6 flex-none rounded-full border border-dashed border-hairline-strong" />
              <span className="truncate text-[12.5px] text-fg-2">新的 agent 类型</span>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={startCreate}
          disabled={atLimit}
          className="m-1.5 h-7 flex-none rounded-md border border-hairline text-[12px] text-fg-2 transition-colors hover:bg-sunken disabled:opacity-50"
          title={atLimit ? `最多 ${AGENT_TYPE_LIMITS.custom} 个自定义 agent` : undefined}
        >
          新建 agent 类型
        </button>
      </div>

      {/* —— 右栏：编辑区 —— */}
      <div className="min-w-0 flex-1">
        {unknownCount > 0 && (
          <div className="mb-3 rounded-md border border-warn-line bg-warn-wash px-2.5 py-1.5 text-[11.5px] leading-relaxed text-fg-2">
            有 {unknownCount} 个 agent 的类型不在列表里。它们照旧能聊，但头像显示为「
            {UNKNOWN_AGENT_TYPE_LABEL}」，也不会带提示词。
          </div>
        )}

        {!editing && <div className="text-[12.5px] text-fg-3">选一个类型，或者新建一个。</div>}

        {editing && (
          <div>
            <div className="text-[13.5px] font-semibold text-fg-1">
              {editing.id === null ? '新建 agent 类型' : selected?.name ?? UNKNOWN_AGENT_TYPE_NAME}
            </div>

            <Field label="名字" hint={selected?.builtin ? '由应用提供，不能改' : undefined}>
              <input
                value={editing.draft.name}
                readOnly={selected?.builtin === true}
                maxLength={AGENT_TYPE_LIMITS.name}
                onChange={(event) => change({ name: event.target.value })}
                className={inputClass(selected?.builtin === true)}
                aria-label="名字"
              />
            </Field>

            <Field label="说明" hint={selected?.builtin ? '由应用提供，不能改' : undefined}>
              <input
                value={editing.draft.description}
                readOnly={selected?.builtin === true}
                maxLength={AGENT_TYPE_LIMITS.description}
                onChange={(event) => change({ description: event.target.value })}
                className={inputClass(selected?.builtin === true)}
                aria-label="说明"
              />
            </Field>

            <Field label="颜色" hint={selected?.builtin ? '由应用提供，不能改' : '深浅主题各有配色'}>
              <div className="flex flex-wrap items-center gap-1.5">
                {selected?.builtin && (
                  <span className="flex items-center gap-1.5 text-[11.5px] text-fg-3">
                    <AgentAvatar def={selected} size={22} />
                    内置配色，不在自定义色板里
                  </span>
                )}
                {!selected?.builtin && AGENT_COLORS.map((color) => {
                  const active = editing.draft.color === color
                  return (
                    <button
                      key={color}
                      type="button"
                      aria-label={AGENT_COLOR_LABEL[color]}
                      aria-pressed={active}
                      onClick={() => change({ color })}
                      className={[
                        'h-6 w-6 rounded-full border-2 transition-transform',
                        active ? 'border-fg-1' : 'border-transparent',
                        'hover:scale-105'
                      ].join(' ')}
                      style={{ background: `var(--av-c-${color}-bg)`, boxShadow: `inset 0 0 0 1px var(--av-c-${color}-fg)` }}
                    />
                  )
                })}
                {!selected?.builtin && (
                  <span className="ml-1 flex items-center">
                    <AgentAvatar
                      def={{ ...editingDef(editing, selected), color: editing.draft.color }}
                      size={24}
                    />
                  </span>
                )}
              </div>
            </Field>

            <Field
              label="提示词"
              hint="每次会话启动时追加到系统提示末尾。已开的会话要 /reload 或新建才生效"
            >
              <textarea
                value={editing.draft.prompt}
                onChange={(event) => change({ prompt: event.target.value })}
                rows={10}
                aria-label="提示词"
                placeholder="例如：回答先给结论，再给理由。"
                className="w-full resize-y rounded-md border border-hairline bg-sunken px-2.5 py-2 font-mono text-[12px] leading-relaxed text-fg-1 outline-none focus:border-hairline-strong"
              />
              <div className="mt-1 flex items-center text-[11px] text-fg-3">
                <span>
                  {charCount(editing.draft.prompt)} / {AGENT_TYPE_LIMITS.prompt}
                </span>
                <span className="ml-auto">
                  {editing.draft.prompt.trim() === '' ? '空的就等于不加提示词' : ''}
                </span>
              </div>
            </Field>

            {error && <div className="mt-2 text-[11.5px] text-danger">{error}</div>}
            {message && <div className="mt-2 text-[11.5px] text-fg-3">{message}</div>}

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                disabled={!canSave}
                onClick={() => void save()}
                className="h-7 rounded-lg bg-accent px-3 text-[12.5px] text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? '保存中…' : editing.id === null ? '创建' : '保存'}
              </button>
              {editing.id === null && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const first = types[0]
                    setEditing(first ? { id: first.id, draft: toDraft(first) } : null)
                    setSelectedId(first?.id ?? null)
                    setDirty(false)
                    setError(null)
                  }}
                  className="h-7 rounded-lg border border-hairline px-3 text-[12.5px] text-fg-2 hover:bg-sunken disabled:opacity-50"
                >
                  取消
                </button>
              )}
              {selected && !selected.builtin && (
                <span className="ml-auto text-[11.5px] text-fg-3">
                  {(usage.get(selected.id) ?? 0) > 0
                    ? `有 ${usage.get(selected.id)} 个 agent 在用，不能删除`
                    : '没有 agent 在用这个类型'}
                </span>
              )}
              {selected && !selected.builtin && (usage.get(selected.id) ?? 0) === 0 && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(selected)}
                  className="h-7 rounded-lg border border-hairline px-3 text-[12.5px] text-danger hover:bg-danger-wash"
                >
                  删除
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {pendingSelect && (
        <ConfirmDialog
          title="放弃未保存的改动？"
          body="提示词的改动还没保存，切走之后这一段就没了。"
          confirmText="放弃改动"
          danger
          onCancel={() => setPendingSelect(null)}
          onConfirm={() => {
            const id = pendingSelect
            setPendingSelect(null)
            setDirty(false)
            if (id === NEW_ROW) startCreate()
            else applySelect(id)
          }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title={`删除「${confirmDelete.name}」？`}
          body="删掉之后这个类型就不在新建 agent 的卡片里了。没有 agent 在用它，所以不会影响已有会话。"
          confirmText="删除"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void remove(confirmDelete)}
        />
      )}
    </div>
  )
}

/** 新建行在列表与选中状态里的占位 id —— 不是真的类型 id */
const NEW_ROW = '__new__'

/** 编辑区顶部标题与预览头像用：新建时按草稿拼一份临时定义 */
function editingDef(editing: Editing, selected: AgentTypeDef | null): AgentTypeDef {
  if (selected && editing.id === selected.id) return selected
  return {
    id: '',
    name: editing.draft.name,
    description: editing.draft.description,
    prompt: editing.draft.prompt,
    color: editing.draft.color,
    builtin: false
  }
}

function inputClass(readOnly: boolean): string {
  return [
    'mt-1 w-full rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none',
    readOnly
      ? 'cursor-default border-hairline bg-panel text-fg-3'
      : 'border-hairline bg-sunken text-fg-1 focus:border-hairline-strong'
  ].join(' ')
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="mt-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11.5px] text-fg-2">{label}</span>
        {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
