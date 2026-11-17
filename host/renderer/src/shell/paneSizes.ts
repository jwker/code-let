/**
 * 侧栏与区域 5 的宽度上下限。
 *
 * 默认值在 CSS 里也写了一份（`.shell` 的 --side-w / --zone5-w），
 * 这里的是「拖拽时」用的边界：装载时读一次 localStorage，拖完写回去。
 * 窄轨是固定宽度，跟 CSS 的 --rail-w 必须一致，否则算出来的区域 6 宽度会差一截。
 */
export const RAIL_W = 56

/**
 * 主区至少留这么宽。
 *
 * 这不是内容列的下限 —— 只是「还看得出会话区在这儿」的一条缝。
 * 检视器不设上限，想铺多大就多大，主区让位给它。
 */
export const MAIN_MIN = 160

/**
 * 侧栏：默认宽度就是最小宽度 —— 打开时尽量把地方让给主区。
 *
 * 拖宽之后会记在 localStorage 里，下次还是你拖的那个宽度；
 * 双击拖拽条复位时回到这个默认值。
 */
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 360
export const SIDEBAR_DEFAULT = SIDEBAR_MIN

const SIDEBAR_KEY = 'codelet:sidebar-width'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

/** 读一个存过的宽度；没存过、存坏了、超出上下限都退回默认值 */
function load(key: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  try {
    const raw = Number(localStorage.getItem(key))
    if (!Number.isFinite(raw) || raw <= 0) return fallback
    return clamp(raw, min, max)
  } catch {
    return fallback
  }
}

function save(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(width))
  } catch {
    // 存不下就算了
  }
}

export function loadSidebarWidth(): number {
  return load(SIDEBAR_KEY, SIDEBAR_DEFAULT, SIDEBAR_MIN, SIDEBAR_MAX)
}

export function saveSidebarWidth(width: number): void {
  save(SIDEBAR_KEY, width)
}

/**
 * 左栏能拖到多宽：窗口减去导航轨、区域 5 和给区域 6 留的那条缝。
 * 窗口太窄时上限会低于下限，这时按最小宽度算 —— 宁可区域 6 没地方，也不让侧栏消失。
 */
export function sidebarCeiling(zone5Track: number, windowWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, windowWidth - RAIL_W - zone5Track - MAIN_MIN))
}

/** 把宽度收进上下限（鼠标拖拽和键盘微调共用） */
export function clampSidebar(width: number, zone5Track: number, windowWidth: number): number {
  return clamp(width, SIDEBAR_MIN, sidebarCeiling(zone5Track, windowWidth))
}
