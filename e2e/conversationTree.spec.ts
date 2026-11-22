import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionManager } from '@earendil-works/pi-coding-agent'

/**
 * 会话树（.scratch/conversation-tree/spec.md）。
 *
 * 会话文件里手写一个分叉：两轮共用前缀，第二轮下面多挂一个问法。
 * 验的是整条链：轨上的树形按钮与角标 → 弹窗里的树 → 切支线 → 回到这一轮 → 另开会话。
 * 全程不需要真模型。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let sessionFile = ''
let app: ElectronApplication | null = null
let page: Page

function assistantMessage(text: string): unknown {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'gpt-4o-mini',
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

test.describe.serial('会话树的读、切与另开', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-tree-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-tree-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-tree-e2e-agent-'))

    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir
    try {
      const manager = SessionManager.create(projectDir)
      const push = (text: string): string =>
        manager.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() } as never)
      const reply = (text: string): string =>
        manager.appendMessage(assistantMessage(text) as never)

      // 两轮共用的前缀
      push('第一轮的提问：看看解析器')
      const firstReply = reply('第一轮的回答：只看半角括号')

      /*
       * 先写走掉的那条支线，再回来写活动支线。
       * 会话文件的叶是「最后一条条目」—— 打开时 leafId 从它推出来，
       * 所以活动支线必须最后写，否则打开看到的叶在别人身上。
       */
      manager.branch(firstReply)
      push('换个思路：先把输入归一化')
      reply('另一种回答：加一层 normalize')

      manager.branch(firstReply)
      push('第二轮的提问：全角括号呢')
      reply('第二轮的回答：会落进 fallback')

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
              id: 'agent-tree',
              name: '会话树',
              type: 'general',
              instance: 1,
              cwd: projectDir,
              sessionPath: sessionFile,
              createdAt: now,
              lastActiveAt: now,
              archivedAt: null,
              turns: 2,
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
              id: 'tab-tree',
              cwd: projectDir,
              title: projectDir.split('/').pop(),
              pane: 'agent',
              activeAgentId: 'agent-tree'
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

  const entries = (): Promise<Array<{ role?: string; text: string }>> =>
    page.evaluate(async () => {
      const api = (window as unknown as {
        codelet: {
          getAgentEntries: (
            agentId: string
          ) => Promise<Array<{ kind: string; role?: string; text: string }>>
        }
      }).codelet
      const items = await api.getAgentEntries('agent-tree')
      return items.map((item) => ({ role: item.role, text: item.text }))
    })

  const openTree = async (): Promise<void> => {
    await page.getByRole('button', { name: /^对话结构/ }).click()
    await expect(page.getByRole('dialog', { name: '对话结构' })).toBeVisible()
  }

  test('轨上的按钮带角标，弹窗里一条主干 + 一条别的支线', async () => {
    await expect(
      page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '会话树' })
    ).toBeVisible({ timeout: 10_000 })
    const button = page.getByRole('button', { name: /^对话结构/ })
    // 树是懒加载的（拉一次 getAgentTree），跑全量时可能比默认 5s 慢
    await expect(button).toContainText('1', { timeout: 10_000 })

    await openTree()
    const rows = page.locator('.conv-tree-row')
    await expect(rows).toHaveCount(3)
    await expect(rows.nth(0)).toContainText('第一轮的提问：看看解析器')
    // 走掉的那条支线先写进文件，所以它排在前面；叶之后的延续按新支线编号
    await expect(rows.nth(1)).toContainText('换个思路：先把输入归一化')
    await expect(rows.nth(1)).toContainText('支线 2')
    await expect(rows.nth(2)).toContainText('第二轮的提问：全角括号呢')
    await expect(rows.nth(2)).toContainText('当前')

    // 主干一条、支线一条，都是折线
    const lines = await page.locator('.conv-tree-lines line, .conv-tree-lines path').count()
    expect(lines).toBe(2)

    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '对话结构' })).toHaveCount(0)
  })

  test('切到别的支线：内容流换成那条，弹窗关闭', async () => {
    await openTree()
    await page.locator('.conv-tree-row').nth(1).click()
    await expect(page.getByRole('button', { name: '切到这里' })).toBeVisible()
    await page.getByRole('button', { name: '切到这里' }).click()
    await expect(page.getByRole('dialog', { name: '对话结构' })).toHaveCount(0)

    await expect.poll(async () => (await entries()).length).toBe(4)
    const after = await entries()
    expect(after.map((item) => item.text).join('\n')).toContain('换个思路：先把输入归一化')
    expect(after.map((item) => item.text).join('\n')).not.toContain('第二轮的提问')
  })

  test('回到这一轮：提问原文回输入框，内容流截断到这一轮之前', async () => {
    await openTree()
    const rows = page.locator('.conv-tree-row')
    // 切过去之后活动支线是「换个思路」那一轮，它现在是当前叶
    await expect(rows.nth(1)).toContainText('换个思路：先把输入归一化')
    await rows.nth(1).click()
    await page.getByRole('button', { name: '回到这一轮' }).click()
    await expect(page.getByRole('dialog', { name: '对话结构' })).toHaveCount(0)
    await expect(page.locator('textarea').first()).toHaveValue('换个思路：先把输入归一化')
    await expect.poll(async () => (await entries()).length).toBe(2)
  })

  test('另开一个会话：窄轨里多一个 agent，原标签的内容流不变', async () => {
    const before = await page.evaluate(async () => {
      const api = (window as unknown as { codelet: { getSnapshot: () => Promise<{ agents: unknown[] }> } }).codelet
      return (await api.getSnapshot()).agents.length
    })

    await openTree()
    await page.locator('.conv-tree-row').nth(0).click()
    await page.getByRole('button', { name: '另开一个会话' }).click()

    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const api = (window as unknown as { codelet: { getSnapshot: () => Promise<{ agents: unknown[] }> } })
            .codelet
          return (await api.getSnapshot()).agents.length
        })
      )
      .toBe(before + 1)

    // 原标签的内容流没动
    await expect.poll(async () => (await entries()).length).toBe(2)
  })
})
