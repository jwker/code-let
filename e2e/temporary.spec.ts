import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 临时对话窗口（D40）：打开、最小化恢复、确认关闭、重开为空。 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let agentDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('临时对话', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-temp-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-temp-e2e-userdata-'))
    agentDir = mkdtempSync(join(tmpdir(), 'codelet-temp-e2e-agent-'))
    mkdirSync(join(projectDir, 'src'))
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
        // 发送只记账、不调模型 —— 用来验临时对话的输入历史
        CODELET_ECHO_PROMPT: '1'
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

  test('打开、Esc 不关闭、最小化可恢复', async () => {
    const composer = page.locator('textarea').first()
    await composer.fill('/ask')
    await page.getByRole('option').filter({ hasText: '/ask' }).first().click()

    const dialog = page.getByRole('dialog', { name: '临时对话' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    const input = dialog.getByPlaceholder('问点什么…')
    await expect(input).toBeFocused()

    // 临时窗口里不挂 / 和 @
    await input.fill('/')
    await expect(page.getByRole('listbox')).toHaveCount(0)
    await input.fill('@')
    await expect(page.getByRole('listbox')).toHaveCount(0)

    // Esc 不关闭
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()

    // 最小化只收起浮层
    await dialog.getByRole('button', { name: '最小化' }).click()
    await expect(dialog).toHaveCount(0)
    const pill = page.getByRole('button', { name: '恢复临时对话' })
    await expect(pill).toBeVisible()
    await pill.click()
    await expect(dialog).toBeVisible()

    // /ask 也能恢复最小化的同一会话
    await dialog.getByRole('button', { name: '最小化' }).click()
    await composer.fill('/ask')
    await page.getByRole('option').filter({ hasText: '/ask' }).first().click()
    await expect(dialog).toBeVisible()
  })

  test('只有 X 打开确认；取消、Esc 都保留，确认后才清除', async () => {
    const dialog = page.getByRole('dialog', { name: '临时对话' })
    await dialog.getByRole('button', { name: '关闭临时对话' }).click()

    const confirm = page.getByRole('alertdialog', { name: '彻底关闭临时对话' })
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '取消' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(dialog).toBeVisible()

    // 确认框里的 Esc 只取消确认
    await dialog.getByRole('button', { name: '关闭临时对话' }).click()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(dialog).toBeVisible()

    // 确认后才真正关闭
    await dialog.getByRole('button', { name: '关闭临时对话' }).click()
    await confirm.getByRole('button', { name: '彻底关闭' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: '恢复临时对话' })).toHaveCount(0)
  })

  test('彻底关闭后再次 /ask 是空会话', async () => {
    const composer = page.locator('textarea').first()
    await composer.fill('/ask')
    await page.getByRole('option').filter({ hasText: '/ask' }).first().click()

    const dialog = page.getByRole('dialog', { name: '临时对话' })
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByPlaceholder('问点什么…')).toHaveValue('')
    await expect(dialog.locator('.conv-stream')).toHaveCount(0)
  })

  /** 把一条用户消息送进临时会话的内容流（echo 不写会话文件） */
  async function pushTemporaryMessage(tempId: string, text: string): Promise<void> {
    const seenBefore = await page.getByText(text, { exact: true }).count()
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
          agentId: args.tempId,
          data: { message: { role: 'user', content: [{ type: 'text', text: args.text }] } }
        })
      },
      { tempId, text }
    )
    await expect(page.getByText(text, { exact: true })).toHaveCount(seenBefore + 1)
  }

  test('临时对话里发一句，按上箭头能回填', async () => {
    const dialog = page.getByRole('dialog', { name: '临时对话' })
    const input = dialog.getByPlaceholder('问点什么…')

    // 先给 agent 那边放一句，证明临时对话翻不到它的历史
    const agentId = await page.evaluate(async () => {
      const snapshot = await (
        window as unknown as {
          codelet: { getSnapshot: () => Promise<{ activeAgentId: string | null }> }
        }
      ).codelet.getSnapshot()
      if (!snapshot.activeAgentId) throw new Error('没有活动 agent')
      return snapshot.activeAgentId
    })
    await pushTemporaryMessage(agentId, 'agent 那边的话')

    await input.fill('临时第一句')
    await input.press('Enter')
    await expect(input).toHaveValue('')

    const tempId = await page.evaluate(async () => {
      const snapshot = await (
        window as unknown as {
          codelet: { getSnapshot: () => Promise<{ temporaryChat: { id: string } | null }> }
        }
      ).codelet.getSnapshot()
      if (!snapshot.temporaryChat) throw new Error('临时对话不见了')
      return snapshot.temporaryChat.id
    })
    await pushTemporaryMessage(tempId, '临时第一句')

    await input.press('ArrowUp')
    await expect(input).toHaveValue('临时第一句')
    // 再往上还是这条（临时会话里只有一句），不会翻出 agent 那边的消息
    await input.press('ArrowUp')
    await expect(input).toHaveValue('临时第一句')
    await input.press('ArrowDown')
    await expect(input).toHaveValue('')

    // 彻底关闭再打开：新会话历史为空，按上箭头不会翻出上一段
    await dialog.getByRole('button', { name: '关闭临时对话' }).click()
    await page.getByRole('alertdialog', { name: '彻底关闭临时对话' }).getByRole('button', { name: '彻底关闭' }).click()
    await expect(dialog).toHaveCount(0)

    const composer = page.locator('textarea').first()
    await composer.fill('/ask')
    await page.getByRole('option').filter({ hasText: '/ask' }).first().click()
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    const fresh = dialog.getByPlaceholder('问点什么…')
    await fresh.press('ArrowUp')
    await expect(fresh).toHaveValue('')
  })
})
