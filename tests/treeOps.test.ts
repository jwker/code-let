import { describe, expect, it } from 'vitest'
import { assertTreeNavigable, toNavigateResult } from '../host/main/pi/treeOps'

/**
 * 切支线的拦阻与返回值。
 *
 * 这两条是 PiRuntime 里唯一能脱离真 runtime 测的部分：
 * 什么状态不让切、Pi 的返回怎么变成渲染层的形状。
 */

const idle = { isStreaming: false, isCompacting: false, model: { id: 'm' } }

describe('assertTreeNavigable', () => {
  it('runtime 没建起来：说清楚是没启动', () => {
    expect(() => assertTreeNavigable(null)).toThrow('runtime 尚未启动')
  })

  it('正在生成：等这一轮结束再切', () => {
    expect(() => assertTreeNavigable({ ...idle, isStreaming: true })).toThrow('等这一轮结束再切支线')
  })

  it('正在压缩：同样等结束', () => {
    expect(() => assertTreeNavigable({ ...idle, isCompacting: true })).toThrow('等这一轮结束再切支线')
  })

  it('要总结但没有模型：报没有模型，别的操作不受影响', () => {
    const noModel = { ...idle, model: null }
    expect(() => assertTreeNavigable(noModel, { summarize: true })).toThrow('当前没有模型，无法总结支线')
    expect(() => assertTreeNavigable(noModel)).not.toThrow()
  })

  it('空闲且有模型：放行', () => {
    expect(() => assertTreeNavigable(idle)).not.toThrow()
  })
})

describe('toNavigateResult', () => {
  it('editorText 原样传回（空串也是原文，不能当没有）', () => {
    expect(toNavigateResult({ cancelled: false, editorText: '改一下这句' })).toEqual({
      cancelled: false,
      editorText: '改一下这句'
    })
    expect(toNavigateResult({ cancelled: false, editorText: '' })).toEqual({ cancelled: false, editorText: '' })
    expect(toNavigateResult({ cancelled: false })).toEqual({ cancelled: false })
  })

  it('中止标记只在真的中止时出现', () => {
    expect(toNavigateResult({ cancelled: false, aborted: true })).toEqual({ cancelled: false, aborted: true })
    expect('aborted' in toNavigateResult({ cancelled: false })).toBe(false)
  })

  it('取消也照样传回来', () => {
    expect(toNavigateResult({ cancelled: true })).toEqual({ cancelled: true })
  })
})
