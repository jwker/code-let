import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isOnSomeDisplay,
  loadWindowState,
  saveWindowState,
  windowStateFile
} from '../host/main/windowState'

/**
 * 窗口位置与大小的存取。
 *
 * 这一层是纯逻辑（不引 electron），所以能直接测。
 * 界面那边怎么摆窗口在 `host/main/index.ts` 里。
 */

let dir = ''
let file = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'codelet-window-'))
  file = windowStateFile(dir)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('窗口状态', () => {
  it('没存过时读出来是空', () => {
    expect(loadWindowState(file)).toBeNull()
  })

  it('存了能读回来', () => {
    saveWindowState(file, { x: 100, y: 80, width: 1200, height: 760, maximized: false })
    expect(loadWindowState(file)).toEqual({
      x: 100,
      y: 80,
      width: 1200,
      height: 760,
      maximized: false
    })
  })

  it('文件坏了就当没有 —— 不因为一个状态文件卡住启动', () => {
    writeFileSync(file, '这不是 JSON')
    expect(loadWindowState(file)).toBeNull()
  })

  it('尺寸不合法就当没有', () => {
    writeFileSync(file, JSON.stringify({ width: 10, height: 10 }))
    expect(loadWindowState(file)).toBeNull()
  })

  it('位置在某块屏幕上就算数', () => {
    const areas = [{ x: 0, y: 0, width: 2560, height: 1410 }]
    expect(isOnSomeDisplay({ x: 100, y: 80, width: 1200, height: 760 }, areas)).toBe(true)
  })

  it('显示器拔了之后位置落在虚空里 —— 不算数', () => {
    // 存的时候在左边那块屏，拔了之后只剩右边这块
    const areas = [{ x: 1920, y: 0, width: 1280, height: 1024 }]
    expect(isOnSomeDisplay({ x: 0, y: 80, width: 1200, height: 760 }, areas)).toBe(false)
  })

  it('只有一半搭在屏幕上也算数 —— 拖到边缘时窗口还有一半看得见', () => {
    const areas = [{ x: 0, y: 0, width: 1280, height: 1024 }]
    expect(isOnSomeDisplay({ x: 1200, y: 80, width: 1200, height: 760 }, areas)).toBe(true)
  })

  it('没有位置就无从判断', () => {
    expect(isOnSomeDisplay({ width: 1200, height: 760 }, [{ x: 0, y: 0, width: 100, height: 100 }])).toBe(false)
  })
})
