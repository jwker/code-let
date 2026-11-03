/** 图片进模型前允许的最长边 —— 再大只会吃 token，不会带来更多细节 */
export const MAX_IMAGE_EDGE = 1568

const DATA_URL = /^data:([^;]+);base64,([\s\S]*)$/

export interface ResizedImage {
  dataUrl: string
  mimeType: string
  /** 缩放后的二进制字节数 */
  size: number
}

/**
 * 把图片按最长边等比缩到 `maxEdge` 以内。
 *
 * 只缩不放；合法尺寸原样返回。单独抽出来是为了能在没有 Electron 的测试里验证。
 */
export function fitImageWithin(
  width: number,
  height: number,
  maxEdge: number
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

/**
 * 发送图片前缩放（只在 Electron 主进程里生效）。
 *
 * 用 Electron 自带的 `nativeImage`，不引入图像处理依赖。只处理 PNG / JPEG：
 * GIF 可能是动图，WebP/AVIF 的支持取决于 Chromium 版本，宁可不缩也不要把图弄坏。
 * 缩放失败、输出反而更大、或者取不到尺寸时都返回 null，调用方保留原图。
 */
export async function resizeImageForPrompt(
  dataUrl: string,
  mimeType: string
): Promise<ResizedImage | null> {
  if (typeof process.versions.electron !== 'string') return null
  if (mimeType !== 'image/png' && mimeType !== 'image/jpeg') return null

  const match = DATA_URL.exec(dataUrl)
  if (!match) return null
  const original = Buffer.from(match[2], 'base64')

  try {
    const { nativeImage } = await import('electron')
    const image = nativeImage.createFromBuffer(original)
    if (image.isEmpty()) return null

    const size = image.getSize()
    const target = fitImageWithin(size.width, size.height, MAX_IMAGE_EDGE)
    if (target.width === size.width && target.height === size.height) return null

    const resized = image.resize({ ...target, quality: 'good' })
    const output = mimeType === 'image/jpeg' ? resized.toJPEG(85) : resized.toPNG()
    if (output.length === 0 || output.length >= original.length) return null

    const outMime = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png'
    return {
      dataUrl: `data:${outMime};base64,${output.toString('base64')}`,
      mimeType: outMime,
      size: output.length
    }
  } catch {
    // 图片格式/解码问题不应该挡住发送，原图照常走
    return null
  }
}
