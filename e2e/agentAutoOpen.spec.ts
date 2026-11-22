import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * agent 主动打开右栏（ADR-0005）。
 *
 * 两条一起验：
 * - 只是打开产品 agent，右栏保持原来的状态（这里是收着）；
 * - agent 真的动了浏览器（这里用测试钩子调一次浏览器工具），右栏自己展开、
 *   切到浏览器功能区，并显示它打开的那一页。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let prototypeUrl = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('agent 主动打开右栏', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-autoopen-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-autoopen-e2e-userdata-'))
    const prototypeFile = join(projectDir, 'prototype.html')
    writeFileSync(
      prototypeFile,
      '<!doctype html><html><head><meta charset="utf-8"><title>原型</title></head><body><h1>原型</h1></body></html>'
    )
    prototypeUrl = pathToFileURL(prototypeFile).toString()

    const now = Date.now()
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )
    writeFileSync(
      join(userDataDir, 'agents.json'),
      JSON.stringify(
        {
          version: 1,
          agents: [
            {
              id: 'agent-p',
              name: '产品 1',
              type: 'product',
              instance: 1,
              cwd: projectDir,
              sessionPath: null,
              createdAt: now,
              lastActiveAt: now,
              archivedAt: null,
              turns: 0,
              previewUrl: null
            }
          ]
        },
        null,
        2
      )
    )
    // 右栏收着启动 —— 打开 agent 那一小步不该自己展开
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
              rightPanel: { open: false, kind: null },
              activeAgentId: 'agent-p'
            }
          ],
          files: [],
          activeFileId: null
        }
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
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('打开产品 agent 不展开右栏；agent 动浏览器时右栏自己亮起来', async () => {
    // 启动时右栏收着
    await expect(page.locator('.right-panel')).toHaveCount(0)

    // 打开产品 agent（点它的头像）—— 右栏还是收着
    await page
      .getByRole('navigation', { name: '项目导航' })
      .getByRole('button', { name: '产品 1' })
      .click()
    await expect(page.locator('.shell-card.main textarea').first()).toBeVisible()
    await expect(page.locator('.right-panel')).toHaveCount(0)

    // 模拟 agent 调一次浏览器工具 —— 主进程换一份新的活动记录
    await app!.evaluate(
      async (_electron, args) => {
        const manager = (
          globalThis as unknown as {
            __codeletBrowser: {
              tool: (name: string, args: Record<string, unknown>, host: string) => Promise<unknown>
            }
          }
        ).__codeletBrowser
        await manager.tool('open', { url: args.url }, `agent:${args.agentId}`)
      },
      { url: prototypeUrl, agentId: 'agent-p' }
    )

    // 右栏自己展开、切到浏览器，并停在 agent 刚打开的页面
    const panel = page.locator('.right-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    await expect(panel.getByLabel('浏览器地址')).toHaveValue(/prototype\.html/)
    await expect(panel.getByRole('button', { name: /原型/ })).toBeVisible()
    await expect(panel.locator('.rp-title-name')).toHaveText('原型')
  })
})
