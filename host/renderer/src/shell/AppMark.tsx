/**
 * 应用图标 —— 跟 `build/icon.svg`（Dock 图标）同一个图形：圆角方块 + 字母 C + 终端光标。
 *
 * 两处不同：
 * 1. **裁掉了四周的透明边距。** 图标文件里留 100/1024 的边距是为了在 Dock 里不显得比邻居大，
 *    放进窄轨时那段留白会变成一个没用的缩进 —— 这里直接把 viewBox 裁到方块本身，
 *    32px 的标记就是 32px 的视觉尺寸。
 * 2. **颜色走令牌而不是写死。** 图标是深底白字；深色主题下窄轨本身就是深色，
 *    照搬会看不见。所以底色用 `--fg-1`、图形用 `--surface`：亮色下是深底白字，
 *    暗色下自动反成浅底深字，跟用户气泡是同一套反相逻辑。
 */
export function AppMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="100 100 824 824"
      role="img"
      aria-label="Codelet"
      className="app-mark"
    >
      <rect x="100" y="100" width="824" height="824" rx="185.4" fill="var(--fg-1)" />
      <path
        d="M643 356 A204 204 0 1 0 643 668"
        stroke="var(--surface)"
        strokeWidth="92"
        fill="none"
        strokeLinecap="round"
      />
      <rect x="618" y="452" width="120" height="120" rx="20" fill="var(--surface)" />
    </svg>
  )
}
