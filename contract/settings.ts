/**
 * 设置项注册表。
 *
 * 设置页是通用的：左侧是分类，右侧是这一类里的设置项。
 * **设置项本身是一份数据**，加一项就是往这份表里加一条 —— 页面结构不用动。
 *
 * 取值放在主进程（`<userData>/settings.json`），这里只声明有哪些项、默认是什么、
 * 控件长什么样。渲染进程按这份表渲染，主进程按这份表取默认值、校验取值。
 */

/** 控件类型 */
export type SettingControl = 'switch' | 'number' | 'text' | 'info' | 'action'

export interface SettingCategory {
  id: string
  title: string
  /** 排序，小的在前 */
  order: number
}

export interface SettingItem {
  id: string
  category: string
  label: string
  description?: string
  control: SettingControl
  /** 默认值。switch 是 boolean，number 是数字 */
  default?: unknown
  min?: number
  max?: number
  unit?: string
  /** info 项的取数来源：渲染进程按这个 id 找对应的函数 */
  info?: 'consoleStats'
  /** action 项：渲染进程按这个 id 找对应的处理函数 */
  action?: 'consoleClear'
  /** 危险操作 —— 按钮用危险色 */
  danger?: boolean
  /** 操作前要确认 */
  confirm?: { title: string; body: string }
}

export const SETTINGS_CATEGORIES: SettingCategory[] = [
  { id: 'general', title: '通用', order: 1 },
  { id: 'debug', title: '调试', order: 2 }
]

export const SETTINGS_ITEMS: SettingItem[] = [
  {
    id: 'console.record',
    category: 'debug',
    label: '记录请求内容',
    description:
      '每次模型请求落一份 transcript、provider payload 和响应。开关打开即生效，不用重启会话。',
    control: 'switch',
    default: true
  },
  {
    id: 'console.maxRecordBytes',
    category: 'debug',
    label: '单条上限',
    description: '超过的记录只留元数据，正文丢弃并标记。填 0 表示不限制。',
    control: 'number',
    default: 32 * 1024 * 1024,
    min: 0,
    unit: 'MB'
  },
  {
    id: 'console.usage',
    category: 'debug',
    label: '当前存储占用',
    description: '记录只增不减，不自动删除。删不删由你决定。',
    control: 'info',
    info: 'consoleStats'
  },
  {
    id: 'console.clear',
    category: 'debug',
    label: '清空全部记录',
    description: '删掉已落盘的所有请求内容，不可恢复。建议先把目录里的文件复制走。',
    control: 'action',
    action: 'consoleClear',
    danger: true,
    confirm: {
      title: '清空全部记录？',
      body: '所有请求内容都会被删除，不可恢复。已经导出的包不受影响。'
    }
  }
]

/** 设置项 id → 默认值 */
export function settingDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of SETTINGS_ITEMS) {
    if (item.default !== undefined) out[item.id] = item.default
  }
  return out
}
