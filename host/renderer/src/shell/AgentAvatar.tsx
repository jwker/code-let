import type { AgentType } from '@contract/index'

/**
 * agent 头像（PLAN.md D53）。
 *
 * 三种类型三种轮廓 —— 窄轨里只有 28px，颜色和形状是唯一能远看的信号。
 * 不写字：28px 放不下字，名字靠悬停气泡（`title`）和右键菜单。
 *
 * 一律用 `currentColor` 之外的 CSS 变量取色，不写死色值（底线 1）。
 */
export function AgentAvatar({ type, size = 28 }: { type: AgentType; size?: number }) {
  const style = {
    width: size,
    height: size,
    background: `var(--av-${type}-bg)`,
    color: `var(--av-${type}-fg)`
  }

  return (
    <span className="agent-avatar" style={style} aria-hidden="true">
      <svg viewBox="0 0 28 28" width={size} height={size}>
        {type === 'general' && (
          <>
            <circle cx="14" cy="14" r="10.4" fill="currentColor" opacity="0.22" stroke="currentColor" strokeOpacity="0.3" />
            <circle cx="10.6" cy="13" r="1.7" fill="currentColor" />
            <circle cx="17.4" cy="13" r="1.7" fill="currentColor" />
            <path d="M11.8 18q2.2 1.5 4.4 0" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          </>
        )}
        {type === 'dev' && (
          <>
            <rect x="13" y="5" width="2" height="5.5" rx="1" fill="currentColor" />
            <circle cx="14" cy="4.4" r="2" fill="currentColor" />
            <rect x="5.6" y="10" width="16.8" height="12.4" rx="4.4" fill="currentColor" />
            <rect x="9.6" y="14" width="3.2" height="3.2" rx="1" fill="var(--av-dev-bg)" />
            <rect x="15.2" y="14" width="3.2" height="3.2" rx="1" fill="var(--av-dev-bg)" />
            <path d="M12 18.6h4" stroke="var(--av-dev-bg)" strokeWidth="1.5" strokeLinecap="round" />
          </>
        )}
        {type === 'product' && (
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
      </svg>
    </span>
  )
}
