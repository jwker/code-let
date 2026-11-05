import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

test.describe.serial('新建对话先起名', () => {
  let projectDir = ''
  let userDataDir = ''
  let app: ElectronApplication | null = null
  let page: Page

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-newconv-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-newconv-e2e-userdata-'))
    writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify({ projects: [projectDir] }, null, 2))
    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: { ...process.env, CODELET_USER_DATA: userDataDir },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('默认填「会话」加三位数字，回车直接建', async () => {
    await page.getByRole('button', { name: '新建标签' }).click()
    await page.getByRole('menuitem', { name: new RegExp(projectDir.split('/').pop()!) }).first().click()

    const dialog = page.getByRole('dialog', { name: '新建对话' })
    await expect(dialog).toBeVisible()
    const input = dialog.getByRole('textbox')
    await expect(input).toHaveValue(/^会话\d{3}$/)

    await input.press('Enter')
    await expect(dialog).toHaveCount(0)
    // 标签栏显示这个名字
    await expect(page.getByText(/^会话\d{3}$/).first()).toBeVisible()
  })

  test('可以改成自己的名字', async () => {
    await page.getByRole('button', { name: '新建标签' }).click()
    await page.getByRole('menuitem', { name: new RegExp(projectDir.split('/').pop()!) }).first().click()

    const dialog = page.getByRole('dialog', { name: '新建对话' })
    const input = dialog.getByRole('textbox')
    await input.fill('我的自定义会话')
    await dialog.getByRole('button', { name: '创建' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByText('我的自定义会话').first()).toBeVisible()
  })

  test('Esc 取消，什么都不建', async () => {
    await page.getByRole('button', { name: '新建标签' }).click()
    await page.getByRole('menuitem', { name: new RegExp(projectDir.split('/').pop()!) }).first().click()

    const dialog = page.getByRole('dialog', { name: '新建对话' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
