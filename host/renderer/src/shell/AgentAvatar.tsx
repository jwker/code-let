import type { AgentTypeDef } from '@contract/index'

/**
 * agent 头像（PLAN.md D53）。
 *
 * 窄轨里只有 28px，颜色和轮廓是唯一能远看的信号：
 *
 * - 内置三种各有自己的轮廓（圆脸 / 机器人 / 对话气泡），配色是 `--av-<id>-*`；
 * - 自定义 agent 用同一套轮廓（圆角方形 + 两点一线），配色按类型定义里的 `color` 取
 *   `--av-c-<color>-*`；
 * - 未知 agent（类型定义不在了）用灰的「空」轮廓 —— 用户一眼能看出这条记录有问题，
 *   但它照旧能聊天。
 *
 * 不写字：28px 放不下字，名字靠悬停气泡（`title`）和右键菜单。
 * 一律用 CSS 变量取色，不写死色值（底线 1）。
 */
export function AgentAvatar({ def, size = 28 }: { def: AgentTypeDef | null; size?: number }) {
  const kind = def && def.builtin ? def.id : def ? 'custom' : 'unknown'
  const bg = def?.builtin
    ? `var(--av-${def.id}-bg)`
    : def?.color
      ? `var(--av-c-${def.color}-bg)`
      : 'var(--av-unknown-bg)'
  const fg = def?.builtin
    ? `var(--av-${def.id}-fg)`
    : def?.color
      ? `var(--av-c-${def.color}-fg)`
      : 'var(--av-unknown-fg)'
  const style = { width: size, height: size, background: bg, color: fg }
  // 自定义轮廓里用到的「挖空」色是这一组自己的底色
  const punch = def?.color ? `var(--av-c-${def.color}-bg)` : 'var(--av-unknown-bg)'

  return (
    <span className="agent-avatar" style={style} aria-hidden="true">
      <svg viewBox="0 0 28 28" width={size} height={size}>
        {kind === 'general' && (
          <>
            <circle cx="14" cy="14" r="10.4" fill="currentColor" opacity="0.22" stroke="currentColor" strokeOpacity="0.3" />
            <circle cx="10.6" cy="13" r="1.7" fill="currentColor" />
            <circle cx="17.4" cy="13" r="1.7" fill="currentColor" />
            <path d="M11.8 18q2.2 1.5 4.4 0" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </>
        )}
        {kind === 'dev' && (
          <>
            <rect x="13" y="5" width="2" height="5.5" rx="1" fill="currentColor" />
            <circle cx="14" cy="4.4" r="2" fill="currentColor" />
            <rect x="5.6" y="10" width="16.8" height="12.4" rx="4.4" fill="currentColor" />
            <rect x="9.6" y="14" width="3.2" height="3.2" rx="1" fill="var(--av-dev-bg)" />
            <rect x="15.2" y="14" width="3.2" height="3.2" rx="1" fill="var(--av-dev-bg)" />
            <path d="M12 18.6h4" stroke="var(--av-dev-bg)" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
        {kind === 'product' && (
          <>
            <path
              d="M5.6 16a8.4 8.4 0 0 1 16.8 0v6.6l-2.8-2.1-2.8 2.1-2.8-2.1-2.8 2.1-2.8-2.1-2.8 2.1z"
              fill="currentColor"
            />
            <circle cx="11" cy="14" r="1.5" fill="var(--av-product-bg)" />
            <circle cx="17" cy="14" r="1.5" fill="var(--av-product-bg)" />
            <path d="M12.4 17.6q1.6 1.1 3.2 0" stroke="var(--av-product-bg)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          </>
        )}
        {kind === 'custom' && (
          <>
            <rect x="4.6" y="4.6" width="18.8" height="18.8" rx="6" fill="currentColor" opacity="0.9" />
            <rect x="9.2" y="11" width="2.6" height="2.6" rx="1.3" fill={punch} />
            <rect x="16.2" y="11" width="2.6" height="2.6" rx="1.3" fill={punch} />
            <path d="M10.8 17.4h6.4" stroke={punch} strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
        {kind === 'unknown' && (
          <>
            <circle cx="14" cy="14" r="10.4" fill="currentColor" opacity="0.18" stroke="currentColor" strokeOpacity="0.5" strokeDasharray="3 3" />
            <path d="M10.6 14h6.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  )
}
