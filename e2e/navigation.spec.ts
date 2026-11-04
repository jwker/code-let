import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 对话导航的端到端冒烟测试（PLAN.md D36）。
 *
 * 用 SessionManager 造一个有 8 条用户消息的会话文件，再把 tabs.json 指过去；
 * 这样应用启动后直接进入一个足够长的会话，不依赖模型或网络。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('对话导航', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-nav-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-nav-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-nav-e2e-agent-'))
    mkdirSync(join(projectDir, 'src'))

    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const manager = SessionManager.create(projectDir)
      for (let index = 1; index <= 60; index += 1) {
        manager.appendMessage({
          role: 'user',
          content: [{ type: 'text', text: `第 ${index} 轮用户输入：检查导航定位 ${index}` }],
          timestamp: Date.now() + index
        })
      }
      const sessionFile = manager.getSessionFile()
      if (!sessionFile) throw new Error('会话文件没有创建出来')
      writeFileSync(
        join(userDataDir, 'tabs.json'),
        JSON.stringify(
          {
            tabs: [{ id: 'tab-e2e-nav', cwd: projectDir, path: sessionFile, title: '导航 E2E' }],
            files: [],
            activeFileId: null
          },
          null,
          2
        )
      )
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }

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
    await expect(page.locator('.conv-nav-hit')).toHaveCount(60, { timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('轮次多于轨道高度时只滚动圆点列表，当前圆点自动进入可视区', async () => {
    const list = page.locator('.conv-nav-list')
    const metrics = await list.evaluate((element) => ({
      scrollHeight: (element as HTMLElement).scrollHeight,
      clientHeight: element.clientHeight
    }))
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
    await expect(list).toHaveClass(/is-overflowing/)
    await expect
      .poll(() => list.evaluate((element) => (element as HTMLElement).scrollTop), { timeout: 10_000 })
      .toBeGreaterThan(0)
    await expect(page.locator('.conv-nav-end')).toHaveCount(2)

    await list.evaluate((element) => {
      (element as HTMLElement).scrollTop = (element as HTMLElement).scrollHeight
    })
    await expect(page.locator('.conv-nav-end-bottom')).toHaveClass(/is-end/)

    await list.evaluate((element) => {
      (element as HTMLElement).scrollTop = 0
    })
    await expect(page.locator('.conv-nav-end-top')).toHaveClass(/is-end/)
  })

  test('悬停圆点展开对应轮次的用户输入', async () => {
    const dot = page.locator('.conv-nav-hit').nth(4)
    await dot.hover()
    const card = page.locator('.conv-nav-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('第 5 轮')
    await expect(card).toContainText('第 5 轮用户输入')
  })

  test('点击靠前的圆点会滚动并更新当前轮次', async () => {
    const thread = page.locator('.conv-normal')
    const before = await thread.evaluate((element) => (element as HTMLElement).scrollTop)
    const target = page.locator('.conv-nav-hit').nth(4)
    await target.click()
    await expect(target).toHaveAttribute('aria-current', 'true', { timeout: 10_000 })
    await expect
      .poll(() => thread.evaluate((element) => (element as HTMLElement).scrollTop), { timeout: 10_000 })
      .toBeLessThan(before)
  })
})
