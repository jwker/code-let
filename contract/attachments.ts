/**
 * 附件估算与显示格式 —— 主进程和渲染进程共用，避免两边算出不同的 token 数。
 *
 * 这些数字只用于界面提示，不是模型真正的 tokenizer 结果。
 */
export const IMAGE_TOKEN_ESTIMATE = 1200

/** 文本按 4 字符一个 token 估，外加 `<file>` 包装的开销 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4) + 8
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/** 明确带约数，避免被当成精确 tokenizer 输出 */
export function formatTokenEstimate(tokens: number): string {
  if (tokens >= 1000) return `≈${(tokens / 1000).toFixed(1)}k tok`
  return `≈${tokens} tok`
}
