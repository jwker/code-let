import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * agent 类型与提示词（ADR-0004）。
 *
 * 三段：
 *   1. 设置窗口 → agent 类型：内置行只开放提示词，自定义 agent 能新建并落盘；
 *   2. 主窗口：新建 agent 的卡片里出现自定义类型，建出来的 agent 的系统提示里带着那段提示词；
 *   3. 重启之后类型还在；把 agents.json 里的类型改成不认识的 id，应用照旧能起、那条 agent 还在。
 *
 * 不跑真模型：提示词只验 `__codeletSystemPrompt`（宿主暴露给测试的只读钩子）。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

let projectDir = ''
let userDataDir = ''
let app: ElectronApplication | null = null

const PROMPT = '回答先给结论，再给理由。不要用「赋能」「闭环」。'

/** 打开设置窗口，停在「agent 类型」这一页 */
async function openTypePage(): Promise<Page> {
  const page = await app!.firstWindow()
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() =>
    (window as unknown as { codelet: { openSettingsWindow(): Promise<void> } }).codelet.openSettingsWindow()
  )
  let settingsPage: Page | null = null
  await expect
    .poll(
      () => {
        settingsPage =
          app!.windows().find((candidate) => candidate.url().includes('window=settings')) ?? null
        return settingsPage !== null
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  const target = settingsPage!
  await expect(target.getByRole('button', { name: 'agent 类型' })).toBeVisible({ timeout: 20_000 })
  await target.getByRole('button', { name: 'agent 类型' }).click()
  return target
}

async function launch(): Promise<Page> {
  app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, CODELET_USER_DATA: userDataDir },
    timeout: 30_000
  })
  return app.firstWindow()
}

test.describe.serial('agent 类型与提示词', () => {
  test.beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-agenttypes-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-agenttypes-e2e-userdata-'))
    writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify({ projects: [projectDir] }, null, 2))
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('设置页：内置行只开放提示词，自定义 agent 能新建', async () => {
    await launch()
    const settings = await openTypePage()

    // 内置「基础」：名字只读、提示词可写
    await settings.getByRole('button', { name: /基础/ }).first().click()
    const name = settings.getByRole('textbox', { name: '名字' })
    await expect(name).toHaveAttribute('readonly', '')
    const prompt = settings.getByRole('textbox', { name: '提示词' })
    await prompt.fill('回答先给结论。')
    await settings.getByRole('button', { name: '保存' }).click()
    await expect(settings.getByText(/已保存/)).toBeVisible()

    // 新建一个自定义 agent
    await settings.getByRole('button', { name: '新建 agent 类型' }).click()
    await settings.getByRole('textbox', { name: '名字' }).fill('写作')
    await settings.getByRole('textbox', { name: '说明' }).fill('写文案与文档')
    await settings.getByRole('button', { name: '青' }).click()
    await settings.getByRole('textbox', { name: '提示词' }).fill(PROMPT)
    await settings.getByRole('button', { name: '创建' }).click()
    await expect(settings.getByText(/已新增/)).toBeVisible()
    await expect(settings.getByRole('button', { name: /写作/ }).first()).toBeVisible()

    // 落盘的形状：内置的提示词在 prompts 里，自定义的在 types 里
    const saved = JSON.parse(readFileSync(join(userDataDir, 'agentTypes.json'), 'utf8')) as {
      version: number
      types: Array<{ name: string; color: string; prompt: string }>
      prompts: Record<string, string>
    }
    expect(saved.version).toBe(1)
    expect(saved.types).toHaveLength(1)
    expect(saved.types[0]).toMatchObject({ name: '写作', color: 'teal', prompt: PROMPT })
    expect(saved.prompts.general).toBe('回答先给结论。')
  })

  test('主窗口：卡片里有自定义类型，建出来的 agent 带着那段提示词', async () => {
    const page = await app!.firstWindow()
    const created = await page
      .getByRole('navigation', { name: '项目导航' })
      .getByRole('button', { name: '新建 agent' })
      .click()
      .then(() => page.getByRole('dialog', { name: '新建 agent' }))
    await expect(created).toBeVisible()

    // 自定义类型出现在卡片里，默认名还是「基础 N」
    const card = created.getByRole('radio', { name: /写作/ })
    await expect(card).toBeVisible()
    await card.click()
    const input = created.getByRole('textbox')
    await expect(input).toHaveValue(/^写作 \d+$/)
    const agentName = await input.inputValue()
    await input.press('Enter')
    await expect(created).toHaveCount(0)
    await expect(page.getByRole('button', { name: agentName, exact: true })).toBeVisible()

    // 系统提示里真的有那段提示词
    const agentId = await page.evaluate(async () => {
      const snapshot = await (
        window as unknown as { codelet: { getSnapshot(): Promise<{ activeAgentId: string }> } }
      ).codelet.getSnapshot()
      return snapshot.activeAgentId
    })
    const systemPrompt = await app!.evaluate(
      (_electron, id) =>
        (globalThis as unknown as { __codeletSystemPrompt?: (agentId: string) => string | null })
          .__codeletSystemPrompt?.(id as string) ?? null,
      agentId
    )
    expect(systemPrompt).toContain('先给结论')
  })

  test('重启后类型还在；类型丢了也照旧能起，agent 不消失', async () => {
    // 把刚才那条 agent 的类型改成不认识的 id，模拟类型文件被删/手改
    const agentsFile = join(userDataDir, 'agents.json')
    const saved = JSON.parse(readFileSync(agentsFile, 'utf8')) as {
      agents: Array<{ id: string; type: string }>
    }
    const target = saved.agents.find((agent) => agent.type.startsWith('t-'))
    expect(target).toBeTruthy()
    target!.type = 't-gone'
    writeFileSync(agentsFile, JSON.stringify(saved, null, 2))

    await app?.close()
    const page = await launch()
    // 应用起来了，那条 agent 还在窄轨里
    await expect(page.getByRole('button', { name: /写作 \d+/ })).toBeVisible({ timeout: 20_000 })

    // 未知类型的菜单项置灰
    await page.getByRole('button', { name: /写作 \d+/ }).click({ button: 'right' })
    const item = page.getByRole('menuitem', { name: /以此 agent 新建实例/ })
    await expect(item).toBeDisabled()

    // 类型定义那条菜单里显示的是「未知 agent」
    await expect(page.getByText(/未知 agent/).first()).toBeVisible()
  })
})
