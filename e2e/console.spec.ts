import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebugConsoleStore } from '../host/main/debugConsole'

/**
 * 调试控制台面板。
 *
 * 记录由存储层直接写进应用数据目录 —— 端到端不跑模型，只验界面这一段。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let userDataDir = ''
let app: ElectronApplication | null = null
let page: Page

/** 详情开着的话先退回列表 */
async function goBackToList(page: Page): Promise<void> {
  const back = page.getByRole('button', { name: '‹ 列表' })
  if ((await back.count()) > 0) await back.click()
}

/** 刚导出的那个 zip 在临时目录里 —— 取最新的那个 */
function newestExport(): string | null {
  const names = readdirSync(tmpdir()).filter((name) => /^codelet-console-.*\.zip$/.test(name))
  if (names.length === 0) return null
  const newest = names
    .map((name) => join(tmpdir(), name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!
  return newest
}

test.describe.serial('调试控制台', () => {
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-console-e2e-'))

    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        CODELET_USER_DATA: userDataDir
      },
      timeout: 30_000
    })
    const mainPage = await app.firstWindow()
    await expect(mainPage.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
    // 往应用数据目录里写一条记录
    const store = new DebugConsoleStore(join(userDataDir, 'debug-console'))
    store.enqueue({
      id: 't-e2e-1',
      sessionId: 'session-e2e',
      sessionName: '控制台 E2E',
      prompt: '这段内容要能搜到',
      tabId: 'tab-e2e',
      model: { provider: 'anthropic', id: 'claude-e2e' },
      capturedAt: Date.now(),
      transcript: {
        messages: [
          { role: 'system', content: [{ type: 'text', text: '你是一个编码助手' }] },
          { role: 'user', content: [{ type: 'text', text: '这段内容要能搜到' }] }
        ]
      },
      provider: { model: 'claude-e2e', messages: [{ role: 'user', content: '这段内容要能搜到' }] },
      response: { status: 200, headers: {}, message: { role: 'assistant', content: '好' } }
    })
    for (let i = 0; i < 50; i += 1) {
      if (store.status().writing === 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    /*
     * 控制台从「右侧检视器的一个视图」变成了**独立窗口**（PLAN.md D56）。
     * 窗口在挂载时读一次列表，所以要在写完记录之后再开它。
     * 接下来的断言都在控制台窗口里做 —— 它整窗只有控制台，选择器从 `.insp-body` 换成 `body`。
     */
    const consoleWindow = app.waitForEvent('window')
    await mainPage.evaluate(() =>
      (window as unknown as { codelet: { openConsoleWindow(): Promise<void> } }).codelet.openConsoleWindow()
    )
    page = await consoleWindow
    await expect(page.getByText('调试控制台')).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
  })

  test('列出记录，展开一级节点，再展开一条消息', async () => {
    const pane = page.locator('body')
    const row = pane.getByRole('button', { name: /这段内容要能搜到/ })
    await expect(row).toBeVisible()

    // 列表页在「请求」这个标签下
    await expect(page.getByRole('button', { name: '请求', exact: true })).toBeVisible()

    // 点开记录 → 抽屉
    await row.click()
    const drawer = page.locator('body')
    await expect(drawer.getByRole('button', { name: /transcript/ })).toBeVisible()
    await expect(drawer.getByText('claude-e2e').first()).toBeVisible()

    // 详情是「请求」这一页里的下钻 —— 标签栏还在
    await expect(page.getByRole('button', { name: '请求', exact: true })).toBeVisible()

    // transcript 页签：骨架里能看到两条消息
    await expect(drawer.getByText('messages', { exact: false }).first()).toBeVisible()
    await expect(drawer.getByText('"system"').first()).toBeVisible()

    // 展开一条消息 → 它的内容块
    await drawer.getByText('messages[1]', { exact: false }).first().click()
    await expect(drawer.getByText('这段内容要能搜到').first()).toBeVisible({ timeout: 10_000 })
  })

  test('provider 页签能看到原始 payload', async () => {
    // 上一条用例留了个抽屉开着 —— 先关掉
    await goBackToList(page)
    const pane = page.locator('body')
    await pane.getByRole('button', { name: /这段内容要能搜到/ }).click()
    const open = page.locator('body')
    await open.getByRole('button', { name: /provider/ }).click()
    await expect(open.getByText('claude-e2e').first()).toBeVisible()
  })

  test('可以勾选多条，然后批量删', async () => {
    // 上一条用例留了个抽屉开着 —— 先关掉
    await goBackToList(page)

    // 写三条记录
    const store = new DebugConsoleStore(join(userDataDir, 'debug-console'))
    for (const id of ['t-e2e-a', 't-e2e-b', 't-e2e-c']) {
      store.enqueue({
        id,
        sessionId: 'session-e2e',
        sessionName: '批量会话',
        prompt: '批量内容',
        tabId: 'tab-e2e',
        model: { provider: 'anthropic', id: 'claude-e2e' },
        capturedAt: Date.now(),
        transcript: { messages: [{ role: 'user', content: '内容' }] },
        provider: { model: 'claude-e2e' },
        response: { status: 200, headers: {} }
      })
    }
    for (let i = 0; i < 50; i += 1) {
      if (store.status().writing === 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await page.reload()
    // 控制台窗口里没有输入框 —— 等它自己的标签页出来即为就绪
    await expect(page.getByRole('button', { name: '请求', exact: true })).toBeVisible({ timeout: 20_000 })
    const list = page.locator('body')

    // 勾两条
    const boxes = list.getByRole('checkbox')
    await boxes.nth(0).click()
    await boxes.nth(1).click()
    await expect(list.getByText(/已选/)).toBeVisible()
    await expect(list.getByRole('button', { name: '导出所选' })).toBeVisible()

    // 删掉 —— 先确认
    await list.getByRole('button', { name: '删除所选' }).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm.getByText(/删除选中的/)).toBeVisible()
    await confirm.getByRole('button', { name: '删除' }).click()

    await expect(list.getByText(/已删除 2 条记录/)).toBeVisible({ timeout: 10_000 })
  })

  test('详情里的「导出这一条」能真的导出成包', async () => {
    await goBackToList(page)
    const pane = page.locator('body')
    await pane.getByRole('button', { name: /这段内容要能搜到/ }).click()

    await page.getByRole('button', { name: '导出', exact: true }).click()
    // 主进程里保存对话框被换成了写临时目录 —— 等导出完成
    await expect(pane.getByText(/已导出到/)).toBeVisible({ timeout: 20_000 })

    const path = newestExport()
    expect(path).not.toBeNull()
    const listing = execFileSync('unzip', ['-l', path!], { encoding: 'utf8' })
    expect(listing).toContain('manifest.json')
    expect(listing).toContain('requests/')
    rmSync(path!, { force: true })
  })

  test('控制台是单实例窗口：再打开一次只是聚焦，不开第二个', async () => {
    // 控制台现在**始终**是独立窗口（PLAN.md D56），没有「分离 / 收回」这回事了
    await page.evaluate(() =>
      (window as unknown as { codelet: { openConsoleWindow(): Promise<void> } }).codelet.openConsoleWindow()
    )
    await expect.poll(() => app!.windows().length, { timeout: 10_000 }).toBe(2)
    await expect(page.getByText('调试控制台')).toBeVisible()
  })

  test('三个窗口各有各的标题，Dock 菜单里能分清', async () => {
    const detached = page
    // 主窗口（app 的第一个窗口）和设置窗口从这里开
    const mainPage = app!.windows()[0]
    await mainPage.getByRole('button', { name: '更多' }).click()
    await mainPage.getByRole('menuitem', { name: '设置' }).click()
    const settings = await app!.waitForEvent('window')
    await settings.waitForTimeout(600)

    // 红绿灯旁边的标题 = 窗口标题
    expect(await mainPage.title()).toBe('Codelet')
    expect(await detached.title()).toBe('调试控制台')
    expect(await settings.title()).toBe('设置')

    // Dock 右键菜单里按标题列出这几个窗口
    const dockItems = await app!.evaluate(({ app: electronApp }) => {
      const menu = electronApp.dock?.getMenu()
      return menu ? menu.items.map((item) => item.label) : []
    })
    expect(dockItems).toContain('Codelet')
    expect(dockItems).toContain('设置')
    expect(dockItems).toContain('调试控制台')

    // 收掉这两个窗口，后一条用例自己开
    await settings.close()
    await detached.close()
    await expect.poll(() => app!.windows().length, { timeout: 10_000 }).toBe(1)
  })

  test('设置窗口能打开，里面有记录开关和占用统计', async () => {
    // `page` 现在是控制台窗口 —— 「更多 → 设置」在主窗口上
    const mainPage = app!.windows()[0]
    await mainPage.getByRole('button', { name: '更多' }).click()
    await mainPage.getByRole('menuitem', { name: '设置' }).click()

    const settings = await app!.waitForEvent('window')
    // 设置窗口默认停在第一个有内容的分类 —— 这几项在「调试」里，先切过去
    await settings.getByRole('button', { name: '调试' }).click()
    await expect(settings.getByText('记录请求内容')).toBeVisible({ timeout: 20_000 })
    await expect(settings.getByText('当前存储占用')).toBeVisible()
    await expect(settings.getByText('记录条数')).toBeVisible()
  })
})
