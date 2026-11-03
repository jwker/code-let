import { describe, expect, it } from 'vitest'
import { fitImageWithin, MAX_IMAGE_EDGE, resizeImageForPrompt } from '../host/main/imageResize'

/**
 * 发送前图片缩放（D33）。
 *
 * 真正的解码/缩放走 Electron 的 nativeImage，在 vitest 里不可用；
 * 这里只验证尺寸计算：只缩不放、保持比例、至少 1 像素。
 */
describe('图片缩放尺寸', () => {
  it('长边超过上限时等比缩小', () => {
    expect(fitImageWithin(3000, 1500, MAX_IMAGE_EDGE)).toEqual({ width: 1568, height: 784 })
    expect(fitImageWithin(1000, 3000, MAX_IMAGE_EDGE)).toEqual({ width: 523, height: 1568 })
  })

  it('已经在上限内就原样返回', () => {
    expect(fitImageWithin(800, 600, MAX_IMAGE_EDGE)).toEqual({ width: 800, height: 600 })
    expect(fitImageWithin(1568, 1568, MAX_IMAGE_EDGE)).toEqual({ width: 1568, height: 1568 })
  })

  it('极端比例也不会算出 0 像素', () => {
    expect(fitImageWithin(10_000, 1, MAX_IMAGE_EDGE)).toEqual({ width: 1568, height: 1 })
  })

  it('没有 Electron 的测试环境直接返回 null，保留原图', async () => {
    await expect(resizeImageForPrompt('data:image/png;base64,AAAA', 'image/png')).resolves.toBeNull()
  })
})
