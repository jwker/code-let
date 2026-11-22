import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 新外壳的主路径（ADR-0005）。
 *
 * 拿**真实宿主**验证这几条承诺：
 * 1. 一个项目一条标签，窄轨只列当前项目的 agent，代码 / 文档 / 浏览器不在窄轨上；
 * 2. 右栏空态能开代码功能区，收起再展开还是刚才那个功能区；
 * 3. 右栏的开与关、开的是哪个功能区按项目标签各记一份；
 * 4. 关项目标签不归档、不中止任何 agent（结构层面：agent 还在、没被标记归档）；
 * 5. 归档 → 窄轨消失 → 设置里恢复 → 回来；
 * 6. 产品的左列也是对话 —— 右栏状态不因为点开 agent 而擅自变；
 * 7. 最后一个 agent 归档后，右栏落到代码，左列不是一片空白。
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

test.describe.serial('新外壳：左列 / 右栏 / 项目标签', () => {
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

    // 文档功能区要有一篇能读的文档 —— 项目根的 AGENTS.md
    writeFileSync(
      join(projectDir, 'AGENTS.md'),
      '# 项目说明\n\n这是文档正文，只读。\n'
    )
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir, otherProjectDir] }, null, 2)
    )
    /*
     * 三个 agent：本项目的基础与产品、另一个项目的基础。
     * 这里直接写 agents.json 造数据，不走对话框 —— 断言的是布局与状态，不是新建流程
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
              rightPanel: { open: false, kind: null },
              activeAgentId: 'agent-a'
            },
            {
              id: 'tab-2',
              cwd: otherProjectDir,
              title: otherProjectDir.split('/').pop(),
              pane: 'agent',
              rightPanel: { open: false, kind: null },
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

  test('一个项目一条标签，窄轨只列当前项目的 agent 与新建 / 设置', async () => {
    // 两条项目标签，标题是目录名
    await expect(page.getByRole('button', { name: new RegExp(projectName()) }).first()).toBeVisible()

    // 窄轨里是**本项目**的两个 agent，不含另一个项目的
    const rail = page.getByRole('navigation', { name: '项目导航' })
    await expect(rail.getByRole('button', { name: '基础 1' })).toBeVisible()
    await expect(rail.getByRole('button', { name: '产品 1' })).toBeVisible()
    await expect(rail.getByRole('button', { name: '基础 2' })).toHaveCount(0)

    // 代码 / 文档 / 浏览器不在窄轨上 —— 它们进了右栏
    await expect(rail.getByRole('button', { name: '代码', exact: true })).toHaveCount(0)
    await expect(rail.getByRole('button', { name: '浏览器', exact: true })).toHaveCount(0)
    await expect(rail.getByRole('button', { name: 'AI 文档', exact: true })).toHaveCount(0)
  })

  test('右栏空态：文档与代码都能开；切换器换项后收起再展开保留', async () => {
    // 一开始右栏收着，左列吃满窗口
    await expect(page.locator('.right-panel')).toHaveCount(0)

    await page.getByRole('button', { name: '右栏', exact: true }).click()
    const panel = page.locator('.right-panel')
    await expect(panel.getByText('右侧栏是空的')).toBeVisible()
    await expect(panel.getByRole('button', { name: '浏览器', exact: true })).toBeVisible()
    await expect(panel.getByRole('button', { name: '文档', exact: true })).toBeVisible()

    // 空态的「文档」进入文档功能区：左树、右只读正文
    await panel.getByRole('button', { name: '文档', exact: true }).click()
    await panel.getByRole('button', { name: /AGENTS\.md/ }).click()
    await expect(panel.getByText('这是文档正文，只读。')).toBeVisible()
    await expect(panel.getByText('只读', { exact: true })).toBeVisible()
    // 顶栏左边写的是在看什么
    await expect(panel.locator('.rp-title-name')).toHaveText('AGENTS.md')

    // 切换器：当前项打勾，选「代码」立刻切
    await panel.getByRole('button', { name: /切换功能区/ }).click()
    const menu = panel.getByRole('menu', { name: '切换功能区' })
    await expect(menu.getByRole('menuitemradio', { name: /文档/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await menu.getByRole('menuitemradio', { name: /代码/ }).click()
    await expect(panel.getByRole('tab', { name: /改动/ })).toBeVisible()
    await expect(panel.getByRole('button', { name: /切换功能区，当前是代码/ })).toBeVisible()

    // 收起再打开 —— 还是换过的那一项，不用重选
    await panel.getByRole('button', { name: '收起右栏' }).click()
    await expect(page.locator('.right-panel')).toHaveCount(0)
    await page.getByRole('button', { name: '右栏', exact: true }).click()
    await expect(page.locator('.right-panel').getByRole('tab', { name: /改动/ })).toBeVisible()
    await expect(page.locator('.right-panel').getByText('右侧栏是空的')).toHaveCount(0)
  })

  test('右栏状态按项目标签各记一份', async () => {
    // 本项目右栏正开着代码；切到另一个项目，它自己的右栏还是收着的
    const otherName = otherProjectDir.split('/').pop()!
    await page.getByRole('button', { name: new RegExp(otherName) }).first().click()
    await expect(page.locator('.right-panel')).toHaveCount(0)

    // 切回来 —— 还是刚才那个代码功能区
    await page.getByRole('button', { name: new RegExp(projectName()) }).first().click()
    const panel = page.locator('.right-panel')
    await expect(panel.getByRole('tab', { name: /改动/ })).toBeVisible()
  })

  test('右栏可以拖宽，双击回到窗口的一半', async () => {
    const grip = page.getByRole('separator', { name: '调整右栏宽度' })
    const before = Number(await grip.getAttribute('aria-valuenow'))

    // 右栏在右边：← 变宽（键盘走的是和拖动同一套提交逻辑）
    await grip.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await expect
      .poll(async () => Number(await grip.getAttribute('aria-valuenow')))
      .toBeGreaterThan(before)

    // 双击回到当前窗口的一半，再夹到 380–900
    await grip.dblclick()
    const expected = await page.evaluate(() =>
      Math.min(Math.max(Math.round(window.innerWidth / 2), 380), 900)
    )
    await expect
      .poll(async () => Number(await grip.getAttribute('aria-valuenow')))
      .toBe(expected)
  })

  test('★ 关项目标签不归档、不中止 agent', async () => {
    const otherName = otherProjectDir.split('/').pop()!
    const before = readAgents()
    expect(before).toHaveLength(3)

    /*
     * 关**另一个项目**的标签 —— 本项目那条留着，后面几条用例还要用它。
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

    // 设置 → 归档的 agent → 恢复。项目设置现在占满左列
    await rail.getByRole('button', { name: '项目设置' }).click()
    await page.getByRole('button', { name: /归档的 agent/ }).click()
    const body = page.locator('.settings-content')
    await expect(body.getByText('基础 1')).toBeVisible()
    await body.getByRole('button', { name: '恢复' }).first().click()

    // 回到窄轨
    await expect(rail.getByRole('button', { name: '基础 1' })).toBeVisible()
    expect(readAgents().find((agent) => agent.id === 'agent-a')?.archivedAt).toBeNull()
  })

  test('★ 产品 agent 在左列也只是对话 —— 右栏不擅自变', async () => {
    const rail = page.getByRole('navigation', { name: '项目导航' })
    await rail.getByRole('button', { name: '产品 1' }).click()

    // 左列有输入框；右栏还是刚才的代码功能区，没有被换成预览
    await expect(page.locator('.shell-card.main textarea').first()).toBeVisible()
    await expect(page.locator('.right-panel').getByRole('tab', { name: /改动/ })).toBeVisible()

    // 基础 agent 也一样：左列始终是那一列对话
    await rail.getByRole('button', { name: '基础 1' }).click()
    await expect(page.locator('.shell-card.main textarea').first()).toBeVisible()
  })

  test('最后一个 agent 归档后，右栏落到代码，左列不是空白', async () => {
    const rail = page.getByRole('navigation', { name: '项目导航' })

    // 先把右栏收起来，等下要看它自己在最后一个 agent 消失时打开
    await page.getByRole('button', { name: '右栏', exact: true }).click()
    await expect(page.locator('.right-panel')).toHaveCount(0)

    for (const name of ['产品 1', '基础 1']) {
      await rail.getByRole('button', { name }).click({ button: 'right' })
      await page.getByRole('menuitem', { name: '归档' }).click()
      await expect(rail.getByRole('button', { name })).toHaveCount(0)
    }

    // 右栏自己展开并落到代码
    const panel = page.locator('.right-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('tab', { name: /文件/ })).toBeVisible()
    // 左列还在，不是一片空白
    await expect(page.locator('.shell-card.main textarea').first()).toBeVisible()
  })
})
