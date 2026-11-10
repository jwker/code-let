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

/** 浏览器 —— 一个带经纬线的地球 */
export const IconBrowser = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="M4 12h16M12 4c2.4 2.2 3.6 4.9 3.6 8s-1.2 5.8-3.6 8c-2.4-2.2-3.6-4.9-3.6-8S9.6 6.2 12 4z" />
  </Icon>
)

/** Git —— 一条分支线上两个提交点 */
export const IconGit = () => (
  <Icon>
    <circle cx="7" cy="6" r="2.4" />
    <circle cx="7" cy="18" r="2.4" />
    <circle cx="17" cy="9" r="2.4" />
    <path d="M7 8.4v7.2" />
    <path d="M17 11.4c0 3.2-2.6 4.6-6 4.9" />
  </Icon>
)

/** Agent —— 一个带天线的机器人脑袋 */
export const IconAgent = () => (
  <Icon>
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 4v4" />
    <circle cx="12" cy="3" r="1.2" />
    <circle cx="9" cy="14" r="1" />
    <circle cx="15" cy="14" r="1" />
  </Icon>
)

export const IconContext = () => (
  <Icon>
    <path d="M4 7h16M4 12h10M4 17h7" />
    <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="14" cy="17" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconTerminal = () => (
  <Icon>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </Icon>
)

/** 调试控制台 —— 终端加一个指示点 */
export const IconConsole = () => (
  <Icon>
    <path d="m4 17 6-6-6-6M12 19h8" />
    <circle cx="18" cy="7" r="2" fill="currentColor" stroke="none" />
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

export const IconFolder = ({ size = 18 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5z" />
  </Icon>
)

/**
 * 两根滑杆 —— 侧栏头部的「项目选项」入口。
 *
 * 刻意不用「⋯」：组头的「⋯」是「这一组的更多」，这里的 sliders 是「这一块的选项」，
 * 形状不一样才不会认成同一个东西。
 */
export const IconSliders = ({ size = 16 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 7h6M16 7h4M4 17h4M14 17h6" />
    <circle cx="13" cy="7" r="2.2" />
    <circle cx="11" cy="17" r="2.2" />
  </Icon>
)

/**
 * 双上箭头 —— 全部收起（内容往里收）。
 *
 * 两道箭头的尖隔开 8 个单位（24 的画布里）：15px 下只隔 3.75px，
 * 看着就是一个粗箭头，分不出是「双」箭头。
 */
export const IconCollapseAll = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m7 10 5-5 5 5" />
    <path d="m7 18 5-5 5 5" />
  </Icon>
)

/** 双下箭头 —— 全部展开 */
export const IconExpandAll = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m7 6 5 5 5-5" />
    <path d="m7 14 5 5 5-5" />
  </Icon>
)

export const IconPencil = ({ size = 18 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
  </Icon>
)

export const IconArrowUp = () => (
  <Icon>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Icon>
)

/**
 * 停止 —— 实心方块。
 *
 * 全站图标都是 1.6px 描边的线性风格，这个是唯一一个例外：
 * 它是「按下去会打断正在进行的事情」的那个钮，实心在 18px 下重得多，
 * 扫一眼不会跟旁边的发送箭头混。
 *
 * 尺寸取 10×10 居中（不是描边图的 12×12）—— 实心方形视觉上比同尺寸的描边方
 * 看着大一圈，收到 10 才跟箭头一样重。
 */
export const IconStop = () => (
  <Icon>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" />
  </Icon>
)

export const IconPaperclip = () => (
  <Icon size={16}>
    <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l8.9-8.9a4 4 0 1 1 5.7 5.7l-8.9 8.9a2 2 0 1 1-2.8-2.8l8.2-8.2" />
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

/** 废纸篓 —— 单条删除与会话选择模式里的删除按钮 */
export const IconTrash = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7M10 11v5M14 11v5" />
  </Icon>
)

/** 全选 —— 勾选标记 + 两条横线 */
export const IconSelectAll = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <path d="m3 6.5 1.8 1.8L8 5M3 15.5l1.8 1.8L8 14M11 7h10M11 16h10" />
  </Icon>
)

/** 清空选择 —— 方框里一道横线，跟全选的勾选标记区分开 */
export const IconClearSelection = ({ size = 15 }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M8 12h8" />
  </Icon>
)
