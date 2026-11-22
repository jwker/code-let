import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 右侧浏览器：本地 HTTP 页面、标签状态和地址拦截。 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let server: Server | null = null
let app: ElectronApplication | null = null
let page: Page
let port = 0

test.describe.serial('浏览器面板', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-browser-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-browser-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-browser-e2e-agent-'))

    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><title>Local Test</title><h1>LOCAL_PAGE_OK</h1>' +
          '<button id="go">点我</button><input id="field" placeholder="输入框" />'
      )
    })
    await new Promise<void>((resolveReady) => server!.listen(0, '127.0.0.1', resolveReady))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('测试服务器没有端口')
    port = address.port

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
            tabs: [{ id: 'tab-e2e-browser', cwd: projectDir, path: sessionFile, title: '浏览器 E2E' }],
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
    await new Promise<void>((resolveClose) => {
      if (!server) return resolveClose()
      server.close(() => resolveClose())
    })
    server = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  /** 把右栏开到浏览器功能区。第一次走空态按钮，之后切换器换过去。 */
  async function openProjectBrowser(): Promise<void> {
    const panel = page.locator('.right-panel')
    if ((await panel.count()) === 0) {
      await page.getByRole('button', { name: '右栏', exact: true }).click()
    }
    if ((await page.getByLabel('浏览器地址').count()) > 0) return
    if ((await panel.getByRole('button', { name: '浏览器', exact: true }).count()) > 0) {
      await panel.getByRole('button', { name: '浏览器', exact: true }).click()
      return
    }
    await panel.getByRole('button', { name: /切换功能区/ }).click()
    await panel.getByRole('menuitemradio', { name: /浏览器/ }).click()
  }

  test('打开本地页面、显示标签标题并拦截外网地址', async () => {
    await openProjectBrowser()
    const panel = page.locator('.right-panel')
    // 工具栏与页面标签行都在浏览器功能区内部
    await expect(panel.getByRole('button', { name: '新建浏览器标签' })).toBeVisible()
    await expect(panel.getByLabel('浏览器地址')).toBeVisible()
    // 项目级宿主没有标注开关
    await expect(panel.getByRole('button', { name: '标注' })).toHaveCount(0)

    const addressBar = page.getByLabel('浏览器地址')
    await addressBar.fill(`http://127.0.0.1:${port}/`)
    await addressBar.press('Enter')

    await expect(page.getByRole('button', { name: /Local Test/ })).toBeVisible({ timeout: 10_000 })
    await expect(addressBar).toHaveValue(`http://127.0.0.1:${port}/`)

    const webContents = await app!.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((contents) => ({
        title: contents.getTitle(),
        url: contents.getURL()
      }))
    )
    expect(webContents.some((item) => item.title === 'Local Test')).toBe(true)

    await addressBar.fill('https://example.com/')
    await addressBar.press('Enter')
    await expect(page.getByText('当前浏览器只打开本地页面')).toBeVisible({ timeout: 10_000 })
  })

  test('agent 工具能读页面、点击、输入、等待和截图', async () => {
    await openProjectBrowser()
    const addressBar = page.getByLabel('浏览器地址')
    await addressBar.fill(`http://127.0.0.1:${port}/`)
    await addressBar.press('Enter')
    await expect(page.getByRole('button', { name: /Local Test/ })).toBeVisible({ timeout: 10_000 })

    const snapshot = (await app!.evaluate(async () => {
      const manager = (globalThis as never as { __codeletBrowser: { tool: (name: string, args: Record<string, unknown>) => Promise<unknown> } }).__codeletBrowser
      return manager.tool('snapshot', {})
    })) as {
      total: number
      elements: Array<{ ref: string; tag: string; text: string }>
    }
    expect(snapshot.total).toBeGreaterThan(0)
    const button = snapshot.elements.find((element) => element.text.includes('点我'))
    expect(button).toBeTruthy()

    const clicked = (await app!.evaluate(async (_electron, ref: string) => {
      const manager = (globalThis as never as { __codeletBrowser: { tool: (name: string, args: Record<string, unknown>) => Promise<unknown> } }).__codeletBrowser
      return manager.tool('click', { ref })
    }, button!.ref)) as { clicked: string; label: string }
    expect(clicked.clicked).toBe(button!.ref)

    const typed = (await app!.evaluate(async (_electron, ref: string) => {
      const manager = (globalThis as never as { __codeletBrowser: { tool: (name: string, args: Record<string, unknown>) => Promise<unknown> } }).__codeletBrowser
      return manager.tool('type', { ref, text: 'hello' })
    }, snapshot.elements.find((element) => element.tag === 'input')!.ref)) as { typed: string }
    expect(typed.typed).toBeTruthy()

    const waited = (await app!.evaluate(async () => {
      const manager = (globalThis as never as { __codeletBrowser: { tool: (name: string, args: Record<string, unknown>) => Promise<unknown> } }).__codeletBrowser
      return manager.tool('wait', { selector: '#go', timeoutMs: 2000 })
    })) as { ok: boolean }
    expect(waited.ok).toBe(true)

    // 面板上要能看到 agent 刚才做了什么
    await expect(page.getByText('Agent 正在操作')).toBeVisible()
    await expect(page.getByText('Agent 正在操作 · 等待 #go')).toBeVisible()

    const shot = (await app!.evaluate(async () => {
      const manager = (globalThis as never as { __codeletBrowser: { tool: (name: string, args: Record<string, unknown>) => Promise<unknown> } }).__codeletBrowser
      return manager.tool('screenshot', {})
    })) as { ok: boolean; mimeType?: string; data?: string }
    expect(shot.ok).toBe(true)
    expect(shot.mimeType).toBe('image/jpeg')
    expect((shot.data ?? '').length).toBeGreaterThan(1000)
  })

  test('浏览器页面只在右栏里：收起看不到，拖宽跟着变', async () => {
    const bounds = (): Promise<{
      x: number
      y: number
      width: number
      height: number
      visible: boolean
      windowWidth: number
    } | null> =>
      app!.evaluate(async ({ BrowserWindow }, target) => {
        for (const win of BrowserWindow.getAllWindows()) {
          for (const child of win.contentView.children) {
            const view = child as unknown as {
              webContents?: { getURL: () => string }
              getBounds: () => { x: number; y: number; width: number; height: number }
              getVisible: () => boolean
            }
            if (!view.webContents?.getURL().startsWith(target)) continue
            const [windowWidth] = win.getContentSize()
            return { ...view.getBounds(), visible: view.getVisible(), windowWidth }
          }
        }
        return null
      }, `http://127.0.0.1:${port}/`)

    await expect.poll(async () => (await bounds())?.visible).toBe(true)
    const before = await bounds()
    expect(before).toBeTruthy()
    // 原生视图整块落在右栏：不碰到左边界，也不出窗口
    expect(before!.x).toBeGreaterThan(0)
    expect(before!.x + before!.width).toBeLessThanOrEqual(before!.windowWidth)

    // 右栏拖宽 32px，原生视图跟着变宽
    const grip = page.getByRole('separator', { name: '调整右栏宽度' })
    await grip.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(async () => (await bounds())?.width).toBeGreaterThan(before!.width)

    // 切换器下拉盖在页面上：开着时原生视图收起，关掉再露出来
    await page.getByRole('button', { name: /切换功能区/ }).click()
    await expect.poll(async () => (await bounds())?.visible).toBe(false)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await bounds())?.visible).toBe(true)

    // 切到代码功能区 → 原生视图收起，不留在右栏底下；切回浏览器 → 又露出来
    await page.getByRole('button', { name: /切换功能区/ }).click()
    await page.getByRole('menuitemradio', { name: /代码/ }).click()
    await expect(page.getByRole('tab', { name: /改动/ })).toBeVisible()
    await expect.poll(async () => (await bounds())?.visible).toBe(false)
    await page.getByRole('button', { name: /切换功能区/ }).click()
    await page.getByRole('menuitemradio', { name: /浏览器/ }).click()
    await expect.poll(async () => (await bounds())?.visible).toBe(true)

    // 收起右栏 → 原生视图收起来；展开 → 又露出来
    await page.getByRole('button', { name: '收起右栏' }).click()
    await expect(page.locator('.right-panel')).toHaveCount(0)
    await expect.poll(async () => (await bounds())?.visible).toBe(false)
    await page.getByRole('button', { name: '右栏', exact: true }).click()
    await expect(page.getByLabel('浏览器地址')).toBeVisible()
    await expect.poll(async () => (await bounds())?.visible).toBe(true)
  })

  test('工具入口按宿主过滤：拿别的宿主的标签必须失败', async () => {
    const result = await app!.evaluate(async () => {
      const manager = (
        globalThis as unknown as {
          __codeletBrowser: {
            tool: (name: string, args: Record<string, unknown>, host: string) => Promise<unknown>
            getState: (host: string) => Promise<{ tabs: Array<{ id: string }> }>
          }
        }
      ).__codeletBrowser
      const projectBefore = (await manager.getState('project')).tabs
      const projectTabId = projectBefore[0]?.id
      if (!projectTabId) return { message: '没有项目标签', projectBefore: 0, projectAfter: 0, ghostBefore: 0, ghostAfter: 0 }

      // 另一个宿主自己也有一条标签 —— 失败不能是「它本来就没标签」
      await manager.tool('open', { url: 'about:blank' }, 'agent:ghost')
      const ghostBefore = (await manager.getState('agent:ghost')).tabs.length
      let message = ''
      try {
        await manager.tool('close', { tabId: projectTabId }, 'agent:ghost')
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      return {
        message,
        projectBefore: projectBefore.length,
        projectAfter: (await manager.getState('project')).tabs.length,
        ghostBefore,
        ghostAfter: (await manager.getState('agent:ghost')).tabs.length
      }
    })

    expect(result.message).toContain('标签不属于这个宿主')
    // 别人的标签没被关，自己的也没被误关
    expect(result.projectAfter).toBe(result.projectBefore)
    expect(result.ghostAfter).toBe(result.ghostBefore)
  })

  test('可以新建和关闭标签', async () => {
    const plus = page.getByRole('button', { name: '新建浏览器标签' })
    await plus.click()
    await expect(page.getByRole('button', { name: /新标签/ })).toBeVisible()
    const close = page.getByRole('button', { name: '关闭标签' }).last()
    await close.click()
    await expect(page.getByRole('button', { name: /新标签/ })).toHaveCount(0)
  })
})
