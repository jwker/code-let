import type { CodeletApi } from '@contract/index'
import { createMockApi } from './mock/host'

/**
 * 渲染进程拿宿主能力的唯一入口。
 *
 * Electron 里是 preload 暴露的 window.codelet；
 * 直接在浏览器里打开（预览模式）时没有它，退回假宿主。
 */
export const host: CodeletApi = window.codelet ?? createMockApi()

/** 是不是浏览器预览（假数据） */
export const isPreview = !window.codelet
