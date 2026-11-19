import { describe, expect, it } from 'vitest'
import { restorablePreviewUrl } from '../host/main/browser'

/**
 * 「上次预览的地址还能不能用」。
 *
 * 只认本地文件：http 预览（dev server）下次启动多半没起，恢复出一个加载失败的
 * 页面比空态更糟；文件不在了也一样。这一段是纯判断，存在性从外面传进来。
 */

const known = new Set(['/work/app/preview/pricing.html'])
const exists = (path: string): boolean => known.has(path)

describe('记录下来的预览地址', () => {
  it('本地文件还在：原样恢复', () => {
    expect(restorablePreviewUrl('file:///work/app/preview/pricing.html', exists)).toBe(
      'file:///work/app/preview/pricing.html'
    )
  })

  it('本地文件不在了：当没有记录', () => {
    expect(restorablePreviewUrl('file:///work/app/preview/gone.html', exists)).toBeNull()
  })

  it('http 地址不恢复 —— dev server 下次多半没起', () => {
    expect(restorablePreviewUrl('http://localhost:5173/preview/x.html', exists)).toBeNull()
  })

  it('空值、空白页、坏掉的 file: 地址都不恢复', () => {
    expect(restorablePreviewUrl(null, exists)).toBeNull()
    expect(restorablePreviewUrl(undefined, exists)).toBeNull()
    expect(restorablePreviewUrl('', exists)).toBeNull()
    expect(restorablePreviewUrl('about:blank', exists)).toBeNull()
    expect(restorablePreviewUrl('file:', exists)).toBeNull()
  })

  it('存在性判断用的是解析出来的绝对路径', () => {
    const seen: string[] = []
    restorablePreviewUrl('file:///work/app/preview/pricing.html', (path) => {
      seen.push(path)
      return true
    })
    expect(seen).toEqual(['/work/app/preview/pricing.html'])
  })
})
