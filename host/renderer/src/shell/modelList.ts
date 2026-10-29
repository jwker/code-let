import type { ModelOption } from '@contract/index'

/**
 * 模型选择器要用的纯函数（好测）。
 *
 * 三个职责：把清单按 provider 分组、按关键词过滤、把模型名压成短标签。
 */

/** 按 provider 分组，组的顺序按 provider 名排；组内保持原顺序 */
export function groupByProvider(models: readonly ModelOption[]): { provider: string; models: ModelOption[] }[] {
  const groups = new Map<string, ModelOption[]>()
  for (const model of models) {
    const list = groups.get(model.provider)
    if (list) list.push(model)
    else groups.set(model.provider, [model])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => ({ provider, models: list }))
}

/**
 * 按关键词过滤：同时匹配模型名、模型 id 和 provider。
 *
 * 输入 `deepseek` 应该剩下那一整组；输入 `m3.1` 应该命中 MiniMax-M3.1-Flash。
 */
export function filterModels(models: readonly ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...models]
  return models.filter((model) => {
    const haystack = `${model.name} ${model.id} ${model.provider}`.toLowerCase()
    return haystack.includes(q)
  })
}

/** 上下文窗口：200000 → 200k */
export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return `${tokens}`
}

/** 价格（每百万 token）：0.3 → $0.30；0 → free（本地模型或没计价） */
export function formatPrice(usdPerMillion: number): string {
  if (usdPerMillion <= 0) return 'free'
  if (usdPerMillion < 0.01) return `$${usdPerMillion.toFixed(4)}`
  return `$${usdPerMillion.toFixed(2)}`
}
