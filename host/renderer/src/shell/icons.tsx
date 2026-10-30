import type { ReactNode } from 'react'

/** 24×24 描边图标，统一 currentColor */
export function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export const IconSession = () => (
  <Icon>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Icon>
)

export const IconBoard = () => (
  <Icon>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="4" height="10" rx="1" />
    <rect x="16" y="4" width="5" height="7" rx="1" />
  </Icon>
)

export const IconMemory = () => (
  <Icon>
    <circle cx="12" cy="5" r="2.5" />
    <circle cx="5" cy="18" r="2.5" />
    <circle cx="19" cy="18" r="2.5" />
    <path d="M10.6 6.9 6.4 15.7M13.4 6.9l4.2 8.8M7.6 18h8.8" />
  </Icon>
)

export const IconCode = () => (
  <Icon>
    <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
  </Icon>
)

export const IconTerminal = () => (
  <Icon>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </Icon>
)

export const IconPanelLeft = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M9 4v16" />
  </Icon>
)

export const IconPanelRight = () => (
  <Icon>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M15 4v16" />
  </Icon>
)

export const IconSettings = () => (
  <Icon>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </Icon>
)

export const IconChevron = () => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
)

/**
 * 折叠指示：实心三角，收起时向右，展开时向下。
 *
 * 之前用的是文字字符 ▸ / ▾ —— 那是 U+25B8「小三角」，字形墨迹只占 em 盒
 * 一小部分（12px 字号下实际墨迹只有 5.6px），而且贴着基线画，上下不居中。
 * 改用 SVG：尺寸就是实际尺寸，位置由 flex 对齐控制。
 *
 * viewBox 是 24，但路径只占中间的 14×17 —— 墨迹实际约 7.6×9.2px。
 */
export const IconCaret = ({ open }: { open: boolean }) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    style={{
      transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
      transition: 'transform 140ms ease',
    }}
  >
    <path d="M5 3.5 L19 12 L5 20.5 Z" />
  </svg>
)

export const IconPlus = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const IconFolder = () => (
  <Icon>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z" />
  </Icon>
)

export const IconPencil = () => (
  <Icon>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
)

export const IconArrowUp = () => (
  <Icon>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
)

/** 跳到顶部 / 底部用「箭头 + 横线」—— 别跟发送那个光箭头长一样 */
export const IconArrowUpToLine = () => (
  <Icon>
    <path d="M5 4h14" />
    <path d="M12 20V9.5" />
    <path d="m6.5 14 5.5-5.5 5.5 5.5" />
  </Icon>
)

export const IconArrowDownToLine = () => (
  <Icon>
    <path d="M5 20h14" />
    <path d="M12 4v10.5" />
    <path d="m6.5 10 5.5 5.5 5.5-5.5" />
  </Icon>
)

export const IconMore = () => (
  <Icon>
    <circle cx="5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconSun = () => (
  <Icon>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Icon>
)

export const IconMoon = () => (
  <Icon>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Icon>
)

/** 复制：两张叠着的纸 */
export const IconCopy = () => (
  <Icon size={12}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Icon>
)

/** 复制成功：打勾 */
export const IconCheck = () => (
  <Icon size={12}>
    <polyline points="20 6 9 17 4 12" />
  </Icon>
)
