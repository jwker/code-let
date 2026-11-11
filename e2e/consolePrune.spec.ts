import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebugConsoleStore } from '../host/main/debugConsole'

/**
 * 调试记录的自动清理。
 *
 * 种子数据要在启动**之前**写进去 —— 要验的正是「启动时清一次」。
 * 用临时应用数据目录，不碰真实记录。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DAY = 24 * 60 * 60 * 1000

let userDataDir = ''
let app: ElectronApplication | null = null
let page: Page

/** 一条记录 */
function record(id: string, capturedAt: number) {
  return {
    id,
    sessionId: 'session-prune',
    sessionName: '清理 E2E',
    prompt: id,
    tabId: 'tab-prune',
    model: { provider: 'anthropic', id: 'claude-prune' },
    capturedAt,
    transcript: { messages: [{ role: 'user', content: [{ type: 'text', text: id }] }] },
    provider: { model: 'claude-prune', messages: [{ role: 'user', content: id }] },
    response: { status: 200, headers: {}, message: { role: 'assistant', content: id } }
  }
}

test.describe.serial('调试记录自动清理', () => {
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-prune-e2e-'))

    /*
     * 把「至少保留」设为 0 —— 默认的 50 条保底会护住仅有的两条记录，
     * 那样测不到「超期就删」这条规则。
     */
    writeFileSync(
      join(userDataDir, 'settings.json'),
      JSON.stringify({ 'console.keepRecent': 0, 'console.autoDelete': true }, null, 2)
    )

    // 先写记录再启动 —— 启动时会清一次
    const store = new DebugConsoleStore(join(userDataDir, 'debug-console'))
    // 种子阶段别自己清 —— 要留给应用启动时去清
    store.setAutoDelete(false)
    store.enqueue(record('很久以前的记录', Date.now() - 30 * DAY))
    store.enqueue(record('刚记下的记录', Date.now()))
    for (let i = 0; i < 50; i += 1) {
      if (store.status().writing === 0) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(store.list().records).toHaveLength(2)

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
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true })
  })

  test('启动时把超期的记录清掉，新的留着', async () => {
    await page.getByRole('button', { name: '控制台', exact: true }).click()
    const pane = page.locator('.insp-body')

    // 新的还在
    await expect(pane.getByRole('button', { name: /刚记下的记录/ })).toBeVisible({
      timeout: 10_000
    })
    // 超期的没了
    await expect(pane.getByText('很久以前的记录')).toHaveCount(0)
    // 统计里只剩一条
    await expect(pane.getByText(/^1 条/)).toBeVisible()
  })

  test('统计那一行带上占用上限', async () => {
    const pane = page.locator('.insp-body')
    // 开了自动清理并设了上限 → 「N 条 · XB / 512.0MB」
    await expect(pane.getByText(/\/ 512\.0MB/)).toBeVisible()
  })
})
