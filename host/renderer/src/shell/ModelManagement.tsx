import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ModelAuthEvent,
  ModelEntry,
  ModelSettings,
  ProviderInfo,
  ThinkingLevel
} from '@contract/index'
import { host } from '../host'
import { formatContext, formatPrice } from './modelList'

/**
 * 大模型管理。
 *
 * 这一页把 pi 的模型管理搬进设置窗口：凭据（登录/登出）、模型清单（启停与排序）、
 * 默认模型与思考等级、自定义端点。
 *
 * 设置项本身存在 pi 的全局 settings.json 里（agent 目录）——
 * 「设为新会话默认」那条既有路径写的就是那儿，两边写一处，值才不会打架。
 */

/** 思考等级的八档与各自的说明 —— 与 pi 一致 */
const THINKING_LEVELS: Array<{ level: ThinkingLevel; label: string; hint: string }> = [
  { level: 'off', label: 'off', hint: '不思考' },
  { level: 'minimal', label: 'minimal', hint: '约 1k token' },
  { level: 'low', label: 'low', hint: '约 2k token' },
  { level: 'medium', label: 'medium', hint: '约 8k token' },
  { level: 'high', label: 'high', hint: '约 16k token' },
  { level: 'xhigh', label: 'xhigh', hint: '约 32k token' },
  { level: 'max', label: 'max', hint: '最大' }
]

/** 登录过程中的状态 */
interface AuthState {
  providerId: string
  providerName: string
  /** 授权链接 */
  url?: string
  /** 链接旁边的说明 */
  instructions?: string
  /** 设备码 */
  userCode?: string
  verificationUri?: string
  /** 要用户填的东西 */
  prompt?: { id: string; kind: string; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> }
  /** 进度说明 */
  progress?: string
  /** 收尾 */
  done?: boolean
  ok?: boolean
  message?: string
}

export function ModelManagement() {
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [models, setModels] = useState<ModelEntry[]>([])
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [config, setConfig] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    try {
      const [nextProviders, nextModels, nextSettings, nextConfig] = await Promise.all([
        host.listProviders(),
        host.listAllModels(),
        host.getModelSettings(),
        host.getModelsConfig()
      ])
      setProviders(nextProviders)
      setModels(nextModels)
      setSettings(nextSettings)
      setConfig(nextConfig)
      setError(null)
    } catch (error) {
      /*
       * 取不到就明说。
       *
       * 主进程没重启、通道没注册时 invoke 会直接拒 —— 空着不说，用户只看到一片空白，
       * 不知道是哪里坏了。
       */
      setError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 登录过程的事件 —— 主进程发过来，界面照着显示
  useEffect(
    () =>
      host.onModelAuthEvent((event: ModelAuthEvent) => {
        setAuth((current) => applyAuthEvent(current, event, providers))
        // 登录成了：凭据状态与可用模型都变了，重读一遍
        if (event.type === 'done') void load()
      }),
    [providers, load]
  )

  async function writeSetting(change: Parameters<typeof host.setModelSetting>[0]): Promise<void> {
    const ok = await host.setModelSetting(change)
    if (!ok) {
      setMessage('这个设置项改不了')
      return
    }
    setSettings(await host.getModelSettings())
  }

  async function login(provider: ProviderInfo): Promise<void> {
    const method = provider.methods.includes('oauth') ? 'oauth' : 'api_key'
    setAuth({ providerId: provider.providerId, providerName: provider.name })
    await host.loginProvider(provider.providerId, method)
  }

  async function logout(provider: ProviderInfo): Promise<void> {
    setBusy(true)
    try {
      const ok = await host.logoutProvider(provider.providerId)
      setMessage(ok ? `已登出 ${provider.name}` : `登出 ${provider.name} 失败`)
      if (ok) await load()
    } finally {
      setBusy(false)
    }
  }

  async function refresh(): Promise<void> {
    setBusy(true)
    try {
      const next = await host.refreshModels()
      setModels(next)
      setProviders(await host.listProviders())
      setMessage('模型清单已更新')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      {error && (
        <div className="mb-4 rounded-lg border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] bg-danger-wash px-3 py-2 text-[12px] text-danger">
          取不到模型数据：{error}
          <div className="mt-1 text-[11px] opacity-80">
            如果是刚加的功能，主进程可能还没重启 —— 新加的 IPC 通道要重启应用才注册得上。
          </div>
        </div>
      )}
      <ModelDefaults
        models={models}
        settings={settings}
        onChange={(change) => void writeSetting(change)}
      />
      <ProviderList
        providers={providers}
        busy={busy}
        onLogin={(provider) => void login(provider)}
        onLogout={(provider) => void logout(provider)}
      />
      <ModelListSection
        models={models}
        providers={providers}
        settings={settings}
        onChange={(change) => void writeSetting(change)}
        onRefresh={() => void refresh()}
        busy={busy}
      />
      <ConfigSection
        config={config}
        busy={busy}
        onSave={async (next) => {
          setBusy(true)
          try {
            const ok = await host.setModelsConfig(next)
            setMessage(ok ? 'models.json 已保存' : 'models.json 写不进去（JSON 语法不对？）')
            if (ok) await load()
          } finally {
            setBusy(false)
          }
        }}
      />
      {message && <div className="mt-3 text-[11.5px] text-fg-3">{message}</div>}
      {auth && (
        <AuthDialog
          auth={auth}
          onAnswer={(value) => void host.answerAuthPrompt(auth.prompt?.id ?? '', value)}
          onCancel={() => {
            void host.cancelLogin()
            setAuth(null)
          }}
          onClose={() => setAuth(null)}
        />
      )}
    </div>
  )
}

/** 把主进程的事件并进登录状态 */
function applyAuthEvent(
  current: AuthState | null,
  event: ModelAuthEvent,
  providers: ProviderInfo[]
): AuthState | null {
  const providerName =
    current?.providerId === event.providerId
      ? current.providerName
      : (providers.find((p) => p.providerId === event.providerId)?.name ?? event.providerId)

  const base: AuthState = current ?? { providerId: event.providerId, providerName }

  switch (event.type) {
    case 'auth_url':
      return { ...base, url: event.url, instructions: event.instructions, progress: undefined }
    case 'device_code':
      return {
        ...base,
        userCode: event.userCode,
        verificationUri: event.verificationUri,
        progress: undefined
      }
    case 'info':
      return { ...base, progress: event.message }
    case 'progress':
      return { ...base, progress: event.message }
    case 'prompt':
      return { ...base, prompt: event.prompt, progress: undefined }
    case 'done':
      return { ...base, done: true, ok: event.ok, message: event.message }
    default:
      return base
  }
}

// ---------------------------------------------------------------------------
// 一 · 默认
// ---------------------------------------------------------------------------

function ModelDefaults({
  models,
  settings,
  onChange
}: {
  models: ModelEntry[]
  settings: ModelSettings | null
  onChange: (change: Parameters<typeof host.setModelSetting>[0]) => void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  /**
   * 默认模型只列**已经登录的 provider** 底下的模型。
   *
   * 没登录的 provider 列出来也选不了 —— 选了就是个用不了的默认。
   * 一个 provider 都没登录时给一句话，指去「凭据」那一段。
   */
  const usable = useMemo(() => models.filter((model) => model.available), [models])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return usable.slice(0, 60)
    return usable
      .filter((model) => `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(q))
      .slice(0, 60)
  }, [usable, query])

  // 点外面收起
  useEffect(() => {
    if (!open) return
    function onDown(event: MouseEvent): void {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!settings) return null

  const currentKey = settings.defaultModel
    ? `${settings.defaultProvider}/${settings.defaultModel}`
    : null

  return (
    <section className="mb-6">
      <h3 className="text-[13px] font-semibold text-fg-1">默认</h3>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-3">
        默认模型与思考等级只作用于新开的会话；正在跑的会话仍按各自的模型走。
      </p>

      <div className="mt-2.5 flex items-start gap-4 border-b border-hairline py-2.5">
        <div className="w-28 flex-none text-[12.5px] text-fg-1">默认模型</div>
        <div className="relative min-w-0 flex-1" ref={rootRef}>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex h-7 w-full items-center gap-2 rounded-md border border-hairline-strong bg-surface px-2 text-left text-[12px] text-fg-1 hover:bg-sunken"
          >
            <span className="truncate font-mono text-[11.5px]">
              {currentKey ?? '未设置（按 provider 默认选）'}
            </span>
            <span className="ml-auto flex-none text-[10px] text-fg-3">▾</span>
          </button>
          {open && (
            <div className="absolute z-20 mt-1 w-full rounded-lg border border-hairline-strong bg-raised shadow-[var(--sh-lg)]">
              <div className="border-b border-hairline p-1.5">
                <input
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索模型…"
                  className="h-7 w-full rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-fg-1 outline-none placeholder:text-fg-3"
                />
              </div>
              <div className="max-h-56 overflow-y-auto p-1">
                {matches.length === 0 && (
                  <div className="px-2 py-3 text-center text-[11.5px] text-fg-3">
                    {usable.length === 0
                      ? '还没有已登录的 provider —— 先去下面「凭据」那一段登录。'
                      : '没有匹配的模型'}
                  </div>
                )}
                {matches.map((model) => {
                  const key = `${model.provider}/${model.id}`
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => {
                        onChange({ kind: 'defaultModel', provider: model.provider, id: model.id })
                        setOpen(false)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-sunken"
                    >
                      <span className="truncate font-mono text-[11.5px] text-fg-1">{key}</span>
                      <span className="ml-auto flex-none text-[10.5px] text-fg-3">
                        {formatContext(model.contextWindow)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-4 border-b border-hairline py-2.5">
        <div className="w-28 flex-none pt-1 text-[12.5px] text-fg-1">默认思考等级</div>
        <div className="flex flex-wrap gap-1.5">
          {THINKING_LEVELS.map((entry) => (
            <button
              key={entry.level}
              type="button"
              onClick={() => onChange({ kind: 'thinkingLevel', level: entry.level })}
              className={[
                'rounded-md border px-2 py-0.5 text-left text-[11.5px] transition-colors',
                settings.defaultThinkingLevel === entry.level
                  ? 'border-fg-1 bg-fg-1 text-[var(--canvas)]'
                  : 'border-hairline-strong text-fg-2 hover:border-fg-2 hover:text-fg-1'
              ].join(' ')}
            >
              <span className="block font-medium">{entry.label}</span>
              <span className="block text-[9.5px] opacity-70">{entry.hint}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 二 · 凭据
// ---------------------------------------------------------------------------

function ProviderList({
  providers,
  busy,
  onLogin,
  onLogout
}: {
  providers: ProviderInfo[]
  busy: boolean
  onLogin: (provider: ProviderInfo) => void
  onLogout: (provider: ProviderInfo) => void
}) {
  const [query, setQuery] = useState('')

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return providers
    return providers.filter((provider) =>
      `${provider.providerId} ${provider.name}`.toLowerCase().includes(q)
    )
  }, [providers, query])

  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-fg-1">凭据</h3>
        <span className="text-[11px] text-fg-3">{providers.length} 个 provider</span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-3">
        登录状态决定哪些模型可用。凭据存在 auth.json，登出只删这一份 ——
        环境变量和 models.json 里的 key 不受影响。
      </p>

      <div className="mt-2.5 flex items-center gap-2 pb-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索 provider…"
          className="h-7 w-56 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-fg-1 outline-none placeholder:text-fg-3"
        />
        <span className="text-[11px] text-fg-3">
          显示 {matches.length} / {providers.length}
        </span>
      </div>

      <div className="max-h-80 overflow-y-auto rounded-lg border border-hairline-strong bg-surface">
        {matches.length === 0 && (
          <div className="px-3 py-6 text-center text-[11.5px] text-fg-3">没有匹配的 provider</div>
        )}
        {matches.map((provider) => (
          <div
            key={provider.providerId}
            data-provider={provider.providerId}
            className="flex items-center gap-3 border-b border-hairline px-3 py-2 last:border-b-0 hover:bg-sunken"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] text-fg-1">{provider.name}</div>
              <div className="truncate text-[10.5px] text-fg-3">
                {provider.providerId} · {provider.methods.map(methodLabel).join(' / ')}
              </div>
            </div>
            <AuthBadge provider={provider} />
            {provider.configured ? (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onLogin(provider)}
                  className="h-[22px] rounded-md border border-hairline-strong px-2 text-[11.5px] text-fg-1 hover:bg-sunken disabled:opacity-50"
                >
                  重新登录
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onLogout(provider)}
                  className="h-[22px] rounded-md border border-[color-mix(in_srgb,var(--danger)_45%,transparent)] px-2 text-[11.5px] text-danger hover:bg-danger-wash disabled:opacity-50"
                >
                  登出
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={busy || provider.methods.length === 0}
                onClick={() => onLogin(provider)}
                className="h-[22px] rounded-md border border-fg-1 bg-fg-1 px-2 text-[11.5px] text-[var(--canvas)] hover:bg-accent-hover disabled:opacity-50"
              >
                登录
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/** 登录方式的名字 */
function methodLabel(method: 'oauth' | 'api_key'): string {
  return method === 'oauth' ? 'OAuth' : 'API Key'
}

/** 凭据状态徽标 */
function AuthBadge({ provider }: { provider: ProviderInfo }) {
  if (!provider.configured) {
    return <span className="flex-none text-[10.5px] text-fg-3">未配置</span>
  }
  const label =
    provider.source === 'environment'
      ? `环境变量 ${provider.label ?? ''}`.trim()
      : provider.source === 'models_json_key'
        ? 'models.json'
        : provider.subscription
          ? '已登录 · 订阅'
          : '已登录'
  return (
    <span className="flex-none rounded border border-[color-mix(in_srgb,var(--ok)_40%,transparent)] bg-ok-wash px-1.5 py-px text-[10.5px] text-ok">
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// 三 · 可用模型
// ---------------------------------------------------------------------------

function ModelListSection({
  models,
  providers,
  settings,
  onChange,
  onRefresh,
  busy
}: {
  models: ModelEntry[]
  providers: ProviderInfo[]
  settings: ModelSettings | null
  onChange: (change: Parameters<typeof host.setModelSetting>[0]) => void
  onRefresh: () => void
  busy: boolean
}) {
  const [query, setQuery] = useState('')
  /** 只看已登录的 provider —— 1599 个模型里大部分来自没登录的厂商 */
  const [onlyLoggedIn, setOnlyLoggedIn] = useState(true)
  /** 待保存的启用清单 —— null 表示不限制（全部可用） */
  const [pending, setPending] = useState<string[] | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    setPending(settings?.enabledModels ?? null)
    setDirty(false)
  }, [settings?.enabledModels])

  /**
   * 生效的启用清单。
   *
   * 没设过 = 全部可用。存了空数组 = 一个都不启用。
   * 清单里的顺序就是模型选择器里的排列顺序。
   */
  const enabled = useMemo(() => {
    if (pending === null) return models.map((model) => `${model.provider}/${model.id}`)
    return pending
  }, [pending, models])

  const enabledSet = useMemo(() => new Set(enabled), [enabled])

  const loggedInProviders = useMemo(
    () => new Set(providers.filter((provider) => provider.configured).map((p) => p.providerId)),
    [providers]
  )

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    return models.filter((model) => {
      if (onlyLoggedIn && !loggedInProviders.has(model.provider)) return false
      if (!q) return true
      return `${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(q)
    })
  }, [models, query, loggedInProviders, onlyLoggedIn])

  /** 按生效顺序排 —— 已启用的在前，按清单里的顺序 */
  const ordered = useMemo(() => {
    const order = new Map(enabled.map((key, index) => [key, index]))
    return [...matches].sort((a, b) => {
      const keyA = `${a.provider}/${a.id}`
      const keyB = `${b.provider}/${b.id}`
      const inA = order.has(keyA)
      const inB = order.has(keyB)
      if (inA && inB) return (order.get(keyA) ?? 0) - (order.get(keyB) ?? 0)
      if (inA) return -1
      if (inB) return 1
      return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)
    })
  }, [matches, enabled])

  function setEnabled(next: string[] | null): void {
    setPending(next)
    setDirty(true)
  }

  function toggle(key: string): void {
    const current = pending === null ? models.map((model) => `${model.provider}/${model.id}`) : [...pending]
    const index = current.indexOf(key)
    if (index >= 0) current.splice(index, 1)
    else current.push(key)
    setEnabled(current)
  }

  function move(key: string, delta: number): void {
    const current = pending === null ? models.map((model) => `${model.provider}/${model.id}`) : [...pending]
    const index = current.indexOf(key)
    const target = index + delta
    if (index < 0 || target < 0 || target >= current.length) return
    const [item] = current.splice(index, 1)
    current.splice(target, 0, item)
    setEnabled(current)
  }

  function enableAll(): void {
    // 批量操作只作用于**当前看见的**那些（受搜索与「只看已登录的厂商」影响）
    const targets = matches.map((model) => `${model.provider}/${model.id}`)
    const current = new Set(pending === null ? models.map((model) => `${model.provider}/${model.id}`) : pending)
    for (const key of targets) current.add(key)
    setEnabled([...current])
  }

  function disableAll(): void {
    const targets = new Set(matches.map((model) => `${model.provider}/${model.id}`))
    const current = (pending === null ? models.map((model) => `${model.provider}/${model.id}`) : pending).filter(
      (key) => !targets.has(key)
    )
    setEnabled(current)
  }

  function toggleProvider(provider: string): void {
    const keys = models.filter((model) => model.provider === provider).map((model) => `${model.provider}/${model.id}`)
    const current = new Set(pending === null ? models.map((model) => `${model.provider}/${model.id}`) : pending)
    const allOn = keys.every((key) => current.has(key))
    for (const key of keys) {
      if (allOn) current.delete(key)
      else current.add(key)
    }
    setEnabled([...current])
  }

  return (
    <section className="mb-6">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-fg-1">可用模型</h3>
        <span className="text-[11px] text-fg-3">决定模型选择器里出现哪些模型</span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-3">
        取消勾选＝这个模型不出现在<strong>对话区输入框下面的模型选择器</strong>里。
        上下箭头调整的是排列顺序 —— 已勾选的模型按这个顺序出现在选择器里。
        点 provider 名可以一次开关它底下的全部模型。
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 pb-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型…"
          className="h-7 w-52 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-fg-1 outline-none placeholder:text-fg-3"
        />
        <button
          type="button"
          role="switch"
          aria-checked={onlyLoggedIn}
          onClick={() => setOnlyLoggedIn((value) => !value)}
          className="flex h-7 items-center gap-1.5 rounded-md border border-hairline-strong px-2 text-[11.5px] text-fg-1 hover:bg-sunken"
        >
          <span
            aria-hidden="true"
            className={[
              'grid h-3.5 w-3.5 place-items-center rounded-[3px] border text-[9px] leading-none',
              onlyLoggedIn ? 'border-ok bg-ok text-[var(--canvas)]' : 'border-hairline-strong text-transparent'
            ].join(' ')}
          >
            ✓
          </span>
          只看已登录的厂商
        </button>
        <SmallButton onClick={enableAll}>全部启用</SmallButton>
        <SmallButton onClick={disableAll}>全部停用</SmallButton>
        <SmallButton onClick={onRefresh} disabled={busy}>
          刷新清单
        </SmallButton>        <span className="ml-auto text-[11px] text-fg-3">
          {enabledSet.size} / {models.length} 已启用
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-hairline-strong bg-surface">
        <div className="flex items-center gap-3 border-b border-hairline bg-panel px-3 py-1.5 text-[10.5px] text-fg-3">
          <span className="w-3.5 flex-none" />
          <span className="flex-1">模型</span>
          <span className="w-16 flex-none text-right">上下文</span>
          <span className="w-11 flex-none text-right">思考</span>
          <span className="w-14 flex-none text-right">价格</span>
          <span className="w-12 flex-none text-right">顺序</span>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {ordered.length === 0 && (
            <div className="px-3 py-6 text-center text-[11.5px] text-fg-3">没有匹配的模型</div>
          )}
          {ordered.map((model) => {
            const key = `${model.provider}/${model.id}`
            const on = enabledSet.has(key)
            return (
              <div
                key={key}
                data-model={key}
                className="flex items-center gap-3 border-b border-hairline px-3 py-1 last:border-b-0 hover:bg-sunken"
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(key)}
                  className={[
                    'grid h-3.5 w-3.5 flex-none place-items-center rounded-[3px] border text-[9px] leading-none',
                    on
                      ? 'border-ok bg-ok text-[var(--canvas)]'
                      : 'border-hairline-strong text-transparent'
                  ].join(' ')}
                >
                  ✓
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      title="切换这个 provider 的全部模型"
                      onClick={() => toggleProvider(model.provider)}
                      className="w-24 flex-none truncate rounded px-1 text-left text-[10px] text-fg-3 hover:bg-accent-wash hover:text-fg-1"
                    >
                      {model.provider}
                    </button>
                    {!loggedInProviders.has(model.provider) && (
                      <span className="flex-none rounded border border-hairline-strong px-1 text-[9.5px] text-fg-3">
                        未登录
                      </span>
                    )}
                    <span
                      className={[
                        'min-w-0 flex-1 truncate font-mono text-[11.5px]',
                        // 没勾选就是颜色暗一点 —— 勾选框已经说了「不在清单里」，不用再画一道线
                        on ? 'text-fg-1' : 'text-fg-3'
                      ].join(' ')}
                    >
                      {model.id}
                    </span>
                  </div>
                  <div className="truncate pl-[6.25rem] text-[10px] text-fg-3">{model.name}</div>
                </div>
                <span className="w-16 flex-none text-right text-[10.5px] text-fg-3">
                  {formatContext(model.contextWindow)}
                </span>
                <span className="w-11 flex-none text-right text-[10.5px] text-fg-3">
                  {model.reasoning ? '支持' : '—'}
                </span>
                <span className="w-14 flex-none text-right text-[10.5px] text-fg-3">
                  {formatPrice(model.cost.input)}
                </span>
                <span className="flex w-12 flex-none items-center justify-end gap-0.5">
                  <IconMove
                    label="上移"
                    disabled={!on}
                    onClick={() => move(key, -1)}
                  />
                  <IconMove
                    label="下移"
                    disabled={!on}
                    onClick={() => move(key, 1)}
                  />
                </span>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-2 border-t border-hairline bg-panel px-3 py-2 text-[11px]">
          {dirty ? (
            <span className="text-warn">有未保存的改动</span>
          ) : (
            <span className="text-fg-3">改动保存后对新会话生效</span>
          )}
          <span className="flex-1" />
          <SmallButton
            disabled={!dirty}
            onClick={() => {
              onChange({ kind: 'enabledModels', ids: pending })
              setDirty(false)
            }}
          >
            保存到设置
          </SmallButton>
        </div>
      </div>
    </section>
  )
}

/** 小按钮 */
function SmallButton({
  children,
  onClick,
  disabled
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-7 rounded-md border border-hairline-strong px-2 text-[11.5px] text-fg-1 hover:bg-sunken disabled:opacity-40"
    >
      {children}
    </button>
  )
}

/** 上移/下移 */
function IconMove({
  label,
  onClick,
  disabled
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="grid h-5 w-5 place-items-center rounded text-[11px] text-fg-3 hover:bg-accent-wash hover:text-fg-1 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {label === '上移' ? '↑' : '↓'}
    </button>
  )
}

// ---------------------------------------------------------------------------
// 四 · 自定义端点
// ---------------------------------------------------------------------------

function ConfigSection({
  config,
  busy,
  onSave
}: {
  config: string
  busy: boolean
  onSave: (content: string) => void
}) {
  const [draft, setDraft] = useState(config)
  const [valid, setValid] = useState(true)

  useEffect(() => {
    setDraft(config)
    setValid(true)
  }, [config])

  function check(next: string): void {
    setDraft(next)
    if (next.trim() === '') {
      setValid(true)
      return
    }
    try {
      JSON.parse(next)
      setValid(true)
    } catch {
      setValid(false)
    }
  }

  return (
    <section className="mb-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[13px] font-semibold text-fg-1">自定义端点</h3>
        <span className="text-[11px] text-fg-3">models.json</span>
      </div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-fg-3">
        指向 Pi 不自带的服务端（Ollama、LM Studio、vLLM、自建代理）。字段含义见 pi 的
        docs/models.md，这里只做编辑与加载，不做字段级表单。留空等于删掉这个文件。
      </p>
      <textarea
        value={draft}
        onChange={(event) => check(event.target.value)}
        spellCheck={false}
        rows={11}
        placeholder={
          '{\n' +
          '  "providers": {\n' +
          '    "ollama": {\n' +
          '      "baseUrl": "http://localhost:11434/v1",\n' +
          '      "api": "openai-completions",\n' +
          '      "apiKey": "ollama",\n' +
          '      "models": [{ "id": "qwen2.5-coder:7b" }]\n' +
          '    }\n' +
          '  }\n' +
          '}'
        }
        className="mt-2 w-full resize-y rounded-lg border border-hairline-strong bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-fg-1 outline-none"
      />
      <div className="mt-2 flex items-center gap-2">
        <span className={valid ? 'text-[11px] text-fg-3' : 'text-[11px] text-danger'}>
          {valid ? (draft.trim() === '' ? '空 —— 保存即删掉这个文件' : 'JSON 合法') : 'JSON 语法不对'}
        </span>
        <span className="flex-1" />
        <SmallButton disabled={busy || !valid || draft === config} onClick={() => onSave(draft)}>
          保存
        </SmallButton>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// 登录弹层
// ---------------------------------------------------------------------------

/** 提问的默认占位文案 —— pi 的提问大多不带 placeholder */
function promptPlaceholder(kind: string): string {
  switch (kind) {
    case 'secret':
      return '粘贴 API Key'
    case 'manual_code':
      return '粘贴回调链接或验证码'
    default:
      return '输入…'
  }
}

function AuthDialog({
  auth,
  onAnswer,
  onCancel,
  onClose
}: {
  auth: AuthState
  onAnswer: (value: string) => void
  onCancel: () => void
  onClose: () => void
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (auth.prompt && auth.prompt.kind !== 'select') inputRef.current?.focus()
  }, [auth.prompt])

  // 登录结束 —— 弹层自己收起
  useEffect(() => {
    if (auth.done) {
      const timer = setTimeout(onClose, 1200)
      return () => clearTimeout(timer)
    }
  }, [auth.done, onClose])

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[rgba(0,0,0,.45)] p-6">
      <div className="w-[420px] max-w-full overflow-hidden rounded-xl border border-hairline-strong bg-raised shadow-[var(--sh-lg)]">
        <div className="px-3.5 pb-2 pt-3 text-[13px] font-semibold text-fg-1">
          {auth.done ? (auth.ok ? `已登录 ${auth.providerName}` : `登录 ${auth.providerName} 失败`) : `登录到 ${auth.providerName}`}
        </div>
        <div className="px-3.5 pb-3 text-[12px] leading-relaxed text-fg-2">
          {auth.done ? (
            auth.ok ? (
              '凭据已经存下来了。这个 provider 的模型现在可以用了。'
            ) : (
              <span className="text-danger">{auth.message ?? '登录失败'}</span>
            )
          ) : null}

          {!auth.done && auth.url && (
            <>
              <div className="flex items-start gap-2 rounded-md bg-sunken p-2">
                <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-info">{auth.url}</span>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(auth.url ?? '')}
                  className="flex-none rounded px-1.5 py-0.5 text-[11px] text-fg-3 hover:bg-accent-wash hover:text-fg-1"
                >
                  复制
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-fg-3">
                {auth.instructions ?? '已在浏览器打开。在浏览器里完成授权后，这里会自动继续。'}
              </p>
            </>
          )}

          {!auth.done && auth.userCode && (
            <>
              <div className="rounded-md bg-sunken p-2 text-center font-mono text-[15px] tracking-[.12em] text-fg-1">
                {auth.userCode}
              </div>
              <p className="mt-1.5 text-[11px] text-fg-3">
                在 {auth.verificationUri} 输入这个码。
              </p>
            </>
          )}

          {!auth.done && auth.prompt && (
            <>
              <p className="mt-1 text-[11.5px] text-fg-2">{auth.prompt.message}</p>
              {auth.prompt.kind === 'select' ? (
                <div className="mt-1.5 flex flex-col gap-1">
                  {(auth.prompt.options ?? []).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onAnswer(option.id)}
                      className="rounded-md border border-hairline-strong px-2 py-1 text-left text-[12px] text-fg-1 hover:bg-sunken"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type={auth.prompt.kind === 'secret' ? 'password' : 'text'}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && value) onAnswer(value)
                    }}
                    placeholder={auth.prompt.placeholder ?? promptPlaceholder(auth.prompt.kind)}
                    className="h-7 min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface px-2 text-[12px] text-fg-1 outline-none placeholder:text-fg-3"
                  />
                  <SmallButton onClick={() => onAnswer(value)} disabled={!value}>
                    提交
                  </SmallButton>
                </div>
              )}
            </>
          )}

          {!auth.done && !auth.url && !auth.userCode && !auth.prompt && (
            <p className="text-[11.5px] text-fg-3">{auth.progress ?? '进行中…'}</p>
          )}

          {!auth.done && auth.prompt && auth.progress && (
            <p className="mt-1.5 text-[11px] text-fg-3">{auth.progress}</p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-hairline bg-panel px-3 py-2">
          {!auth.done && auth.progress && <span className="text-[11px] text-fg-3">{auth.progress}</span>}
          <span className="flex-1" />
          {auth.done ? (
            <button
              type="button"
              onClick={onClose}
              className="h-[22px] rounded-md border border-hairline-strong px-2 text-[11.5px] text-fg-1 hover:bg-sunken"
            >
              知道了
            </button>
          ) : (
            <button
              type="button"
              onClick={onCancel}
              className="h-[22px] rounded-md border border-hairline-strong px-2 text-[11.5px] text-fg-1 hover:bg-sunken"
            >
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
