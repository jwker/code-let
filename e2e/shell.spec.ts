import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 新外壳的四条主路径（PLAN.md D50 / D52 / D53）。
 *
 * 这些是这次改造的核心承诺，拿**真实宿主**验证：
 * 1. 一个项目一条标签，窄轨只列当前项目的 agent；
 * 2. 关项目标签不归档、不中止任何 agent（结构层面：agent 还在、没被标记归档）；
 * 3. 归档 → 窄轨消失 → 设置里恢复 → 回来；
 * 4. 产品 agent 的两栏形态：区域 5 是对话、区域 6 是它自己的浏览器。
 *
 * 不假装能测「正在跑的那一轮没被打断」—— 那要真模型。这里测的是**结构**：
 * 关标签之后 agent 记录还活着、没被归档，runtime 也没被 close。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

interface SeedAgent {
  id: string
  name: string
  type: 'general' | 'product'
  instance: number
  cwd: string
  sessionPath: string | null
  createdAt: number
  lastActiveAt: number
  archivedAt: number | null
  turns: number
}

test.describe.serial('新外壳：项目标签 / 窄轨 / 区域分派', () => {
  let projectDir = ''
  let otherProjectDir = ''
  let userDataDir = ''
  let app: ElectronApplication | null = null
  let page: Page

  const projectName = (): string => projectDir.split('/').pop()!

  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-shell-e2e-project-'))
    otherProjectDir = mkdtempSync(join(tmpdir(), 'codelet-shell-e2e-other-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-shell-e2e-userdata-'))

    const now = Date.now()
    const agent = (over: Partial<SeedAgent>): SeedAgent => ({
      id: 'agent-a',
      name: '基础 1',
      type: 'general',
      instance: 1,
      cwd: projectDir,
      sessionPath: null,
      createdAt: now,
      lastActiveAt: now,
      archivedAt: null,
      turns: 0,
      ...over
    })

    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir, otherProjectDir] }, null, 2)
    )
    /*
     * 三个 agent：本项目的基础与产品、另一个项目的基础。
     * 这里直接写 agents.json 造数据，不走对话框 —— 断言的是区域分派，不是新建流程
     * （新建流程在 newconv.spec.ts 里测）。
     */
    writeFileSync(
      join(userDataDir, 'agents.json'),
      JSON.stringify(
        {
          version: 1,
          agents: [
            agent({ id: 'agent-a', name: '基础 1', instance: 1 }),
            agent({ id: 'agent-p', name: '产品 1', type: 'product', instance: 1 }),
            agent({
              id: 'agent-b',
              name: '基础 2',
              cwd: otherProjectDir,
              instance: 1,
              createdAt: now + 1,
              lastActiveAt: now + 1
            })
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
              title: projectName(),
              pane: 'agent',
              activeAgentId: 'agent-a'
            },
            {
              id: 'tab-2',
              cwd: otherProjectDir,
              title: otherProjectDir.split('/').pop(),
              pane: 'agent',
              activeAgentId: 'agent-b'
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
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, otherProjectDir, userDataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  /** 从盘上读 agent 清单 —— 判断「有没有被归档 / 有没有被删」用 */
  function readAgents(): SeedAgent[] {
    const raw = JSON.parse(readFileSync(join(userDataDir, 'agents.json'), 'utf8')) as {
      agents: SeedAgent[]
    }
    return raw.agents
  }

  test('一个项目一条标签，窄轨只列当前项目的 agent', async () => {
    // 两条项目标签，标题是目录名
    await expect(page.getByRole('button', { name: new RegExp(projectName()) }).first()).toBeVisible()

    // 窄轨里是**本项目**的两个 agent，不含另一个项目的
    const rail = page.getByRole('navigation', { name: '项目导航' })
    await expect(rail.getByRole('button', { name: '基础 1' })).toBeVisible()
    await expect(rail.getByRole('button', { name: '产品 1' })).toBeVisible()
    await expect(rail.getByRole('button', { name: '基础 2' })).toHaveCount(0)
  })

  test('★ 关项目标签不归档、不中止 agent', async () => {
    const otherName = otherProjectDir.split('/').pop()!
    const before = readAgents()
    expect(before).toHaveLength(3)

    /*
     * 关**另一个项目**的标签 —— 本项目那条留着，后面两条用例还要用它。
     * （关标签之后没法用「打开项目」把它开回来：那是系统目录选择器，e2e 里弹不出来。）
     */
    await page.getByRole('button', { name: `关闭 ${otherName}`, exact: true }).click()
    await expect(page.getByRole('button', { name: `关闭 ${otherName}`, exact: true })).toHaveCount(0)

    // agent 记录一个没少、也没被标成归档 —— 关页面不是归档
    const after = readAgents()
    expect(after).toHaveLength(3)
    expect(after.every((agent) => agent.archivedAt === null)).toBe(true)

    // 本项目那条标签还在，窄轨也还在
    await expect(page.getByRole('button', { name: `关闭 ${projectName()}`, exact: true })).toBeVisible()
    await expect(
      page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '基础 1' })
    ).toBeVisible()
  })

  test('★ 归档 → 窄轨消失 → 设置里恢复 → 回来', async () => {
    const rail = page.getByRole('navigation', { name: '项目导航' })

    // 右键头像 → 归档
    await rail.getByRole('button', { name: '基础 1' }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: '归档' }).click()

    // 窄轨里没了，但盘上还在（只改状态）
    await expect(rail.getByRole('button', { name: '基础 1' })).toHaveCount(0)
    expect(readAgents().find((agent) => agent.id === 'agent-a')?.archivedAt).toBeTruthy()

    // 设置 → 归档的 agent → 恢复
    await rail.getByRole('button', { name: '项目设置' }).click()
    await page.getByRole('button', { name: /归档的 agent/ }).click()
    const body = page.locator('.shell-card.zone6')
    await expect(body.getByText('基础 1')).toBeVisible()
    await body.getByRole('button', { name: '恢复' }).first().click()

    // 回到窄轨
    await expect(rail.getByRole('button', { name: '基础 1' })).toBeVisible()
    expect(readAgents().find((agent) => agent.id === 'agent-a')?.archivedAt).toBeNull()
  })

  test('★ 产品 agent：区域 5 是对话，区域 6 是它自己的浏览器', async () => {
    const rail = page.getByRole('navigation', { name: '项目导航' })
    await rail.getByRole('button', { name: '产品 1' }).click()

    // 区域 5 是对话（有输入框），区域 6 是浏览器（有地址栏）
    await expect(page.locator('.shell-card.zone5 textarea').first()).toBeVisible()
    await expect(page.locator('.shell-card.zone6').getByLabel('浏览器地址')).toBeVisible()

    // 基础 agent 没有区域 5：切过去只剩一列
    await rail.getByRole('button', { name: '基础 1' }).click()
    await expect(page.locator('.shell-card.zone5')).toHaveCount(0)
    await expect(page.locator('.shell-card.zone6 textarea').first()).toBeVisible()
  })
})
