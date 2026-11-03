import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 用户图片缩略图（D39）。
 *
 * 用 SessionManager 造一条带图片的用户消息；应用从会话文件读历史，
 * 主进程把原图换成缩略图，普通模式的用户气泡里应该出现 <img>。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
// 用仓库里真实的 PNG，避免 1×1 测试图在 nativeImage 里被当成空图
const PIXEL = readFileSync(join(repoRoot, 'build', 'icon.png')).toString('base64')

let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('用户消息图片', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-image-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-image-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-image-e2e-agent-'))
    mkdirSync(join(projectDir, 'src'))

    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const manager = SessionManager.create(projectDir)
      manager.appendMessage({
        role: 'user',
        content: [
          { type: 'text', text: '这张图是什么？' },
          { type: 'image', mimeType: 'image/png', data: PIXEL }
        ],
        timestamp: Date.now()
      })
      const sessionFile = manager.getSessionFile()
      if (!sessionFile) throw new Error('会话文件没有创建出来')
      writeFileSync(
        join(userDataDir, 'tabs.json'),
        JSON.stringify(
          {
            tabs: [{ id: 'tab-e2e-image', cwd: projectDir, path: sessionFile, title: '图片 E2E' }],
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
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('历史里的用户图片显示成缩略图', async () => {
    const image = page.getByAltText('用户上传的图片 1')
    await expect(image).toBeVisible({ timeout: 20_000 })
    await expect(image).toHaveAttribute('src', /^data:image\//)
    expect(await image.evaluate((element) => (element as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0)
  })
})
