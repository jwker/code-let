/**
 * 右栏宽度的算法（票 02）。
 *
 * 宽度是窗口级偏好，不按项目标签记：默认是窗口宽度的一半，夹在 380–900 之间；
 * 用户拖过之后就用拖出来的像素值，窗口缩放时不再重算。
 *
 * 纯函数，不碰 DOM —— 这几条边界（13 寸屏不超半屏、外接大屏不窄成一条缝）
 * 用单元测试盯住比在真窗口里量更稳。
 */

/** 右栏最窄能拖到多少 —— 再窄文件树和代码都只剩半行字 */
export const RIGHT_PANEL_MIN = 380
/** 右栏最宽能拖到多少 */
export const RIGHT_PANEL_MAX = 900

/** 把任意宽度夹回可拖范围，并取整 */
export function clampRightPanelWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), RIGHT_PANEL_MIN), RIGHT_PANEL_MAX)
}

/** 默认宽度：当前窗口的一半，再夹一次 */
export function defaultRightPanelWidth(windowWidth: number): number {
  return clampRightPanelWidth(windowWidth / 2)
}
