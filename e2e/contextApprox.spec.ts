import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 没有请求级索引时，会话历史近似视图也能选择基线。 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('上下文 Diff · 近似基线', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-approx-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-approx-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-approx-e2e-agent-'))
    mkdirSync(join(projectDir, 'src'))
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const manager = SessionManager.create(projectDir)
      manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '第一轮问题' }],
        timestamp: Date.now()
      })
      const keptId = manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '第二轮问题' }],
        timestamp: Date.now() + 2
      })
      manager.appendCompaction('压缩摘要正文', keptId, 100)
      manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '压缩后的第三轮问题' }],
        timestamp: Date.now() + 3
      })
      const sessionFile = manager.getSessionFile()
      if (!sessionFile) throw new Error('会话文件没有创建出来')
      writeFileSync(
        join(userDataDir, 'tabs.json'),
        JSON.stringify(
          {
            tabs: [{ id: 'tab-e2e-approx', cwd: projectDir, path: sessionFile, title: '近似 E2E' }],
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
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('从会话历史重建后仍能切换基线', async () => {
    await page.getByRole('button', { name: '上下文', exact: true }).click()
    const pane = page.locator('.insp-body')
    await expect(pane.getByText('还没有请求级上下文快照')).toBeVisible()

    // 选中第 3 轮后再重建：重建完成后必须停在第 3 轮，而不是跳回最新两次。
    await page.locator('.conv-nav-hit').nth(2).click()
    await expect(pane.getByText('第 3 轮 · 最后两次请求')).toBeVisible()
    await pane.getByRole('button', { name: '从会话历史重建近似对比' }).click()
    await expect(pane.getByText('第 3 轮 · 最后两次请求')).toBeVisible()
    await expect(pane.getByText('近似视图')).toBeVisible()
    await expect(pane.getByText('上下文已压缩（近似）')).toBeVisible()
    await expect(pane.getByText('压缩摘要正文')).toBeVisible()

    await pane.getByRole('button', { name: '切换' }).click()
    await expect(pane.getByText('选择基线')).toBeVisible()
    await expect(pane.getByText('本会话请求')).toBeVisible()
    await pane.getByRole('button', { name: /第 1 轮/ }).first().click()
    await expect(pane.getByText('自定义基线')).toBeVisible()
  })
})
