import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 上下文 Diff 右侧栏（D41）：从持久化索引恢复摘要并打开详情。 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('上下文 Diff', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-ctx-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-ctx-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-ctx-e2e-agent-'))
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
        content: [{ type: 'text', text: '上一次请求' }],
        timestamp: Date.now()
      })
      manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: '这次新增的用户消息' }],
        timestamp: Date.now() + 1
      })
      const sessionFile = manager.getSessionFile()
      if (!sessionFile) throw new Error('会话文件没有创建出来')
      const sessionId = manager.getSessionId()
      writeFileSync(
        join(userDataDir, 'tabs.json'),
        JSON.stringify(
          {
            tabs: [{ id: 'tab-e2e-context', cwd: projectDir, path: sessionFile, title: '上下文 E2E' }],
            files: [],
            activeFileId: null
          },
          null,
          2
        )
      )

      const indexDir = join(userDataDir, 'context-diff')
      mkdirSync(indexDir, { recursive: true })
      const indexFile = join(indexDir, `${encodeURIComponent(sessionId)}.jsonl`)
      const digest = (role: string, text: string): string =>
        createHash('sha256').update(`${role}\u0000${text}`).digest('hex').slice(0, 24)
      const base = {
        sessionId,
        sessionPath: sessionFile,
        sessionName: '上下文 E2E',
        toolsHash: 'tools',
        capturedAt: Date.now(),
        messages: [
          { key: 's', role: 'system', hash: 'sys', tokens: 2, preview: 'system prompt' },
          {
            key: 'u1',
            role: 'user',
            hash: digest('user', '上一次请求'),
            tokens: 3,
            preview: '上一次请求'
          },
          {
            key: 'a1',
            role: 'assistant',
            hash: digest('assistant', '上一次回答'),
            tokens: 4,
            preview: '上一次回答'
          }
        ]
      }
      const current = {
        ...base,
        id: `${sessionId}:2`,
        turn: 2,
        request: 2,
        totalTokens: 12,
        capturedAt: Date.now() + 1,
        messages: [
          ...base.messages,
          {
            key: 'u2',
            role: 'user',
            hash: digest('user', '这次新增的用户消息'),
            tokens: 3,
            preview: '新增消息预览'
          }
        ]
      }
      writeFileSync(
        indexFile,
        `${JSON.stringify({ ...base, id: `${sessionId}:1`, turn: 1, request: 1, totalTokens: 9 })}\n${JSON.stringify(current)}\n`,
        'utf8'
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
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('从持久化索引显示摘要，并能打开消息详情', async () => {
    await page.getByRole('button', { name: '上下文', exact: true }).click()
    const pane = page.locator('.insp-body')
    await expect(pane.getByText('上下文变化')).toBeVisible()
    await expect(pane.getByText('新增消息预览')).toBeVisible()
    await expect(pane.getByText('最近两次请求')).toBeVisible()

    await pane.getByRole('button', { name: /USER/ }).first().click()
    const detail = page.getByRole('dialog', { name: '上下文消息详情' })
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('这次新增的用户消息')
    await page.getByRole('button', { name: '关闭详情' }).click()
  })

  test('基线可以切换，选中后回到摘要', async () => {
    const pane = page.locator('.insp-body')
    await pane.getByRole('button', { name: '切换' }).click()
    await expect(pane.getByText('选择基线')).toBeVisible()
    await pane.getByRole('button', { name: /第一次/ }).click()
    await expect(pane.getByText('自定义基线')).toBeVisible()
    await expect(pane.getByText('最近两次请求')).toHaveCount(0)
  })
})
