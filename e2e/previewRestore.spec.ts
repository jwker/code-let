import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 产品 agent 的预览在重启后自己回来（票 01）。
 *
 * 这个用例必须真的重启：同一个 userData 启动两次应用。第一次打开本地原型，
 * 第二次不点任何东西，预览应该已经在原来的文件上，块登记也重建了。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let prototypeUrl = ''
let app: ElectronApplication | null = null
let page: Page

interface SeedAgent {
  id: string
  name: string
  type: 'product'
  instance: number
  cwd: string
  sessionPath: null
  createdAt: number
  lastActiveAt: number
  archivedAt: null
  turns: number
  previewUrl: string | null
}

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
  await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
}

/** 原型页面那个 webContents 里执行脚本 */
async function evalPreviewPage<T>(script: string): Promise<T> {
  const id = await app!.evaluate(({ webContents }) => {
    const found = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('prototype.html'))
    return found ? found.id : 0
  })
  if (!id) throw new Error('还没打开原型页面')
  return (await app!.evaluate(async ({ webContents }, args) => {
    const contents = webContents.fromId(args.id)
    if (!contents) throw new Error('原型页面没了')
    return contents.executeJavaScript(args.script)
  }, { id, script })) as T
}

/** 某个产品 agent 的块清单 */
function blocksOf(agentId: string): Promise<Array<{ block: number | null }>> {
  return app!.evaluate(
    async (_electron, id) => {
      const manager = (
        globalThis as unknown as {
          __codeletBrowser: {
            tool: (name: string, args: Record<string, unknown>, host: string) => Promise<unknown>
          }
        }
      ).__codeletBrowser
      const answer = (await manager.tool('blocks', {}, `agent:${id}`)) as {
        blocks: Array<{ block: number | null }>
      }
      return answer.blocks
    },
    agentId
  ) as Promise<Array<{ block: number | null }>>
}

function readAgents(): SeedAgent[] {
  const raw = JSON.parse(readFileSync(join(userDataDir, 'agents.json'), 'utf8')) as {
    agents: SeedAgent[]
  }
  return raw.agents
}

test.describe.serial('原型预览的恢复', () => {
  test.beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-restore-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-restore-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-restore-e2e-agent-'))

    writeFileSync(
      join(projectDir, 'prototype.html'),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>原型</title></head>
<body>
  <div class="m-nav" data-block="1">顶部导航 产品 定价</div>
  <div class="m-card" data-block="2">专业版 ¥68 / 月</div>
</body></html>
`
    )
    prototypeUrl = pathToFileURL(join(projectDir, 'prototype.html')).toString()

    const now = Date.now()
    const agent = (id: string, name: string, instance: number): SeedAgent => ({
      id,
      name,
      type: 'product',
      instance,
      cwd: projectDir,
      sessionPath: null,
      createdAt: now,
      lastActiveAt: now,
      archivedAt: null,
      turns: 0,
      previewUrl: null
    })
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )
    writeFileSync(
      join(userDataDir, 'agents.json'),
      JSON.stringify(
        { version: 1, agents: [agent('agent-p1', '产品 1', 1), agent('agent-p2', '产品 2', 2)] },
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
              activeAgentId: 'agent-p1'
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

  test('第一次启动：打开本地原型，地址被记下来', async () => {
    await launch()

    // 还没有任何记录 —— 预览是空态
    await expect(page.getByText('这个项目还没有原型')).toBeVisible({ timeout: 10_000 })

    const addressBar = page.getByLabel('浏览器地址')
    await addressBar.fill(prototypeUrl)
    await addressBar.press('Enter')
    await expect(page.getByRole('button', { name: /原型/ })).toBeVisible({ timeout: 10_000 })

    await expect.poll(async () => (await blocksOf('agent-p1')).map((item) => item.block)).toEqual([1, 2])
    await expect.poll(() => evalPreviewPage<string>('document.body.innerText')).toContain('专业版')

    const agents = readAgents()
    expect(agents.find((item) => item.id === 'agent-p1')?.previewUrl).toBe(prototypeUrl)
    expect(agents.find((item) => item.id === 'agent-p2')?.previewUrl).toBeNull()

    await app?.close()
    app = null
  })

  test('第二次启动：预览自己回来，块登记重建，别的宿主不受影响', async () => {
    await launch()

    // 没点任何东西，预览已经在原来的文件上
    await expect(page.getByRole('button', { name: /原型/ })).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => evalPreviewPage<string>('document.body.innerText')).toContain('专业版')
    await expect(page.getByText('这个项目还没有原型')).toHaveCount(0)
    await expect.poll(async () => (await blocksOf('agent-p1')).map((item) => item.block)).toEqual([1, 2])

    // 产品 agent 的系统提示里带着原型目录与 data-block 的要求
    const systemPrompt = await app!.evaluate(
      (_electron, agentId) =>
        (
          globalThis as unknown as { __codeletSystemPrompt: (id: string) => string | null }
        ).__codeletSystemPrompt(agentId),
      'agent-p1'
    )
    expect(systemPrompt).toContain(join(projectDir, '.codelet/prototype'))
    expect(systemPrompt).toContain('data-block')

    // runtime 建起来了 —— 扩展照常加载
    const extensionErrors = await page.evaluate(async () =>
      (
        window as unknown as {
          codelet: { getSnapshot: () => Promise<{ extensionErrors: unknown[] }> }
        }
      ).codelet
        .getSnapshot()
        .then((snapshot) => snapshot.extensionErrors)
    )
    expect(extensionErrors).toEqual([])

    // 项目级浏览器不会被恢复成这个原型
    const projectTabs = await app!.evaluate(
      async (_electron, host) => {
        const manager = (
          globalThis as unknown as {
            __codeletBrowser: {
              getState: (host: string) => Promise<{ tabs: Array<{ url: string }> }>
            }
          }
        ).__codeletBrowser
        return (await manager.getState(host)).tabs.map((tab) => tab.url)
      },
      'project'
    )
    expect(projectTabs.every((url) => url === 'about:blank')).toBe(true)

    // 另一个产品 agent 没有记录 —— 空态，不会串到它
    await page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '产品 2' }).click()
    await expect(page.getByText('这个项目还没有原型')).toBeVisible({ timeout: 10_000 })
    const other = await app!.evaluate(async () => {
      const manager = (
        globalThis as unknown as {
          __codeletBrowser: { annotationState: (host: string) => { file: string | null; blocks: unknown[] } }
        }
      ).__codeletBrowser
      return manager.annotationState('agent:agent-p2')
    })
    expect(other.file).toBeNull()
    expect(other.blocks).toEqual([])
  })
})
