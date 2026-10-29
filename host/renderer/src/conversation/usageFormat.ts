/**
 * 元信息行上的数字写法（纯函数，好测）。
 *
 * token 走「1.2k / 44.1k」这种缩写，耗时走秒。
 */

/** token 数：1234 → 1.2k，1_234_567 → 1.2M */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return `${value}`
}

/**
 * 耗时：不到一秒写毫秒，不到一分钟写秒，再长写分秒 / 时分。
 *
 * 真实会话里一轮跑一小时是常事（工具、思考都算在墙钟里），
 * 不能一律写成「 3328.0s 」。
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`
  }
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  return minutes === 0 ? `${hours}h` : `${hours}h${minutes}m`
}
