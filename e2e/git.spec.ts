import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Git 面板：真实临时仓库，只读状态和单文件 diff。 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('Git 面板', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-git-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-git-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-git-e2e-agent-'))

    execFileSync('git', ['init', '-q'], { cwd: projectDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir })
    execFileSync('git', ['config', 'user.name', 'Codelet Test'], { cwd: projectDir })
    writeFileSync(join(projectDir, 'a.txt'), 'one\n')
    execFileSync('git', ['add', 'a.txt'], { cwd: projectDir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: projectDir })
    writeFileSync(join(projectDir, 'a.txt'), 'one\ntwo\n')
    writeFileSync(join(projectDir, 'b.txt'), 'staged\n')
    execFileSync('git', ['add', 'b.txt'], { cwd: projectDir })
    writeFileSync(join(projectDir, 'c.txt'), 'new\n')

    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const manager = SessionManager.create(projectDir)
      const sessionFile = manager.getSessionFile()
      if (!sessionFile) throw new Error('会话文件没有创建出来')
      writeFileSync(
        join(userDataDir, 'tabs.json'),
        JSON.stringify(
          {
            tabs: [{ id: 'tab-e2e-git', cwd: projectDir, path: sessionFile, title: 'Git E2E' }],
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

  test('显示分支、分组文件，并能打开 diff', async () => {
    await page.getByRole('button', { name: 'Git', exact: true }).click()
    const pane = page.locator('.insp-body')
    await expect(pane.getByText('Git', { exact: true })).toBeVisible()
    await expect(pane.getByText('已暂存')).toBeVisible()
    await expect(pane.getByText('未暂存')).toBeVisible()
    await expect(pane.getByText('未跟踪')).toBeVisible()
    await expect(pane.getByText('a.txt')).toBeVisible()
    await expect(pane.getByText('b.txt')).toBeVisible()
    await expect(pane.getByText('c.txt')).toBeVisible()

    await pane.getByText('a.txt').click()
    await expect(pane.getByText('+two')).toBeVisible()
    await expect(pane.getByText('相对 index')).toBeVisible()

    await pane.getByRole('button', { name: '返回 Git 列表' }).click()
    await expect(pane.getByText('未暂存')).toBeVisible()
  })
})
