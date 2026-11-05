import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SETTINGS_ITEMS, settingDefaults } from '@contract/settings'

/**
 * 设置的存取。
 *
 * 取值就是一个「设置项 id → 值」的映射，存在 `<userData>/settings.json`。
 * 注册表在 `contract/settings.ts` —— 这里按那份表校验取值，挡住越界的值。
 */
export class SettingsStore {
  private values: Record<string, unknown>
  private readonly file: string

  constructor(file: string) {
    this.file = file
    this.values = { ...settingDefaults() }
    this.load()
  }

  private load(): void {
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>
      for (const [key, value] of Object.entries(parsed)) {
        if (key in this.values) this.values[key] = value
      }
    } catch {
      // 配置坏了就用默认值，不阻塞启动
    }
  }

  /** 全部取值 */
  all(): Record<string, unknown> {
    return { ...this.values }
  }

  /** 取一个 */
  get(id: string): unknown {
    return this.values[id]
  }

  /**
   * 写一个。
   *
   * 按注册表校验：开关只收 boolean，数字收 number 并夹在 min/max 之间；
   * 未知 id 直接忽略 —— 注册表里没有的东西不该被写进来。
   */
  set(id: string, value: unknown): boolean {
    const item = SETTINGS_ITEMS.find((entry) => entry.id === id)
    if (!item) return false
    let next: unknown = value
    if (item.control === 'switch') {
      if (typeof value !== 'boolean') return false
    } else if (item.control === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false
      let number = value
      if (typeof item.min === 'number') number = Math.max(item.min, number)
      if (typeof item.max === 'number') number = Math.min(item.max, number)
      next = number
    } else if (item.control === 'text') {
      if (typeof value !== 'string') return false
    } else {
      // info / action 不是可写的设置项
      return false
    }
    this.values[id] = next
    this.save()
    return true
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${JSON.stringify(this.values, null, 2)}\n`, 'utf8')
    } catch {
      // 写不进去只影响持久化，本次运行仍然生效
    }
  }
}
