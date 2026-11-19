import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager } from '@earendil-works/pi-coding-agent'

/**
 * 自己写进会话的提示不能把自己标成「在别处改过」。
 *
 * 回归用例：一轮结束时保号校验发现号错位，会给对话追加一条 `[annotation]` 提示。
 * 这条提示是 Codelet 自己写的；如果不把「已看到」的时间推上去，下一次 stale 检查
 * 就会看到文件比 seenMtime 新，界面冒出「这个会话在别处有更新」，用户点重新加载
 * 才发现是虚惊 —— 更糟的是，误点重新加载会重建 runtime。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let sessionFile = ''
let app: ElectronApplication | null = null
let page: Page

function prototypeHtml(text: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>原型</title></head>
<body>
  <div data-block="1">顶部导航</div>
  <div data-block="2">${text}</div>
</body></html>
`
}

test.describe.serial('自己写的提示不触发 stale', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-stale-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-stale-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-stale-e2e-agent-'))
    writeFileSync(join(projectDir, 'prototype.html'), prototypeHtml('原始文字'))

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const manager = SessionManager.create(projectDir)
      for (let index = 1; index <= 3; index += 1) {
        manager.appendMessage({
          role: 'user',
          content: [{ type: 'text', text: `第 ${index} 轮用户输入` }],
          timestamp: Date.now() + index
        })
      }
      sessionFile = manager.getSessionFile() ?? ''
      if (!sessionFile) throw new Error('会话文件没有创建出来')
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }

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
              sessionPath: sessionFile,
              createdAt: now,
              lastActiveAt: now,
              archivedAt: null,
              turns: 3,
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
              pane: 'agent',
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

    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: { ...process.env, CODELET_USER_DATA: userDataDir, PI_CODING_AGENT_DIR: agentDir },
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

  test('保号提示之后没有 stale；/reload 之后历史还在', async () => {
    // 打开原型，让「一轮结束」有东西可校验
    const addressBar = page.getByLabel('浏览器地址')
    await addressBar.fill(pathToFileURL(join(projectDir, 'prototype.html')).toString())
    await addressBar.press('Enter')
    await expect(page.getByRole('button', { name: /原型/ })).toBeVisible({ timeout: 10_000 })

    // 合成一轮：开始 → 改原型的块文字 → 结束。保号校验会追加一条提示。
    const emit = (type: string): Promise<void> =>
      app!.evaluate(
        (_electron, eventType) =>
          (
            globalThis as unknown as {
              __codeletSessionEvent: (event: {
                type: string
                data: unknown
                agentId: string
              }) => void
            }
          ).__codeletSessionEvent({ type: eventType, data: {}, agentId: 'agent-p' }),
        type
      )
    await emit('agent_start')
    await page.waitForTimeout(300)
    writeFileSync(join(projectDir, 'prototype.html'), prototypeHtml('改过的文字'))
    await emit('agent_settled')

    await expect(page.getByText('[annotation]')).toBeVisible({ timeout: 10_000 })

    /*
     * stale 检查是会话列表刷新时跑的，而刷新有防抖 —— 光等一会儿不一定跑得上。
     * 这里主动走一次「离开够久再回来」，让刷新和 stale 检查确定地在我们写入提示之后跑。
     */
    await page.waitForTimeout(1000)
    await app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.blur()
    })
    await page.waitForTimeout(3200)
    await app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      win?.focus()
    })
    await page.waitForTimeout(800)
    const stale = await page.evaluate(async () => {
      const api = (
        window as unknown as {
          codelet: {
            getSnapshot: () => Promise<{ agents: Array<{ id: string; stale: boolean }> }>
          }
        }
      ).codelet
      const snapshot = await api.getSnapshot()
      return snapshot.agents.filter((agent) => agent.stale).map((agent) => agent.id)
    })
    expect(stale).toEqual([])
    await expect(page.getByText('这个会话在别处有更新')).toHaveCount(0)

    // 历史（3 条用户消息 + 那条提示）在 /reload 之后仍然在
    const composer = page.locator('textarea').first()
    await composer.fill('/reload')
    await composer.press('Enter')
    await expect(page.getByText('已重新加载扩展和会话')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = (
            window as unknown as {
              codelet: { getAgentEntries: (agentId: string) => Promise<unknown[]> }
            }
          ).codelet
          return (await api.getAgentEntries('agent-p')).length
        })
      )
      .toBe(4)
    await expect(page.getByText('第 1 轮用户输入')).toBeVisible()
  })
})
