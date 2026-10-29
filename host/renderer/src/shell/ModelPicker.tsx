import { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelOption } from '@contract/index'
import { host } from '../host'
import { IconCheck } from './icons'
import { filterModels, formatContext, formatPrice, groupByProvider } from './modelList'

/**
 * 模型选择器（P1：带搜索的分组清单 + 「设为新会话默认」）。
 *
 * 只列已配置凭据的模型 —— 没凭据的选了也是报错，不如不列。
 * 换模型默认只影响当前会话（模型是绑在会话上的）；勾上底部那个框才写全局默认。
 */
export function ModelPicker({
  models,
  current,
  onPick,
  onClose
}: {
  models: ModelOption[]
  current: ModelOption | null
  onPick: (model: ModelOption, persist: boolean) => Promise<void>
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [persist, setPersist] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const matches = useMemo(() => filterModels(models, query), [models, query])
  const groups = useMemo(() => groupByProvider(matches), [matches])

  // 键盘选中项在「过滤后的平铺顺序」里走
  const flat = useMemo(() => groups.flatMap((group) => group.models), [groups])
  // 初始高亮定在**当前模型**上 —— 否则一打开按回车就换成别的了
  const [active, setActive] = useState(() => {
    const index = flat.findIndex((m) => current?.provider === m.provider && current?.id === m.id)
    return index < 0 ? 0 : index
  })

  useEffect(() => {
    // 搜索词变了：高亮回到当前模型（搜不到就回到第一项）
    const index = flat.findIndex((m) => current?.provider === m.provider && current?.id === m.id)
    setActive(index < 0 ? 0 : index)
  }, [query, flat, current])

  // 打开就聚焦搜索框
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // 点外面关掉
  useEffect(() => {
    function onDown(event: MouseEvent): void {
      if (!boxRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  async function choose(model: ModelOption): Promise<void> {
    if (busy) return
    // 点的就是当前那个 —— 直接关掉，不发请求
    if (current && model.provider === current.provider && model.id === current.id && !persist) {
      onClose()
      return
    }
    setBusy(true)
    setFailed(null)
    try {
      await onPick(model, persist)
      onClose()
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((i) => Math.min(i + 1, flat.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const model = flat[active]
      if (model) void choose(model)
    }
  }

  return (
    <div
      ref={boxRef}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label="选择模型"
      className="w-[420px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-hairline-strong bg-raised shadow-[var(--sh-lg)]"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="text-[12px] text-fg-3">⌕</span>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型…"
          className="min-w-0 flex-1 border-0 bg-transparent text-[12px] text-fg-1 outline-none placeholder:text-fg-3"
        />
        <kbd className="rounded border border-hairline-strong px-1 text-[10px] text-fg-3">Esc</kbd>
      </div>

      <div className="max-h-[260px] overflow-y-auto p-1">
        {flat.length === 0 && (
          <div className="px-2 py-6 text-center text-[11.5px] text-fg-3">
            {models.length === 0 ? '没有已配置凭据的模型。先在 pi 里登录或配置 API key。' : '没有匹配的模型'}
          </div>
        )}

        {groups.map((group) => (
          <div key={group.provider}>
            <div className="px-2 pb-1 pt-2 text-[9.5px] uppercase tracking-[.08em] text-fg-3">
              {group.provider}
            </div>
            {group.models.map((model) => {
              const index = flat.indexOf(model)
              const selected = current?.provider === model.provider && current?.id === model.id
              return (
                <button
                  key={`${model.provider}/${model.id}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={busy}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void choose(model)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors disabled:cursor-not-allowed ${
                    index === active ? 'bg-sunken' : ''
                  }`}
                >
                  <span className="w-3.5 flex-none text-ok">{selected ? <IconCheck /> : null}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-1">{model.name}</span>
                  <span className="flex flex-none items-center gap-2 font-mono text-[10px] text-fg-3">
                    <span>{formatContext(model.contextWindow)}</span>
                    {model.reasoning && <span>思考</span>}
                    <span className="text-fg-3">
                      {formatPrice(model.cost.input)}/{formatPrice(model.cost.output)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>

      {failed && (
        <div className="border-t border-hairline px-3 py-2 text-[11px] text-danger">{failed}</div>
      )}

      <div className="flex items-center gap-3 border-t border-hairline bg-panel px-3 py-2 text-[10.5px] text-fg-3">
        {/* 不用原生 checkbox：它的渲染跟系统主题走，暗色下会变成一个亮方块，看不出勾没勾 */}
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={persist}
            onChange={(event) => setPersist(event.target.checked)}
            className="sr-only"
          />
          <span
            aria-hidden="true"
            className={`grid h-3.5 w-3.5 place-items-center rounded-[3px] border text-[9px] leading-none transition-colors ${
              persist ? 'border-ok bg-ok text-[var(--canvas)]' : 'border-hairline-strong text-transparent'
            }`}
          >
            ✓
          </span>
          设为新会话默认
        </label>
        <span className="ml-auto">{busy ? '切换中…' : '↑↓ 选择 ↵ 确认'}</span>
      </div>
    </div>
  )
}

/** 把当前模型取成「provider 分组 + 名字」，给状态栏和入口用 */
export function modelLabel(model: ModelOption | null): string {
  return model ? model.name : '未选模型'
}

/** 触发选择器要用的模型清单（宿主那边取不到就返回空） */
export async function loadModels(): Promise<ModelOption[]> {
  try {
    return await host.listModels()
  } catch {
    return []
  }
}
