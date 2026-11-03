import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 输入框的端到端冒烟测试（PLAN.md D35）。
 *
 * 启动真实的 Electron 主进程，但把 userData 和 Pi 的 agent 目录都指到临时目录，
 * 所以不会碰真实项目清单、会话或凭据。项目 fixture 只有几个只读文件。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('输入框', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-e2e-agent-'))

    mkdirSync(join(projectDir, 'src'))
    writeFileSync(join(projectDir, 'README.md'), '# E2E\n\n测试项目。\n')
    writeFileSync(join(projectDir, 'package.json'), '{"name":"e2e-fixture"}\n')
    writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const answer = 42\n')
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
    await expect(page.locator('textarea')).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('斜杠菜单列出内置动作', async () => {
    const composer = page.locator('textarea')
    await composer.fill('/')

    const menu = page.getByRole('listbox', { name: '命令' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('option').filter({ hasText: '/reload' })).toBeVisible()
    await expect(menu.getByRole('option').filter({ hasText: '/thinking' })).toBeVisible()
  })

  test('非空 @ 查询能找到嵌套文件（走项目索引）', async () => {
    const composer = page.locator('textarea')
    await composer.fill('@index')

    const menu = page.getByRole('listbox', { name: '引用文件' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('option').filter({ hasText: 'src/index.ts' })).toBeVisible()

    await composer.fill('')
  })

  test('@ 选中文件后出现 chip，删掉正文引用后 chip 消失', async () => {
    const composer = page.locator('textarea')
    await composer.fill('@')

    const menu = page.getByRole('listbox', { name: '引用文件' })
    await expect(menu).toBeVisible()
    await menu.getByRole('option').filter({ hasText: 'README.md' }).click()

    await expect(composer).toHaveValue('@README.md ')
    const chip = page.locator('[aria-label="移除附件「README.md」"]')
    await expect(chip).toBeVisible()
    await expect(chip.locator('..')).toContainText('tok')
    await expect(page.getByText(/共 1 个/)).toBeVisible()

    await composer.fill('')
    await expect(chip).toHaveCount(0)
  })

  test('点 chip 的 × 会同时删掉正文里的引用', async () => {
    const composer = page.locator('textarea')
    await composer.fill('@')

    const menu = page.getByRole('listbox', { name: '引用文件' })
    await expect(menu).toBeVisible()
    await menu.getByRole('option').filter({ hasText: 'README.md' }).click()

    const chip = page.locator('[aria-label="移除附件「README.md」"]')
    await expect(chip).toBeVisible()
    await expect(composer).toHaveValue('@README.md ')

    await chip.click()
    await expect(composer).toHaveValue('')
    await expect(chip).toHaveCount(0)
  })
})
