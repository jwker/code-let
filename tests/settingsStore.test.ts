import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore } from '../host/main/settings'

/**
 * 设置的存取。
 *
 * 按注册表校验：开关只收 boolean，数字夹在 min/max 之间，
 * 注册表里没有的 id 直接忽略。
 */
describe('设置存储', () => {
  it('默认值来自注册表', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-settings-'))
    const store = new SettingsStore(join(dir, 'settings.json'))
    expect(store.get('console.record')).toBe(true)
    expect(store.get('console.maxRecordBytes')).toBe(32 * 1024 * 1024)
  })

  it('写进去的值会存到文件里', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-settings-'))
    const file = join(dir, 'settings.json')
    const store = new SettingsStore(file)
    expect(store.set('console.record', false)).toBe(true)

    const reloaded = new SettingsStore(file)
    expect(reloaded.get('console.record')).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8'))['console.record']).toBe(false)
  })

  it('不合法的值和未知的 id 都被挡住', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-settings-'))
    const store = new SettingsStore(join(dir, 'settings.json'))
    expect(store.set('console.record', 'yes')).toBe(false)
    expect(store.set('console.maxRecordBytes', 'big')).toBe(false)
    expect(store.set('不存在的项', 1)).toBe(false)
    // info / action 不是可写的设置项
    expect(store.set('console.usage', { a: 1 })).toBe(false)
    expect(store.set('console.clear', true)).toBe(false)
    expect(store.get('console.record')).toBe(true)
  })

  it('数字按 min/max 夹住', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-settings-'))
    const store = new SettingsStore(join(dir, 'settings.json'))
    expect(store.set('console.maxRecordBytes', -5)).toBe(true)
    expect(store.get('console.maxRecordBytes')).toBe(0)
  })

  it('配置文件坏了就用默认值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codelet-settings-'))
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{ 坏掉的 json', 'utf8')
    const store = new SettingsStore(file)
    expect(store.get('console.record')).toBe(true)
  })
})
