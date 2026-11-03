import { isAbsolute } from 'node:path'
import { ATTACHMENT_LIMITS, type FileContent } from '@contract/index'
import { readFileContent } from './files'
import { resizeImageForPrompt } from './imageResize'

/**
 * 把 `@` 选中的文件准备成一次 prompt 的附件。
 *
 * 渲染进程只传**项目内的相对路径**；读取、越界校验、大小限制全在主进程做。
 * 文本文件包成 `<file name="...">` 块（跟 Pi CLI 的 `@file` 参数同一形状）；
 * 图片走 `PromptOptions.images`，同时在正文里留一个空的 `<file>` 标记。
 */

/** 跟 Pi 的 `ImageContent` 结构一致，避免把 Pi 的类型带进这一层 */
export interface PromptImage {
  type: 'image'
  mimeType: string
  data: string
}

export interface PreparedAttachments {
  /** 拼在用户正文后面的 `<file>` 块；没有附件时是空串 */
  text: string
  images: PromptImage[]
}

const DATA_URL = /^data:([^;]+);base64,([\s\S]*)$/

function fail(path: string, reason: string): Error {
  return new Error(`附件「${path}」${reason}`)
}

function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`
}

function escapeName(name: string): string {
  return name
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 读并校验附件；任何一条不合格都整次失败，不做部分发送 */
export async function prepareAttachments(
  cwd: string,
  paths: readonly string[]
): Promise<PreparedAttachments> {
  const unique = [...new Set(paths)]
  if (unique.length > ATTACHMENT_LIMITS.maxCount) {
    throw new Error(`附件最多 ${ATTACHMENT_LIMITS.maxCount} 个`)
  }

  const blocks: string[] = []
  const images: PromptImage[] = []
  let textBytes = 0
  let imageBytes = 0

  for (const path of unique) {
    if (isAbsolute(path)) throw fail(path, '必须用项目内的相对路径')

    let content: FileContent
    try {
      content = await readFileContent(cwd, path)
    } catch (error) {
      throw fail(path, `读不了：${error instanceof Error ? error.message : String(error)}`)
    }

    if (content.kind === 'unsupported') {
      throw fail(path, `不能作为附件：${content.reason}`)
    }

    if (content.kind === 'image') {
      if (content.size > ATTACHMENT_LIMITS.maxImageFileBytes) {
        throw fail(path, `超过图片单文件上限 ${kb(ATTACHMENT_LIMITS.maxImageFileBytes)}`)
      }
      imageBytes += content.size
      if (imageBytes > ATTACHMENT_LIMITS.maxImageTotalBytes) {
        throw new Error(`图片附件总量超过 ${kb(ATTACHMENT_LIMITS.maxImageTotalBytes)}`)
      }

      const original = DATA_URL.exec(content.dataUrl)
      if (!original) throw fail(path, '图片数据格式不对')

      // 大图先缩到模型能用的最长边；缩放失败就保留原图
      const resized = await resizeImageForPrompt(content.dataUrl, original[1])
      const payload = DATA_URL.exec(resized?.dataUrl ?? content.dataUrl)
      if (!payload) throw fail(path, '图片数据格式不对')

      images.push({ type: 'image', mimeType: payload[1], data: payload[2] })
      blocks.push(`<file name="${escapeName(path)}"></file>`)
      continue
    }

    if (content.binary) throw fail(path, '是二进制文件，不能作为附件')
    if (content.tooLarge) throw fail(path, '太大，不能作为附件')
    if (content.size > ATTACHMENT_LIMITS.maxTextFileBytes) {
      throw fail(path, `超过文本单文件上限 ${kb(ATTACHMENT_LIMITS.maxTextFileBytes)}`)
    }
    textBytes += content.size
    if (textBytes > ATTACHMENT_LIMITS.maxTextTotalBytes) {
      throw new Error(`文本附件总量超过 ${kb(ATTACHMENT_LIMITS.maxTextTotalBytes)}`)
    }
    blocks.push(`<file name="${escapeName(path)}">\n${content.text}\n</file>`)
  }

  return { text: blocks.join('\n'), images }
}
