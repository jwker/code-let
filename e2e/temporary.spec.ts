import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 临时对话窗口（D40）：打开、最小化恢复、确认关闭、重开为空。 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('临时对话', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-temp-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-temp-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-temp-e2e-agent-'))
    mkdirSync(join(projectDir, 'src'))
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )

    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        CODELET_USER_DATA: userDataDir,
        PI_CODING_AGENT_DIR: agentDir
      },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('打开、Esc 不关闭、最小化可恢复', async () => {
    const composer = page.locator('textarea').first()
    await composer.fill('/ask')
    await page.getByRole('option').filter({ hasText: '/ask' }).first().click()

    const dialog = page.getByRole('dialog', { name: '临时对话' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    const input = dialog.getByPlaceholder('问点什么…')
    await expect(input).toBeFocused()

    // 临时窗口里不挂 / 和 @
    await input.fill('/')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await input.fill('@')
    await expect(page.getByRole('listbox')).toHaveCount(0)

    // Esc 不关闭
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    // 最小化只收起浮层
    await dialog.getByRole('button', { name: '最小化' }).click()
    await expect(dialog).toHaveCount(0)
    const pill = page.getByRole('button', { name: '恢复临时对话' })
    await expect(pill).toBeVisible()
    await pill.click()
    await expect(dialog).toBeVisible()

    // /ask 也能恢复最小化的同一会话
    await dialog.getByRole('button', { name: '最小化' }).click()
    await composer.fill('/ask')
    await page.getByRole('option').filter({ hasText: '/ask' }).first().click()
    await expect(dialog).toBeVisible()
  })

  test('只有 X 打开确认；取消、Esc 都保留，确认后才清除', async () => {
    const dialog = page.getByRole('dialog', { name: '临时对话' })
    await dialog.getByRole('button', { name: '关闭临时对话' }).click()

    const confirm = page.getByRole('alertdialog', { name: '彻底关闭临时对话' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(dialog).toBeVisible()

    // 确认框里的 Esc 只取消确认
    await dialog.getByRole('button', { name: '关闭临时对话' }).click()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(dialog).toBeVisible()

    // 确认后才真正关闭
    await dialog.getByRole('button', { name: '关闭临时对话' }).click()
    await confirm.getByRole('button', { name: '彻底关闭' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '恢复临时对话' })).toHaveCount(0)
  })

  test('彻底关闭后再次 /ask 是空会话', async () => {
    const composer = page.locator('textarea').first()
    await composer.fill('/ask')
    await page.getByRole('option').filter({ hasText: '/ask' }).first().click()

    const dialog = page.getByRole('dialog', { name: '临时对话' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByPlaceholder('问点什么…')).toHaveValue('')
    await expect(dialog.locator('.conv-stream')).toHaveCount(0)
  })
})
