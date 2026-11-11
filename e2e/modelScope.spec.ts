import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 「可用模型」清单真的管住了模型选择器。
 *
 * 清单存在 pi 的全局 settings.json 里（`enabledModels`），Codelet 的模型选择器
 * 按它过滤。这一条是整个功能的关键承诺，单独用端到端验。
 *
 * agent 目录是临时的，里面预置一份凭据和一份清单 —— 所以会话建起来就有模型可用。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const KEEP = 'mistral/codestral-latest'

let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('可用模型清单', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-scope-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-scope-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-scope-e2e-agent-'))
    mkdirSync(join(projectDir, 'src'))

    writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify({ projects: [projectDir] }, null, 2))
    // 预置一份凭据 —— 有了它 mistral 的模型才「可用」
    writeFileSync(
      join(agentDir, 'auth.json'),
      JSON.stringify({ mistral: { type: 'api_key', key: 'sk-e2e-fake-key' } }, null, 2)
    )
    // 预置清单 —— 只留一个模型
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ enabledModels: [KEEP] }, null, 2)
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
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
  })

  test('选择器里只有清单上的那一个模型', async () => {
    // 会话建起来时的初始模型也该来自清单
    await expect(page.locator('button.conv-model')).toContainText('Codestral', { timeout: 20_000 })

    // 输入框下面那行模型按钮 —— 点它开选择器
    const modelButton = page.locator('button.conv-model')
    await expect(modelButton).toBeEnabled({ timeout: 20_000 })
    await modelButton.click()

    const picker = page.getByRole('dialog', { name: '选择模型' })
    await expect(picker).toBeVisible({ timeout: 10_000 })

    // 清单里的在
    await expect(picker.getByText('Codestral', { exact: false }).first()).toBeVisible()
    // 清单外的不在（mistral 的其他模型一个都不列）
    await expect(picker.getByText('Devstral', { exact: false })).toHaveCount(0)
  })
})
