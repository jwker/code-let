import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SessionManager } from '@earendil-works/pi-coding-agent'

/**
 * 窄轨上的气泡不该让右边的原型预览整片消失。
 *
 * 预览是原生 `WebContentsView`，永远画在 DOM 之上；以前只要有浮层就把它收起来，
 * 于是鼠标扫过 agent 头像，右边的页面就没了。现在只在浮层真的压到预览上时才收。
 *
 * 顺带验反方向：对话框被限制在左列里，它开着的时候预览**不该**收起。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

/** 主进程里原生预览当前归谁 —— 收起时是 null */
const visibleHost = (): Promise<string | null> =>
  app!.evaluate(() => {
    const browser = (globalThis as unknown as { __codeletBrowser: { visibleHost: string | null } })
      .__codeletBrowser
    return browser.visibleHost
  })

test.describe.serial('窄轨气泡与原生预览', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-overlay-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-overlay-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-overlay-e2e-agent-'))

    // 产品 agent 的原型目录里放一个页面，预览会被恢复起来
    const prototypeDir = join(projectDir, '.codelet/prototype')
    mkdirSync(prototypeDir, { recursive: true })
    const prototypeFile = join(prototypeDir, 'demo.html')
    writeFileSync(prototypeFile, '<!doctype html><html><body><h1>原型</h1></body></html>')

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    let sessionFile = ''
    try {
      const manager = SessionManager.create(projectDir)
      manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '给我一个最简单的 todo list' }],
        timestamp: Date.now()
      } as never)
      sessionFile = manager.getSessionFile() ?? ''
      if (!sessionFile) throw new Error('会话文件没有创建出来')
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    }

    const now = Date.now()
    writeFileSync(join(userDataDir, 'projects.json'), JSON.stringify({ projects: [projectDir] }, null, 2))
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
              turns: 1,
              previewUrl: pathToFileURL(prototypeFile).toString()
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
              rightPanel: { open: true, kind: 'browser' },
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
    await expect(page.getByLabel('浏览器地址')).toHaveValue(/demo\.html/, { timeout: 20_000 })
    // 预览的原生 view 露出来了才算进入要验的状态
    await expect.poll(visibleHost).toBe('agent:agent-p')
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('鼠标停在 agent 头像上，右边的预览不收起', async () => {
    await page.getByRole('button', { name: '产品 1' }).hover()
    await expect(page.locator('.rail-tip')).toBeVisible({ timeout: 5_000 })
    // 气泡整个落在左列里，不该碰右栏的原生视图
    expect(await visibleHost()).toBe('agent:agent-p')

    await page.mouse.move(200, 400)
    await expect(page.locator('.rail-tip')).toHaveCount(0)
    expect(await visibleHost()).toBe('agent:agent-p')
  })

  test('新建 agent 对话框只在左列里，右栏的预览不收起', async () => {
    await page
      .getByRole('navigation', { name: '项目导航' })
      .getByRole('button', { name: '新建 agent' })
      .click()
    await expect(page.getByRole('dialog', { name: '新建 agent' })).toBeVisible()
    // 遮罩与对话框都只铺左列，碰不到右栏的原生视图
    expect(await visibleHost()).toBe('agent:agent-p')

    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '新建 agent' })).toHaveCount(0)
    expect(await visibleHost()).toBe('agent:agent-p')
  })
})
