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

/**
 * 从侧栏打开「新建对话」。
 *
 * 旧的入口（标签栏的「新建标签」+项目下拉）随标签改成项目一起退场了，
 * 现在起名的入口是侧栏项目菜单里的「新建对话」。侧栏默认收起，先展开。
 */
async function openProjectMenu(): Promise<void> {
  const showSidebar = page.getByRole('button', { name: '显示侧栏' })
  if (await showSidebar.isVisible()) await showSidebar.click()
  const projectName = projectDir.split('/').pop()!
  await page.getByRole('button', { name: `${projectName} 的操作` }).click()
  await page.getByRole('menuitem', { name: '新建对话' }).click()
}

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
    await openProjectMenu()

    const dialog = page.getByRole('dialog', { name: '新建对话' })
    await expect(dialog).toBeVisible()
    const input = dialog.getByRole('textbox')
    await expect(input).toHaveValue(/^会话\d{3}$/)

    const created = await input.inputValue()
    await input.press('Enter')
    await expect(dialog).toHaveCount(0)
    // 窄轨里出现这个名字的 agent（悬停气泡里也有）
    await expect(page.getByRole('button', { name: created, exact: true })).toBeVisible()
  })

  test('可以改成自己的名字', async () => {
    await openProjectMenu()

    const dialog = page.getByRole('dialog', { name: '新建对话' })
    const input = dialog.getByRole('textbox')
    await input.fill('我的自定义会话')
    await dialog.getByRole('button', { name: '创建' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '我的自定义会话', exact: true })).toBeVisible()
  })

  test('Esc 取消，什么都不建', async () => {
    await openProjectMenu()

    const dialog = page.getByRole('dialog', { name: '新建对话' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })
})
