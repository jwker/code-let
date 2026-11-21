import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentInfo, AgentTypeDef } from '@contract/index'
import { BUILTIN_AGENT_TYPES, capabilitiesOf, defaultAgentName } from '@contract/index'
import { useStore } from '../store'
import { AgentAvatar } from './AgentAvatar'
import { useLeftColumnOverlay } from './useOverlay'

/**
 * 新建 agent（PLAN.md D53 / D62）。
 *
 * 三个入口共用这一个框：窄轨的「＋」、输入框的 `/new`、项目设置里的「新建 agent」。
 *
 * **只有两个字段：类型和名字。**
 * 技能、工具、模型不在这里选 —— 那些属于类型定义，要改就改定义本身，
 * 否则十个 agent 十套配置，没人记得住哪个是什么。
 *
 * 类型**创建后不可改**（D62）：它决定区域 5/6 的布局，也决定实例编号（按类型分配，改了会撞号）。
 *
 * 卡片上写的不是「类型」，是**点开之后长什么样**。类型之间唯一让人感知到的差别
 * 就是布局，所以卡片上如实写「一列 · 对话」或「两列 · 对话 + 原型」，不替它编造差别。
 */
function layoutHint(def: AgentTypeDef): string {
  return capabilitiesOf(def).preview ? '两列 · 对话 + 原型' : '一列 · 对话'
}

export interface NewAgentChoice {
  /** 类型 id：内置三个之一，或者用户自定义的 */
  type: string
  name: string
}

export function NewAgentDialog({
  project,
  agents,
  busy,
  onCreate,
  onCancel
}: {
  /** 在哪个项目里建 —— 只用于提示用户 */
  project: string
  /** 本项目现有的 agent —— 默认名的序号要按「项目 + 类型」算，跟宿主同一条规则 */
  agents: AgentInfo[]
  busy?: boolean
  onCreate: (choice: NewAgentChoice) => void
  onCancel: () => void
}) {
  useLeftColumnOverlay()

  /*
   * 类型清单从 store 取；还没拉到时先用内置三个顶上 ——
   * 对话框不该因为「清单还在路上」而空白一片。
   */
  const storedTypes = useStore((s) => s.agentTypes)
  const types = storedTypes.length > 0 ? storedTypes : BUILTIN_AGENT_TYPES
  const firstType = types[0]!

  /** 每种类型在本项目的下一个实例序号 —— 打开时算一次，对话框开着的时候不会有人新建 */
  const nextInstance = useMemo(() => {
    const map: Record<string, number> = {}
    for (const def of types) {
      const used = agents.filter((agent) => agent.type === def.id).map((agent) => agent.instance)
      map[def.id] = used.length === 0 ? 1 : Math.max(...used) + 1
    }
    return map
  }, [agents, types])

  const defOf = (id: string): AgentTypeDef | null => types.find((def) => def.id === id) ?? null

  const defaultNameFor = (id: string): string =>
    defaultAgentName(defOf(id), nextInstance[id] ?? 1)

  const [type, setType] = useState<string>(firstType.id)
  const [name, setName] = useState(() => defaultAgentName(firstType, nextInstance[firstType.id] ?? 1))
  /** 用户动过名字之后，换类型不再覆盖它 */
  const edited = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 打开就聚焦并全选 —— 名字是个默认值，想改直接敲
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !busy) onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  function pickType(next: string): void {
    setType(next)
    if (!edited.current) setName(defaultNameFor(next))
  }

  /**
   * 建。
   *
   * 名字留空就用默认的那个 —— 用户清空输入框往往只是「不想自己起」，不该因此卡住。
   */
  function submit(): void {
    if (busy) return
    const trimmed = name.trim()
    onCreate({ type, name: trimmed || defaultNameFor(type) })
  }

  return (
    <div className="left-scope z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/25" onClick={busy ? undefined : onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="新建 agent"
        className="left-dialog relative w-[380px] rounded-xl border border-hairline bg-raised p-4"
        style={{ boxShadow: 'var(--sh-lg)' }}
      >
        <div className="text-[13.5px] font-semibold text-fg-1">新建 agent</div>
        <div className="mt-1 truncate text-[11.5px] text-fg-3" title={project}>
          {project}
        </div>

        <div className="mt-3.5 text-[11.5px] text-fg-2">agent 类型</div>
        <div
          role="radiogroup"
          aria-label="agent 类型"
          className="mt-1.5 grid max-h-[280px] grid-cols-2 gap-2 overflow-y-auto pr-0.5"
        >
          {types.map((def) => {
            const active = def.id === type
            const hint = layoutHint(def)
            return (
              <button
                key={def.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy}
                title={`${def.name} · ${hint}`}
                onClick={() => pickType(def.id)}
                className={[
                  'flex min-w-0 flex-col items-center gap-1 rounded-[10px] border px-1.5 pb-1.5 pt-2',
                  'transition-colors disabled:opacity-60',
                  active
                    ? 'border-fg-1 bg-accent-wash'
                    : 'border-hairline-strong bg-surface hover:bg-panel'
                ].join(' ')}
              >
                <AgentAvatar def={def} size={28} />
                <span className="w-full truncate text-center text-[12.5px] font-medium text-fg-1">
                  {def.name}
                </span>
                <span
                  className={[
                    'text-center text-[11px] leading-[1.4]',
                    active ? 'text-fg-2' : 'text-fg-3'
                  ].join(' ')}
                >
                  {hint}
                </span>
              </button>
            )
          })}
        </div>

        <label htmlFor="new-agent-name" className="mt-3.5 block text-[11.5px] text-fg-2">
          名字
        </label>
        <input
          id="new-agent-name"
          ref={inputRef}
          value={name}
          disabled={busy}
          maxLength={80}
          onChange={(event) => {
            edited.current = true
            setName(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            submit()
          }}
          className="mt-1 w-full rounded-lg border border-hairline bg-sunken px-2.5 py-1.5 text-[13px] text-fg-1 outline-none focus:border-hairline-strong"
        />

        <div className="mt-1 text-[11px] leading-5 text-fg-3">
          名字默认是「类型名 + 本项目该类型的下一个序号」，已全选，直接回车就建。
          换类型点上面的卡片。Esc 取消。
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="h-7 rounded-lg border border-hairline px-3 text-[12.5px] text-fg-2 transition-colors hover:bg-sunken disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={submit}
            className="h-7 rounded-lg bg-accent px-3 text-[12.5px] text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
