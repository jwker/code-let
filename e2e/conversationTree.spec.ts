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
 * 验的是整条链：对话区左上角的树入口与角标 → 弹窗里的树 → 切支线 → 回到这一轮 → 另开会话。
 * 另备两条只读会话：一条只有一轮、一条很长（验「零/一轮也有入口」「滚动不跟走」）。
 * 全程不需要真模型。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let sessionFile = ''
let oneTurnFile = ''
let longFile = ''
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

      // 只有一轮：验证入口跟轮次数无关
      const one = SessionManager.create(projectDir)
      one.appendMessage({ role: 'user', content: [{ type: 'text', text: '只有一轮的提问' }], timestamp: Date.now() } as never)
      one.appendMessage(assistantMessage('只有一轮的回答') as never)
      oneTurnFile = one.getSessionFile() ?? ''
      if (!oneTurnFile) throw new Error('一轮会话文件没有创建出来')

      // 很长：滚动之后入口不该跟着走
      const long = SessionManager.create(projectDir)
      for (let index = 1; index <= 12; index += 1) {
        long.appendMessage({
          role: 'user',
          content: [{ type: 'text', text: `长会话第 ${index} 轮提问：这一行用来把对话撑高` }],
          timestamp: Date.now() + index
        } as never)
        long.appendMessage(assistantMessage(`长会话第 ${index} 轮回答：也让内容再长一点。`) as never)
      }
      longFile = long.getSessionFile() ?? ''
      if (!longFile) throw new Error('长会话文件没有创建出来')
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
            },
            {
              id: 'agent-one',
              name: '一轮对话',
              type: 'general',
              instance: 1,
              cwd: projectDir,
              sessionPath: oneTurnFile,
              createdAt: now + 1,
              lastActiveAt: now + 1,
              archivedAt: null,
              turns: 1,
              previewUrl: null
            },
            {
              id: 'agent-long',
              name: '长会话',
              type: 'general',
              instance: 1,
              cwd: projectDir,
              sessionPath: longFile,
              createdAt: now + 2,
              lastActiveAt: now + 2,
              archivedAt: null,
              turns: 12,
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

  test('对话区左上角的入口带角标，弹窗里一条主干 + 一条别的支线', async () => {
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

  test('只有一轮时入口仍在，点开能看到那一轮', async () => {
    const rail = page.getByRole('navigation', { name: '项目导航' })
    await rail.getByRole('button', { name: '一轮对话' }).click()

    const button = page.getByRole('button', { name: /^对话结构/ })
    await expect(button).toBeVisible()
    await expect(button).toHaveAttribute('aria-label', '对话结构')
    // 上一个 agent 有别的支线，切过来之后角标不能跟着串过来
    await expect(page.locator('.conv-tree-entry-badge')).toHaveCount(0)

    await openTree()
    await expect(page.locator('.conv-tree-row')).toHaveCount(1)
    await expect(page.locator('.conv-tree-row').first()).toContainText('只有一轮的提问')
    await page.getByRole('button', { name: '关闭', exact: true }).click()

    await rail.getByRole('button', { name: '会话树' }).click()
    // 切回来还是原来那条支线，角标恢复
    await expect(page.locator('.conv-tree-entry-badge')).toHaveText('1')
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

  test('零轮会话也有入口，点开是现有空态', async () => {
    const rail = page.getByRole('navigation', { name: '项目导航' })
    await rail.getByRole('button', { name: '新建 agent' }).click()
    const dialog = page.getByRole('dialog', { name: '新建 agent' })
    await dialog.getByRole('textbox').fill('零轮对话')
    await dialog.getByRole('textbox').press('Enter')
    await expect(page.getByRole('button', { name: '零轮对话', exact: true })).toBeVisible()

    const button = page.getByRole('button', { name: /^对话结构/ })
    await expect(button).toBeVisible()
    await button.click()
    await expect(page.getByText('这个对话还没有说过话')).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()

    await rail.getByRole('button', { name: '会话树' }).click()
  })

  test('HTML 排版下入口仍在，也能点开', async () => {
    await page.getByRole('button', { name: '更多' }).click()
    await page.getByRole('menuitem', { name: '模式切换' }).click()
    await page.getByRole('menuitemradio', { name: 'HTML' }).click()

    // HTML 排版没有圆点轨，但入口还在
    await expect(page.locator('.conv-nav')).toHaveCount(0)
    const button = page.getByRole('button', { name: /^对话结构/ })
    await expect(button).toBeVisible()
    await button.click()
    await expect(page.getByRole('dialog', { name: '对话结构' })).toBeVisible()
    await page.getByRole('button', { name: '关闭', exact: true }).click()

    await page.getByRole('button', { name: '更多' }).click()
    await page.getByRole('menuitem', { name: '模式切换' }).click()
    await page.getByRole('menuitemradio', { name: '普通' }).click()
  })

  test('滚动到会话中段，入口不跟着滚走', async () => {
    await page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '长会话' }).click()
    const button = page.getByRole('button', { name: /^对话结构/ })
    await expect(button).toBeVisible()
    const before = await button.boundingBox()

    const scrolled = await page.locator('.conv-normal').evaluate((element) => {
      element.scrollTop = Math.round(element.scrollHeight / 2)
      return element.scrollTop
    })
    expect(scrolled).toBeGreaterThan(0)
    await expect(button).toBeVisible()
    const after = await button.boundingBox()
    expect(Math.round(after!.y)).toBe(Math.round(before!.y))

    await page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '会话树' }).click()
  })

  test('切到项目设置后入口消失', async () => {
    const rail = page.getByRole('navigation', { name: '项目导航' })
    await rail.getByRole('button', { name: '项目设置' }).click()
    await expect(page.getByRole('button', { name: /^对话结构/ })).toHaveCount(0)
    await rail.getByRole('button', { name: '会话树' }).click()
    await expect(page.getByRole('button', { name: /^对话结构/ })).toBeVisible()
  })
})
