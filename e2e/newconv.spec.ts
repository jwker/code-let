import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))


test.describe.serial('新建 agent 先选类型和名字', () => {
  let projectDir = ''
  let userDataDir = ''
  let app: ElectronApplication | null = null
  let page: Page

/**
 * 从窄轨的「＋」打开对话框。
 *
 * 侧栏退场之后，新建的入口只剩窄轨的「＋」、输入框的 `/new`、项目设置的会话管理，
 * 三个走同一个对话框（D63）。
 */
async function openNewAgent(): Promise<void> {
  await page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '新建 agent' }).click()
  await expect(page.getByRole('dialog', { name: '新建 agent' })).toBeVisible()
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

  test('默认是基础 agent，名字预填「基础 + 序号」，回车直接建', async () => {
    await openNewAgent()

    const dialog = page.getByRole('dialog', { name: '新建 agent' })
    // 启动时会先建一个兜底的基础 agent，所以这一条是「基础 2」
    const input = dialog.getByRole('textbox')
    await expect(input).toHaveValue(/^基础 \d+$/)
    await expect(dialog.getByRole('radio', { name: /基础/ })).toHaveAttribute('aria-checked', 'true')

    const created = await input.inputValue()
    await input.press('Enter')
    await expect(dialog).toHaveCount(0)
    // 窄轨里出现这个名字的 agent（悬停气泡里也有）
    await expect(page.getByRole('button', { name: created, exact: true })).toBeVisible()
    // 基础 agent 只有一栏：没有区域 5，也没有浏览器
    await expect(page.locator('.shell')).toHaveClass(/is-zone5-hidden/)
  })

  test('选「产品」名字跟着变，建出来是两栏', async () => {
    await openNewAgent()

    const dialog = page.getByRole('dialog', { name: '新建 agent' })
    const input = dialog.getByRole('textbox')
    await dialog.getByRole('radio', { name: /产品/ }).click()
    await expect(input).toHaveValue(/^产品 \d+$/)

    const created = await input.inputValue()
    await input.press('Enter')
    await expect(dialog).toHaveCount(0)

    // 区域 6 是它自己的浏览器 —— 看地址栏，别看类型卡上的字
    await expect(page.locator('.shell')).not.toHaveClass(/is-zone5-hidden/)
    await expect(page.locator('.shell-card.zone6').getByPlaceholder(/localhost/)).toBeVisible()
    await expect(page.getByRole('button', { name: created, exact: true })).toBeVisible()
  })

  test('用户改过名字之后，换类型不再覆盖', async () => {
    await openNewAgent()

    const dialog = page.getByRole('dialog', { name: '新建 agent' })
    const input = dialog.getByRole('textbox')
    await input.fill('我的原型 agent')
    await dialog.getByRole('radio', { name: /开发/ }).click()
    await expect(input).toHaveValue('我的原型 agent')

    await input.press('Enter')
    await expect(page.getByRole('button', { name: '我的原型 agent', exact: true })).toBeVisible()
  })

  test('Esc 取消，什么都不建', async () => {
    await openNewAgent()
    const before = await page.getByRole('navigation', { name: '项目导航' }).getByRole('button').count()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '新建 agent' })).toHaveCount(0)
    const after = await page.getByRole('navigation', { name: '项目导航' }).getByRole('button').count()
    expect(after).toBe(before)
  })
})
