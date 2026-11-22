import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 输入历史的端到端（GLOSSARY「输入历史」）。
 *
 * `CODELET_ECHO_PROMPT` 让主进程只记账、不调模型 —— 发送路径照常走完
 * （清空输入框、复位指针）。发出去的那条消息用 `__codeletSessionEvent`
 * 合成一条 `message_start` 送进内容流，等价于真实会话里已经落盘的用户消息。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('输入历史', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-history-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-history-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-history-e2e-agent-'))
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )

    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: {
        ...process.env,
        CODELET_USER_DATA: userDataDir,
        PI_CODING_AGENT_DIR: agentDir,
        CODELET_ECHO_PROMPT: '1'
      },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await expect(page.locator('textarea')).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir, agentDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  const composer = (): ReturnType<Page['locator']> => page.locator('textarea')

  async function activeAgentId(): Promise<string> {
    return page.evaluate(async () => {
      const snapshot = await (
        window as unknown as { codelet: { getSnapshot: () => Promise<{ activeAgentId: string | null }> } }
      ).codelet.getSnapshot()
      if (!snapshot.activeAgentId) throw new Error('没有活动 agent')
      return snapshot.activeAgentId
    })
  }

  /** 发一句：走真实的发送路径（echo 不调模型），再把用户消息送进内容流 */
  async function send(text: string): Promise<void> {
    await composer().fill(text)
    await composer().press('Enter')
    await expect(composer()).toHaveValue('')

    const seenBefore = await page.getByText(text, { exact: true }).count()
    const agentId = await activeAgentId()
    await app!.evaluate(
      async (_electron, args) => {
        const push = (
          globalThis as unknown as {
            __codeletSessionEvent: (event: {
              type: string
              data: unknown
              agentId: string
            }) => void
          }
        ).__codeletSessionEvent
        push({
          type: 'message_start',
          agentId: args.agentId,
          data: {
            message: { role: 'user', content: [{ type: 'text', text: args.text }] }
          }
        })
      },
      { agentId, text }
    )
    // 内容流里多出一条这条用户消息 = 它进了输入历史（重复文本要用条数判断）
    await expect(page.getByText(text, { exact: true })).toHaveCount(seenBefore + 1)
  }

  test('上箭头回填、翻到尽头停住、下箭头回到草稿', async () => {
    await send('第一句')
    await send('第二句')

    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第二句')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第一句')
    // 到最老一条停住，不循环、不跳回最新
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第一句')

    await composer().press('ArrowDown')
    await expect(composer()).toHaveValue('第二句')
    // 越过最新一条：还原翻阅之前的草稿（这里是空）
    await composer().press('ArrowDown')
    await expect(composer()).toHaveValue('')

    // 有草稿时翻出去再翻回来
    await composer().fill('写了一半的话')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第二句')
    await composer().press('ArrowDown')
    await expect(composer()).toHaveValue('写了一半的话')
  })

  test('在历史条目上编辑，改过的版本留在草稿槽', async () => {
    await composer().fill('')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第二句')

    // 在历史条目末尾补两个字
    await composer().press('End')
    await page.keyboard.type('改')
    await expect(composer()).toHaveValue('第二句改')

    // 继续往上翻：历史条目还是原文，改过的版本留在草稿槽
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第一句')
    await composer().press('ArrowDown')
    await expect(composer()).toHaveValue('第二句')
    await composer().press('ArrowDown')
    await expect(composer()).toHaveValue('第二句改')
  })

  test('Shift+上箭头不翻历史；多行光标向上也不翻', async () => {
    await composer().fill('选中的文本')
    await composer().press('Shift+ArrowUp')
    await expect(composer()).toHaveValue('选中的文本')

    // 光标在第二行 —— 上箭头只是移动光标
    await composer().fill('第一行\n第二行')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第一行\n第二行')
  })

  test('Esc 复位指针，下一下上箭头从最新一条开始', async () => {
    await composer().fill('')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第二句')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第一句')

    await composer().press('Escape')
    // 复位不清理输入框里的文本
    await expect(composer()).toHaveValue('第一句')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第二句')
  })

  test('重复的相同消息不去重', async () => {
    await send('继续')
    await send('继续')

    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('继续')
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('继续')
    // 两条「继续」都走过了，才轮到上一条不同的
    await composer().press('ArrowUp')
    await expect(composer()).toHaveValue('第二句')
  })
})
