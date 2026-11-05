import { useCallback, useEffect, useMemo, useState } from 'react'
import { SETTINGS_CATEGORIES, SETTINGS_ITEMS, type SettingItem } from '@contract/settings'
import type { ConsoleStats } from '@contract/index'
import { host } from '../host'
import { ConfirmDialog } from './ConfirmDialog'
import { WindowHeader } from './WindowHeader'

/**
 * 设置窗口。
 *
 * 左边是分类，右边是这一类里的设置项。**设置项本身是一份注册表**
 * （`contract/settings.ts`），这里按注册表渲染 —— 以后加一项就是加一条数据，
 * 这个页面不用改。
 */

export function SettingsApp() {
  // 文档标题 = 窗口标题。Dock 菜单和红绿灯旁边显示的都是它。
  useEffect(() => {
    document.title = '设置'
  }, [])

  const [values, setValues] = useState<Record<string, unknown>>({})
  const [category, setCategory] = useState('general')
  const [stats, setStats] = useState<ConsoleStats | null>(null)
  const [confirm, setConfirm] = useState<SettingItem | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [next, nextStats] = await Promise.all([host.getSettings(), host.getConsoleStats()])
    setValues(next)
    setStats(nextStats)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const categories = useMemo(() => {
    // 只列有设置项的分类 —— 空分类先不占位
    const withItems = new Set(SETTINGS_ITEMS.map((item) => item.category))
    return SETTINGS_CATEGORIES.filter((entry) => withItems.has(entry.id)).sort(
      (a, b) => a.order - b.order
    )
  }, [])

  // 默认落在第一个有内容的分类上
  useEffect(() => {
    if (categories.length > 0 && !categories.some((entry) => entry.id === category)) {
      setCategory(categories[0]!.id)
    }
  }, [categories, category])

  const items = useMemo(
    () => SETTINGS_ITEMS.filter((item) => item.category === category),
    [category]
  )

  const write = useCallback(
    async (item: SettingItem, value: unknown): Promise<void> => {
      const ok = await host.setSetting(item.id, value)
      if (!ok) {
        setMessage('这个设置项改不了')
        return
      }
      await load()
    },
    [load]
  )

  const runAction = useCallback(
    async (item: SettingItem): Promise<void> => {
      if (item.action === 'consoleClear') {
        setBusy(true)
        try {
          const result = await host.clearConsole()
          await load()
          setMessage(`已清空 ${result.deleted} 条记录`)
        } finally {
          setBusy(false)
        }
      }
    },
    [load]
  )

  return (
    <div className="flex h-screen min-h-0 flex-col bg-canvas text-fg-1">
      <WindowHeader title="设置" />
      <div className="flex min-h-0 flex-1">
        <nav className="w-40 flex-none border-r border-hairline bg-panel px-1.5 py-2">
          {categories.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setCategory(entry.id)}
              className={[
                'mb-0.5 flex h-6 w-full items-center rounded-md px-2 text-left text-[12.5px]',
                category === entry.id
                  ? 'bg-accent-wash font-semibold text-fg-1'
                  : 'text-fg-2 hover:bg-sunken hover:text-fg-1'
              ].join(' ')}
            >
              {entry.title}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          <h2 className="mb-3 text-[13.5px] font-semibold text-fg-1">
            {categories.find((entry) => entry.id === category)?.title ?? '设置'}
          </h2>

          {items.length === 0 && (
            <div className="text-[12.5px] text-fg-3">这一类还没有设置项。</div>
          )}

          {items.map((item) => (
            <div key={item.id} className="border-b border-hairline py-3 last:border-b-0">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-fg-1">{item.label}</div>
                  {item.description && (
                    <div className="mt-0.5 text-[11.5px] leading-relaxed text-fg-3">
                      {item.description}
                    </div>
                  )}
                </div>
                <div className="flex flex-none items-center gap-2">
                  {item.control === 'switch' && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={values[item.id] === true}
                      onClick={() => void write(item, values[item.id] !== true)}
                      className={[
                        'relative h-5 w-9 rounded-full border transition-colors',
                        values[item.id] === true
                          ? 'border-fg-1 bg-fg-1'
                          : 'border-hairline-strong bg-sunken'
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-surface transition-all',
                          values[item.id] === true ? 'left-[18px]' : 'left-0.5'
                        ].join(' ')}
                      />
                    </button>
                  )}
                  {item.control === 'number' && (
                    <NumberInput
                      item={item}
                      value={typeof values[item.id] === 'number' ? (values[item.id] as number) : 0}
                      onChange={(next) => void write(item, next)}
                    />
                  )}
                  {item.control === 'info' && item.info === 'consoleStats' && <Usage stats={stats} />}
                  {item.control === 'action' && item.action === 'consoleClear' && (
                    <button
                      type="button"
                      onClick={() => setConfirm(item)}
                      className="rounded-md border border-hairline px-2 py-1 text-[12px] text-danger hover:bg-danger-wash"
                    >
                      清空
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {message && <div className="mt-3 text-[11.5px] text-fg-3">{message}</div>}
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.confirm?.title ?? '确认？'}
          body={confirm.confirm?.body ?? ''}
          confirmText="清空"
          danger
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const item = confirm
            setConfirm(null)
            void runAction(item)
          }}
        />
      )}
    </div>
  )
}

/** 数字输入 —— 换算成注册表里的单位（MB） */
function NumberInput({
  item,
  value,
  onChange
}: {
  item: SettingItem
  value: number
  onChange: (value: number) => void
}) {
  const unit = item.unit ?? ''
  const scale = unit === 'MB' ? 1024 * 1024 : 1
  const [text, setText] = useState(String(Math.round(value / scale)))
  useEffect(() => {
    setText(String(Math.round(value / scale)))
  }, [value, scale])
  return (
    <label className="flex items-center gap-1.5">
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => {
          const parsed = Number(text)
          if (!Number.isFinite(parsed)) {
            setText(String(Math.round(value / scale)))
            return
          }
          onChange(parsed * scale)
        }}
        className="w-20 rounded-md border border-hairline bg-sunken px-2 py-1 text-right font-mono text-[12px] text-fg-1"
      />
      <span className="text-[11.5px] text-fg-3">{unit}</span>
    </label>
  )
}

/** 占用统计：内容、索引、图片、合计 */
function Usage({ stats }: { stats: ConsoleStats | null }) {
  if (!stats) return <span className="text-[12px] text-fg-3">读取中…</span>
  const rows: Array<[string, number]> = [
    ['记录条数', stats.count],
    ['请求内容', stats.contentBytes],
    ['索引', stats.indexBytes],
    ['图片', stats.blobBytes]
  ]
  return (
    <div className="w-64">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center text-[11.5px] text-fg-3">
          <span>{label}</span>
          <span className="ml-auto font-mono text-fg-1">
            {label === '记录条数' ? value : formatBytes(value)}
          </span>
        </div>
      ))}
      <div className="mt-0.5 flex items-center border-t border-hairline pt-0.5 text-[11.5px] text-fg-2">
        <span>合计</span>
        <span className="ml-auto font-mono text-fg-1">{formatBytes(stats.totalBytes)}</span>
      </div>
      <button
        type="button"
        onClick={() => void host.revealConsoleDir()}
        className="mt-1.5 rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-fg-2 hover:text-fg-1"
      >
        打开目录
      </button>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`
}
