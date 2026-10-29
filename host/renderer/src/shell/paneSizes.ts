/**
 * 三栏的宽度上下限。
 *
 * 默认值在 CSS 里也写了一份（`.shell` 的 --side-w / --insp-w），
 * 这里的是「拖拽时」用的边界：装载时读一次 localStorage，拖完写回去。
 * 导航轨是固定宽度，跟 CSS 的 --rail-w 必须一致，否则算出来的主区宽度会差一截。
 */
export const RAIL_W = 56

/** 主区至少留这么宽，不然内容列（720）会被挤成一团 */
export const MAIN_MIN = 420

export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 360
export const SIDEBAR_DEFAULT = 264

export const INSPECTOR_MIN = 260
export const INSPECTOR_MAX = 480
export const INSPECTOR_DEFAULT = 300

const SIDEBAR_KEY = 'codelet:sidebar-width'
const INSPECTOR_KEY = 'codelet:inspector-width'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), max)
}

/** 读一个存过的宽度；没存过、存坏了、超出上下限都退回默认值 */
function load(key: string, fallback: number, min: number, max: number): number {
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

export function loadInspectorWidth(): number {
  return load(INSPECTOR_KEY, INSPECTOR_DEFAULT, INSPECTOR_MIN, INSPECTOR_MAX)
}

export function saveInspectorWidth(width: number): void {
  save(INSPECTOR_KEY, width)
}

/**
 * 左栏能拖到多宽：窗口减去导航轨、检视器和给主区留的下限。
 * 窗口太窄时上限会低于下限，这时按最小宽度算 —— 宁可主区挤一点，也不让侧栏消失。
 */
export function sidebarCeiling(inspectorTrack: number, windowWidth: number): number {
  return Math.max(
    SIDEBAR_MIN,
    Math.min(SIDEBAR_MAX, windowWidth - RAIL_W - inspectorTrack - MAIN_MIN)
  )
}

export function inspectorCeiling(sidebarWidth: number, windowWidth: number): number {
  return Math.max(
    INSPECTOR_MIN,
    Math.min(INSPECTOR_MAX, windowWidth - RAIL_W - sidebarWidth - MAIN_MIN)
  )
}

/** 把宽度收进上下限（鼠标拖拽和键盘微调共用） */
export function clampSidebar(width: number, inspectorTrack: number, windowWidth: number): number {
  return clamp(width, SIDEBAR_MIN, sidebarCeiling(inspectorTrack, windowWidth))
}

export function clampInspector(width: number, sidebarWidth: number, windowWidth: number): number {
  return clamp(width, INSPECTOR_MIN, inspectorCeiling(sidebarWidth, windowWidth))
}
