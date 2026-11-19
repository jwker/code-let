import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 没有可恢复的地址时，从项目的原型目录里挑（票 03）。
 *
 * 四次启动串成一条链：第一次列目录并挑一个 → 第二次直接恢复它 →
 * 把那个文件删掉之后第三次回到列表 → 挑另一个再恢复。最后一次把目录清空，
 * 看「目录存在但没有页面」这句空态。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let prototypeDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

function prototypeUrl(name: string): string {
  return pathToFileURL(join(prototypeDir, name)).toString()
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
  await expect(page.getByRole('navigation', { name: '项目导航' })).toBeVisible({ timeout: 20_000 })
}

async function close(): Promise<void> {
  await app?.close()
  app = null
}

/** 原型页面的正文；页面还没打开时是空串（给 expect.poll 留重试的余地） */
async function previewText(): Promise<string> {
  const id = await app!.evaluate(({ webContents }) => {
    const found = webContents
      .getAllWebContents()
      .find((item) => item.getURL().includes('.codelet/prototype/'))
    return found ? found.id : 0
  })
  if (!id) return ''
  return (await app!.evaluate(async ({ webContents }, args) => {
    const contents = webContents.fromId(args.id)
    if (!contents) return ''
    return contents.executeJavaScript(args.script)
  }, { id, script: 'document.body.innerText' })) as string
}

/** 列表里列出的文件名（按显示顺序） */
async function listedFiles(): Promise<string[]> {
  const texts = await page
    .getByLabel('原型文件')
    .getByRole('button')
    .filter({ hasText: '.html' })
    .allTextContents()
  // 按钮里的文本是「<> + 文件名 + 修改时间」拼起来的，取出文件名
  return texts.map((text) => /([^\s<>]+\.html?)/i.exec(text)?.[1] ?? text.trim())
}

function readPreviewUrl(): string | null {
  const raw = JSON.parse(readFileSync(join(userDataDir, 'agents.json'), 'utf8')) as {
    agents: Array<{ id: string; previewUrl?: string | null }>
  }
  return raw.agents.find((agent) => agent.id === 'agent-p')?.previewUrl ?? null
}

test.describe.serial('原型预览：从目录里挑', () => {
  test.beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-picker-e2e-project-'))
    prototypeDir = join(projectDir, '.codelet', 'prototype')
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-picker-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-picker-e2e-agent-'))

    mkdirSync(prototypeDir, { recursive: true })
    writeFileSync(join(prototypeDir, 'older.html'), '<!doctype html><title>older</title><p>OLDER</p>')
    writeFileSync(join(prototypeDir, 'newer.html'), '<!doctype html><title>newer</title><p>NEWER</p>')
    writeFileSync(join(prototypeDir, 'notes.txt'), '不是原型')
    // 修改时间拉开，列表顺序才是确定的
    utimesSync(join(prototypeDir, 'older.html'), new Date(1_000), new Date(1_000))
    utimesSync(join(prototypeDir, 'newer.html'), new Date(2_000), new Date(2_000))

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
              sessionPath: null,
              createdAt: now,
              lastActiveAt: now,
              archivedAt: null,
              turns: 0,
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
  })

  test.afterAll(async () => {
    await close()
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('没有可恢复的地址：列出目录里的原型，点一个打开并记下来', async () => {
    await launch()

    await expect(page.getByLabel('原型文件')).toBeVisible({ timeout: 10_000 })
    // 只有 .html：txt 不列；新的在前
    expect(await listedFiles()).toEqual(['newer.html', 'older.html'])
    await expect(page.getByLabel('原型文件')).not.toContainText('notes.txt')

    await page.getByLabel('原型文件').getByRole('button', { name: /newer\.html/ }).click()
    await expect.poll(previewText).toContain('NEWER')
    await expect(page.getByLabel('原型文件')).toHaveCount(0)
    expect(readPreviewUrl()).toBe(prototypeUrl('newer.html'))

    await close()
  })

  test('重开：恢复上次挑的那个，不再列目录', async () => {
    await launch()

    await expect.poll(previewText).toContain('NEWER')
    await expect(page.getByLabel('原型文件')).toHaveCount(0)

    await close()
  })

  test('记录的文件被删掉：回到列表，挑另一个', async () => {
    unlinkSync(join(prototypeDir, 'newer.html'))
    await launch()

    await expect(page.getByLabel('原型文件')).toBeVisible({ timeout: 10_000 })
    expect(await listedFiles()).toEqual(['older.html'])

    await page.getByLabel('原型文件').getByRole('button', { name: /older\.html/ }).click()
    await expect.poll(previewText).toContain('OLDER')
    expect(readPreviewUrl()).toBe(prototypeUrl('older.html'))

    await close()
  })

  test('再次重开：恢复新挑的那个', async () => {
    await launch()
    await expect.poll(previewText).toContain('OLDER')
    await expect(page.getByLabel('原型文件')).toHaveCount(0)
    await close()
  })

  test('目录存在但没有页面：空态说清是「还没有文件」', async () => {
    unlinkSync(join(prototypeDir, 'older.html'))
    unlinkSync(join(prototypeDir, 'notes.txt'))
    await launch()

    await expect(page.getByText('原型目录里还没有页面')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(prototypeDir)).toBeVisible()
    await expect(page.getByRole('button', { name: '重新查找' })).toBeVisible()
  })
})
