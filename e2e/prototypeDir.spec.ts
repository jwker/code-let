import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 项目设置里的「原型图目录」（票 02）。
 *
 * 这一项是项目级的：默认 `.codelet/prototype`，存项目内相对路径，保存时校验。
 * 用例要真的重启一次 —— 设置得落到磁盘上，不是只活在界面的草稿里。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

async function launch(): Promise<void> {
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
  // 这个 spec 打开的是设置页，不一定有输入框 —— 等外壳本身
  await expect(page.getByRole('navigation', { name: '项目导航' })).toBeVisible({ timeout: 20_000 })
}

/** 打开「项目设置 → 项目」 */
async function openProjectSettings(): Promise<void> {
  await page
    .getByRole('navigation', { name: '项目导航' })
    .getByRole('button', { name: '项目设置' })
    .click()
  await page.getByRole('button', { name: '项目', exact: true }).click()
  await expect(page.getByLabel('原型图目录')).toBeVisible({ timeout: 10_000 })
}

/** 产品 agent 当前的系统提示（测试钩子） */
function systemPrompt(): Promise<string | null> {
  return app!.evaluate(
    (_electron, agentId) =>
      (
        globalThis as unknown as { __codeletSystemPrompt: (id: string) => string | null }
      ).__codeletSystemPrompt(agentId),
    'agent-p'
  ) as Promise<string | null>
}

function readProjects(): Array<{ path: string; prototypeDir?: string }> {
  const raw = JSON.parse(readFileSync(join(userDataDir, 'projects.json'), 'utf8')) as {
    projects: Array<{ path: string; prototypeDir?: string }>
  }
  return raw.projects
}

test.describe.serial('项目设置：原型图目录', () => {
  test.beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-prototype-dir-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-prototype-dir-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-prototype-dir-e2e-agent-'))

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
              pane: 'settings',
              activeAgentId: 'agent-p'
            }
          ],
          files: [],
          activeFileId: null
        },
        null,
        2
      )
    )
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('默认值是 .codelet/prototype；非法路径被拒绝，合法路径落盘', async () => {
    await launch()
    await openProjectSettings()

    const input = page.getByLabel('原型图目录')
    await expect(input).toHaveValue('.codelet/prototype')

    // 跑出项目的相对路径：拒绝，并说明原因
    await input.fill('../outside')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('原型图目录必须在这个项目里')
    expect(readProjects()[0].prototypeDir).toBeUndefined()

    // 合法路径：保存成功，给出「什么时候生效」的提示
    await input.fill('design/protos')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('/reload')
    await expect(input).toHaveValue('design/protos')

    expect(readProjects()[0].prototypeDir).toBe('design/protos')
    // 只改设置，不替用户建目录
    expect(existsSync(join(projectDir, 'design'))).toBe(false)

    await app?.close()
    app = null
  })

  test('重开应用后设置还在；改目录后 /reload 才吃到新值', async () => {
    await launch()
    await openProjectSettings()
    await expect(page.getByLabel('原型图目录')).toHaveValue('design/protos')

    // 产品 agent 的 runtime 已经带着这个目录建起来
    await page
      .getByRole('navigation', { name: '项目导航' })
      .getByRole('button', { name: '产品 1' })
      .click()
    await expect(systemPrompt()).resolves.toContain(join(projectDir, 'design/protos'))

    // 改成另一个目录：已开着的 runtime 不重建，提示里还是旧目录
    await openProjectSettings()
    await page.getByLabel('原型图目录').fill('design/pages')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('/reload')
    await page
      .getByRole('navigation', { name: '项目导航' })
      .getByRole('button', { name: '产品 1' })
      .click()
    await expect(systemPrompt()).resolves.toContain(join(projectDir, 'design/protos'))

    // /reload 重建 runtime，换成新的目录
    const composer = page.locator('textarea').first()
    await composer.fill('/reload')
    await composer.press('Enter')
    await expect(page.getByText('已重新加载扩展和会话')).toBeVisible({ timeout: 20_000 })
    await expect(systemPrompt()).resolves.toContain(join(projectDir, 'design/pages'))
    await expect(systemPrompt()).resolves.not.toContain(join(projectDir, 'design/protos'))
  })
})
