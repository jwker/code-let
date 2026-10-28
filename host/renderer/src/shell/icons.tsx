import type { ReactNode } from 'react'

/** 24×24 描边图标，统一 currentColor */
export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
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

export const IconPlus = () => (
  <Icon>
    <path d="M12 5v14M5 12h14" />
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
