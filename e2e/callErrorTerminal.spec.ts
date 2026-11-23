import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 终端排版下的调用失败与轮次失败。
 *
 * 同一份判定（callErrors）按轮切分：自愈的一轮在失败发生的位置画一行灰字，
 * 未自愈的一轮在轮末用红字。只造这两轮，避免历史内容干扰断言。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let app: ElectronApplication | null = null
let page: Page

test.describe.serial('终端排版的错误行', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-terminal-error-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-terminal-error-userdata-'))
    writeFileSync(
      join(userDataDir, 'projects.json'),
      JSON.stringify({ projects: [projectDir] }, null, 2)
    )
    app = await electron.launch({
      args: ['.'],
      cwd: repoRoot,
      env: { ...process.env, CODELET_USER_DATA: userDataDir },
      timeout: 30_000
    })
    page = await app.firstWindow()
    await expect(page.locator('textarea').first()).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  test('自愈一行灰字、未自愈红字收在轮末', async () => {
    const agentId = await page.evaluate(async () => {
      const snapshot = await (
        window as unknown as { codelet: { getSnapshot: () => Promise<{ activeAgentId: string | null }> } }
      ).codelet.getSnapshot()
      if (!snapshot.activeAgentId) throw new Error('没有活动 agent')
      return snapshot.activeAgentId
    })
    const emit = (event: { type: string; data: unknown }): Promise<void> =>
      app!.evaluate(
        async (_electron, args) =>
          (
            globalThis as unknown as {
              __codeletSessionEvent: (event: {
                type: string
                data: unknown
                agentId: string
              }) => void
            }
          ).__codeletSessionEvent({ ...args.event, agentId: args.agentId }),
        { event, agentId }
      )
    const user = (text: string): Promise<void> =>
      emit({ type: 'message_start', data: { message: { role: 'user', content: [{ type: 'text', text }] } } })
    const fail = async (errorMessage: string): Promise<void> => {
      await emit({ type: 'message_start', data: { message: { role: 'assistant', content: [] } } })
      await emit({
        type: 'message_end',
        data: { message: { role: 'assistant', content: [], errorMessage, stopReason: 'error' } }
      })
    }
    const say = async (text: string): Promise<void> => {
      await emit({ type: 'message_start', data: { message: { role: 'assistant', content: [] } } })
      await emit({ type: 'message_update', data: { type: 'text_delta', delta: text } })
    }

    // 切到终端排版
    await page.getByRole('button', { name: '更多' }).click()
    await page.getByRole('menuitem', { name: '模式切换' }).click()
    await page.getByRole('menuitemradio', { name: '终端' }).click()
    await expect(page.locator('.conv-terminal')).toBeVisible()

    // 第一轮：中途失败后成功
    await emit({ type: 'agent_start', data: {} })
    await user('终端里先问一句')
    await fail('429 Too Many Requests')
    await say('重新试之后好了。')
    await emit({ type: 'agent_settled', data: {} })

    // 第二轮：只有失败
    await emit({ type: 'agent_start', data: {} })
    await user('终端里再问一句')
    await fail('401 Unauthorized: invalid api key')
    await emit({ type: 'agent_settled', data: {} })

    // 自愈的一行灰字
    await expect(page.getByText('✗ 调用失败 · 已继续', { exact: true })).toBeVisible()
    // 只有一次（不会为同一次失败画两行）
    await expect(page.getByText('✗ 调用失败 · 已继续', { exact: true })).toHaveCount(1)

    // 失败的一轮：红字收在轮末，带类型、原始错误与建议
    const alert = page.getByRole('alert')
    await expect(alert).toHaveCount(1)
    await expect(alert).toContainText('模型鉴权失败')
    await expect(alert).toContainText('401 Unauthorized: invalid api key')
    await expect(alert).toContainText('检查模型额度或凭据后重试')
  })
})
