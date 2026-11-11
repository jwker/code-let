import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 设置窗口里的「大模型」页。
 *
 * 这一页的数据全来自 pi 的模型目录（自带，不联网也有）——
 * 所以端到端不跑模型、不登录，只验界面这一段：四个区块都在、
 * provider 清单和模型清单都填上了、勾选与保存落到 pi 的设置里。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null

/** 打开设置窗口，停在「大模型」这一页 */
async function openModelPage(): Promise<Page> {
  const page = await app!.firstWindow()
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() =>
    (window as unknown as { codelet: { openSettingsWindow(): Promise<void> } }).codelet.openSettingsWindow()
  )
  // 窗口可能已经开好了 —— 按地址找，别去等事件（会错过）
  let settingsPage: Page | null = null
  await expect
    .poll(
      () => {
        settingsPage =
          app!.windows().find((candidate) => candidate.url().includes('window=settings')) ?? null
        return settingsPage !== null
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  const target = settingsPage!
  await expect(target.getByRole('button', { name: '大模型' })).toBeVisible({ timeout: 20_000 })
  await target.getByRole('button', { name: '大模型' }).click()
  return target
}

test.describe.serial('大模型管理页', () => {
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-models-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-models-e2e-agent-'))

    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        CODELET_USER_DATA: userDataDir,
        // 凭据与模型设置都落在这个临时 agent 目录里，不碰真实的
        PI_CODING_AGENT_DIR: agentDir,
        // OAuth 测试不去开真浏览器 —— 只验界面上出了链接
        CODELET_NO_OPEN_BROWSER: '1'
      },
      timeout: 30_000
    })
  })

  test.afterAll(async () => {
    await app?.close()
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
  })

  test('四个区块都在，provider 与模型清单都填上了', async () => {
    const page = await openModelPage()

    await expect(page.getByRole('heading', { name: '默认' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '凭据' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '可用模型' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '自定义端点' })).toBeVisible()

    // provider 清单 —— pi 自带目录里有 44 个
    await expect(page.getByText('个 provider')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('Anthropic', { exact: true })).toBeVisible()

    // 模型清单 —— 也是自带的
    await expect(page.getByText('已启用')).toBeVisible({ timeout: 20_000 })
  })

  test('默认模型下拉：只列已登录的厂商的模型，点外面能收起', async () => {
    const page = await openModelPage()
    await expect(page.getByText('个 provider')).toBeVisible({ timeout: 20_000 })

    // 先登录一个 provider —— 下拉里该有它的模型
    await page.locator('[data-provider="mistral"]').getByRole('button', { name: '登录' }).click()
    const input = page.getByPlaceholder('粘贴 API Key')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill('sk-e2e-test-key')
    await page.getByRole('button', { name: '提交' }).click()
    await expect(page.getByText('已登录', { exact: false }).first()).toBeVisible({ timeout: 10_000 })

    // 下拉开
    const trigger = page.getByRole('button', { name: /未设置|provider 默认选/ })
    await trigger.click()
    const popup = page.locator('div.absolute.z-20')
    await expect(popup).toBeVisible({ timeout: 10_000 })
    // 里面列的是 mistral 的模型
    await expect(popup.getByText('mistral/', { exact: false }).first()).toBeVisible()

    // 点外面要收起
    await page.getByRole('heading', { name: '凭据' }).click()
    await expect(popup).toBeHidden({ timeout: 5_000 })
  })

  test('停用一个模型并保存，写进 pi 的设置', async () => {
    const page = await openModelPage()
    await expect(page.getByText('已启用')).toBeVisible({ timeout: 20_000 })

    // 找到「可用模型」区里的第一个勾选框，取消勾选
    const section = page.locator('section', { has: page.getByRole('heading', { name: '可用模型' }) })
    const firstCheck = section.getByRole('checkbox').first()
    await expect(firstCheck).toBeVisible()
    await firstCheck.click()

    // 出现未保存标记
    await expect(page.getByText('有未保存的改动')).toBeVisible()
    await section.getByRole('button', { name: '保存到设置' }).click()

    // 设置落到了 pi 的全局 settings.json 里
    await expect
      .poll(
        async () => {
          const { readFileSync, existsSync } = await import('node:fs')
          const path = join(agentDir, 'settings.json')
          if (!existsSync(path)) return null
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as { enabledModels?: string[] }
          return parsed.enabledModels?.length ?? null
        },
        { timeout: 10_000 }
      )
      .not.toBeNull()
  })

  test('用密钥登录：填进去就存进 auth.json，状态变成已登录', async () => {
    const page = await openModelPage()
    await expect(page.getByText('个 provider')).toBeVisible({ timeout: 20_000 })

    // 找一个只有密钥方式的 provider（没有 OAuth 的那种）
    const row = page.locator('[data-provider="mistral"]')
    await row.getByRole('button', { name: '登录' }).click()

    // 弹层里出现输入框
    const input = page.getByPlaceholder('粘贴 API Key')
    await expect(input).toBeVisible({ timeout: 10_000 })
    await input.fill('sk-e2e-test-key')
    await page.getByRole('button', { name: '提交' }).click()

    // 凭据落到了 agent 目录的 auth.json 里
    await expect
      .poll(
        async () => {
          const { readFileSync, existsSync } = await import('node:fs')
          const path = join(agentDir, 'auth.json')
          if (!existsSync(path)) return null
          const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { key?: string }>
          return parsed.mistral?.key ?? null
        },
        { timeout: 10_000 }
      )
      .toBe('sk-e2e-test-key')

    await expect(page.getByText('已登录', { exact: false }).first()).toBeVisible()
  })

  test('OAuth 登录：弹层里给出授权链接', async () => {
    const page = await openModelPage()
    await expect(page.getByText('个 provider')).toBeVisible({ timeout: 20_000 })

    const row = page.locator('[data-provider="anthropic"]')
    await row.getByRole('button', { name: '登录' }).click()

    // provider 自己会问用哪种方式（pi 里也是这样）
    const methodButton = page.getByRole('button', { name: 'Browser login (default)' })
    await expect(methodButton).toBeVisible({ timeout: 15_000 })
    await methodButton.click()

    // 授权链接出现在弹层里
    await expect(page.locator('span.font-mono').filter({ hasText: 'http' }).first()).toBeVisible({
      timeout: 15_000
    })

    // 取消掉，别留着等回调
    await page.getByRole('button', { name: '取消' }).click()
  })
})
