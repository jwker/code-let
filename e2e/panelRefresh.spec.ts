import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 右栏刷新：代码与文档两边都跟「重开应用」看到的一样。
 *
 * 测试直接改临时目录里的文件，然后点右栏的刷新，断言树、正文、空态与按钮禁用。
 * 不关心缓存实现，只断言用户看得见的结果。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let app: ElectronApplication | null = null
let page: Page

const refresh = (): ReturnType<Page['locator']> => page.locator('.rp-refresh')

test.describe.serial('右栏刷新', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-refresh-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-refresh-e2e-userdata-'))
    mkdirSync(join(projectDir, 'src'), { recursive: true })
    mkdirSync(join(projectDir, '.ai', 'planning'), { recursive: true })
    writeFileSync(join(projectDir, 'a.txt'), '第一版\n')
    writeFileSync(join(projectDir, 'src', 'x.ts'), 'export const x = 1\n')
    writeFileSync(join(projectDir, 'AGENTS.md'), '# 项目说明\n\n这是正文第一版。\n')
    writeFileSync(join(projectDir, '.ai', 'planning', 'old.md'), '# 旧计划\n')
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )
    writeFileSync(
      join(userDataDir, 'tabs.json'),
      JSON.stringify(
        {
          version: 2,
          tabs: [
            {
              id: 'tab-1',
              cwd: projectDir,
              title: projectDir.split('/').pop(),
              pane: 'agent',
              rightPanel: { open: true, kind: 'code' },
              activeAgentId: null
            }
          ],
          files: [],
          activeFileId: null
        },
        null,
        2
      )
    )

    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: { ...process.env, CODELET_USER_DATA: userDataDir },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
    await expect(refresh()).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('代码区：新建文件出现、外部修改跟着变、展开状态保留', async () => {
    // 打开 a.txt，看到第一版
    await page.getByRole('button', { name: /a\.txt/ }).first().click()
    await expect(page.locator('.file-content')).toContainText('第一版')

    // 展开 src，确认初始内容
    await page.getByRole('button', { name: /src/ }).first().click()
    await expect(page.getByText('x.ts', { exact: true })).toBeVisible()

    // 外部：新建根文件 + 修改当前文件
    writeFileSync(join(projectDir, 'b.txt'), '新文件\n')
    writeFileSync(join(projectDir, 'a.txt'), '第一版\n第二版\n')
    await refresh().click()

    await expect(page.getByText('b.txt', { exact: true })).toBeVisible()
    await expect(page.locator('.file-content')).toContainText('第二版')
    // 展开的 src 还开着、选中的文件还在
    await expect(page.getByText('x.ts', { exact: true })).toBeVisible()
    await expect(page.locator('.file-tab.is-active')).toContainText('a.txt')
  })

  test('删掉当前文件：内容区说「已经不在了」，标签不自动关', async () => {
    unlinkSync(join(projectDir, 'a.txt'))
    await refresh().click()

    await expect(page.getByText('这个文件已经不在了', { exact: true })).toBeVisible()
    // 标签还在 —— 刷新不替用户关文件
    await expect(page.locator('.file-tab.is-active')).toContainText('a.txt')
  })

  test('刷新期间按钮禁用，结束后恢复', async () => {
    // 在同一个事件循环里派发 click，再看下一拍按钮的 disabled：
    // 刷新至少跨几个 await，这时应该已经是禁用的
    const disabled = await page.evaluate(async () => {
      const button = document.querySelector<HTMLButtonElement>('.rp-refresh')
      if (!button) return null
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await new Promise((resolveTick) => setTimeout(resolveTick, 0))
      return button.disabled
    })
    expect(disabled).toBe(true)
    await expect(refresh()).toBeEnabled()
  })

  test('文档区：新增文档出现、正文跟着变、删掉选中的回到空态', async () => {
    await page.getByRole('button', { name: /切换功能区/ }).click()
    await page.getByRole('menuitemradio', { name: /文档/ }).click()

    // 打开 AGENTS.md，看到第一版
    await page.getByRole('button', { name: /AGENTS\.md/ }).first().click()
    await expect(page.locator('.doc-view-body')).toContainText('这是正文第一版')

    // 外部：新增一篇、修改当前正文
    writeFileSync(join(projectDir, '.ai', 'planning', 'new.md'), '# 新计划\n')
    writeFileSync(join(projectDir, 'AGENTS.md'), '# 项目说明\n\n这是正文第二版。\n')
    await refresh().click()

    await expect(page.getByRole('button', { name: /new\.md/ })).toBeVisible()
    await expect(page.locator('.doc-view-body')).toContainText('这是正文第二版')

    // 删掉当前选中的文档：收起选中，回到「挑一篇」
    unlinkSync(join(projectDir, 'AGENTS.md'))
    await refresh().click()
    await expect(page.getByText('从文档树里选一份文档')).toBeVisible()
    await expect(page.getByRole('button', { name: /AGENTS\.md/ })).toHaveCount(0)
  })

  test('浏览器功能区没有面板刷新按钮', async () => {
    await page.getByRole('button', { name: /切换功能区/ }).click()
    await page.getByRole('menuitemradio', { name: /浏览器/ }).click()
    await expect(page.locator('.rp-refresh')).toHaveCount(0)
  })
})
