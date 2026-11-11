import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 窗口位置与大小 —— 记在应用数据目录里，下次启动恢复。
 *
 * 没有记过就用「铺满屏幕」当默认值。
 *
 * 只记这一份，不进 settings.json —— 那是给人看的设置项注册表，
 * 窗口状态不是设置项，不该占用那套校验。
 *
 * 这个文件**不引 electron** —— 纯逻辑，好测。跟屏幕有关的那部分
 * （读显示器、摆窗口）留在 index.ts 那侧。
 */

/** 存下来的窗口状态 */
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  /** 用户当时把窗口放到最大了没 */
  maximized?: boolean
}

/** 一块屏幕的工作区 */
export interface WorkArea {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 读窗口状态。文件不存在或坏了就当没有 —— 不因为一个状态文件卡住启动。
 */
export function loadWindowState(file: string): WindowState | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<WindowState>
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null
    if (!Number.isFinite(parsed.width) || !Number.isFinite(parsed.height)) return null
    if (parsed.width < 200 || parsed.height < 200) return null
    return {
      x: typeof parsed.x === 'number' ? parsed.x : undefined,
      y: typeof parsed.y === 'number' ? parsed.y : undefined,
      width: Math.round(parsed.width),
      height: Math.round(parsed.height),
      maximized: parsed.maximized === true
    }
  } catch {
    return null
  }
}

/** 写窗口状态。写不进去只影响下次启动的尺寸，不影响本次 */
export function saveWindowState(file: string, state: WindowState): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  } catch {
    // 存不下就算了
  }
}

/**
 * 位置还在不在某块屏幕上。
 *
 * 拔掉显示器之后存下来的位置会落在虚空里 —— 窗口会开在看不见的地方。
 * 这时候宁可回到铺满屏幕。
 */
export function isOnSomeDisplay(state: WindowState, workAreas: WorkArea[]): boolean {
  if (state.x === undefined || state.y === undefined) return false
  return workAreas.some((area) => {
    return (
      state.x! < area.x + area.width &&
      state.x! + state.width > area.x &&
      state.y! < area.y + area.height &&
      state.y! + state.height > area.y
    )
  })
}

/** 窗口状态文件的位置 */
export function windowStateFile(userDataDir: string): string {
  return join(userDataDir, 'window-state.json')
}
