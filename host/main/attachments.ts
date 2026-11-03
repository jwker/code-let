import { basename, isAbsolute } from 'node:path'
import { ATTACHMENT_LIMITS, type FileContent } from '@contract/index'
import { estimateTextTokens, IMAGE_TOKEN_ESTIMATE } from '@contract/attachments'
import { readFileContent, readFileContentAbsolute } from './files'
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

/** 系统文件选择器选中的外部附件；path 只留在主进程 */
export interface ExternalAttachment {
  id: string
  name: string
  path: string
}

export interface AttachmentInfo {
  kind: 'text' | 'image'
  size: number
  tokens: number
}

export type AttachmentInspection = { attachment: AttachmentInfo } | { error: string }

/** 把一个已经读出来的文件判成可附件 / 不可附件，选择器和发送共用 */
export function inspectContent(content: FileContent): AttachmentInspection {
  if (content.kind === 'unsupported') {
    return { error: `不能作为附件：${content.reason}` }
  }
  if (content.kind === 'image') {
    if (content.size > ATTACHMENT_LIMITS.maxImageFileBytes) {
      return { error: `超过图片单文件上限 ${kb(ATTACHMENT_LIMITS.maxImageFileBytes)}` }
    }
    return { attachment: { kind: 'image', size: content.size, tokens: IMAGE_TOKEN_ESTIMATE } }
  }
  if (content.binary) return { error: '是二进制文件，不能作为附件' }
  if (content.tooLarge) return { error: '太大，不能作为附件' }
  if (content.size > ATTACHMENT_LIMITS.maxTextFileBytes) {
    return { error: `超过文本单文件上限 ${kb(ATTACHMENT_LIMITS.maxTextFileBytes)}` }
  }
  return {
    attachment: { kind: 'text', size: content.size, tokens: estimateTextTokens(content.text) }
  }
}

/** 读系统选择器选中的外部文件并判定；只在校验通过后返回元信息 */
export async function inspectExternalFile(path: string): Promise<AttachmentInspection> {
  const content = await readFileContentAbsolute(path)
  return inspectContent(content)
}

export function externalAttachmentName(path: string): string {
  return basename(path)
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

/**
 * 读并校验附件；任何一条不合格都整次失败，不做部分发送。
 *
 * paths 是项目内相对路径；external 是系统选择器批准过的绝对路径。
 */
export async function prepareAttachments(
  cwd: string,
  paths: readonly string[],
  external: readonly ExternalAttachment[] = []
): Promise<PreparedAttachments> {
  const sources: Array<{ key: string; name: string; read: () => Promise<FileContent> }> = []
  const seen = new Set<string>()

  for (const path of paths) {
    if (isAbsolute(path)) throw fail(path, '必须用项目内的相对路径')
    if (seen.has(`project:${path}`)) continue
    seen.add(`project:${path}`)
    sources.push({ key: `project:${path}`, name: path, read: () => readFileContent(cwd, path) })
  }
  for (const upload of external) {
    if (seen.has(`upload:${upload.id}`)) continue
    seen.add(`upload:${upload.id}`)
    sources.push({
      key: `upload:${upload.id}`,
      name: upload.name,
      read: () => readFileContentAbsolute(upload.path)
    })
  }

  if (sources.length > ATTACHMENT_LIMITS.maxCount) {
    throw new Error(`附件最多 ${ATTACHMENT_LIMITS.maxCount} 个`)
  }

  const blocks: string[] = []
  const images: PromptImage[] = []
  let textBytes = 0
  let imageBytes = 0

  for (const source of sources) {
    let content: FileContent
    try {
      content = await source.read()
    } catch (error) {
      throw fail(source.name, `读不了：${error instanceof Error ? error.message : String(error)}`)
    }

    const checked = inspectContent(content)
    if ('error' in checked) throw fail(source.name, checked.error)
    if (content.kind === 'unsupported') throw fail(source.name, '不能作为附件')

    if (content.kind === 'image') {
      imageBytes += content.size
      if (imageBytes > ATTACHMENT_LIMITS.maxImageTotalBytes) {
        throw new Error(`图片附件总量超过 ${kb(ATTACHMENT_LIMITS.maxImageTotalBytes)}`)
      }

      const original = DATA_URL.exec(content.dataUrl)
      if (!original) throw fail(source.name, '图片数据格式不对')

      // 大图先缩到模型能用的最长边；缩放失败就保留原图
      const resized = await resizeImageForPrompt(content.dataUrl, original[1])
      const payload = DATA_URL.exec(resized?.dataUrl ?? content.dataUrl)
      if (!payload) throw fail(source.name, '图片数据格式不对')

      images.push({ type: 'image', mimeType: payload[1], data: payload[2] })
      blocks.push(`<file name="${escapeName(source.name)}"></file>`)
      continue
    }

    textBytes += content.size
    if (textBytes > ATTACHMENT_LIMITS.maxTextTotalBytes) {
      throw new Error(`文本附件总量超过 ${kb(ATTACHMENT_LIMITS.maxTextTotalBytes)}`)
    }
    blocks.push(`<file name="${escapeName(source.name)}">\n${content.text}\n</file>`)
  }

  return { text: blocks.join('\n'), images }
}
