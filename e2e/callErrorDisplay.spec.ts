import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 调用失败与轮次失败分开显示。
 *
 * 用测试钩子把合成的会话事件送进宿主：一轮中途失败一次、随后成功；
 * 另一轮只有失败（最后一次调用 error）。断言：
 * - 自愈的一轮只有灰字与摘要里的次数，没有红框和建议；
 * - 真失败的一轮红框在答案位置，措辞与原始错误、建议都在；
 * - 中止的一轮既不灰也不红，只留「已中止」。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let app: ElectronApplication | null = null
let page: Page
let agentId = ''

test.describe.serial('调用失败与轮次失败', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-callerror-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-callerror-e2e-userdata-'))
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
    agentId = await page.evaluate(async () => {
      const snapshot = await (
        window as unknown as { codelet: { getSnapshot: () => Promise<{ activeAgentId: string | null }> } }
      ).codelet.getSnapshot()
      if (!snapshot.activeAgentId) throw new Error('没有活动 agent')
      return snapshot.activeAgentId
    })
  })

  test.afterAll(async () => {
    await app?.close()
    app = null
    for (const dir of [projectDir, userDataDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  function emit(event: { type: string; data: unknown }): Promise<void> {
    return app!.evaluate(
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
  }

  const user = (text: string): Promise<void> =>
    emit({ type: 'message_start', data: { message: { role: 'user', content: [{ type: 'text', text }] } } })

  const fail = async (errorMessage: string, stopReason = 'error'): Promise<void> => {
    await emit({ type: 'message_start', data: { message: { role: 'assistant', content: [] } } })
    await emit({
      type: 'message_end',
      data: { message: { role: 'assistant', content: [], errorMessage, stopReason } }
    })
  }

  const say = async (text: string): Promise<void> => {
    await emit({ type: 'message_start', data: { message: { role: 'assistant', content: [] } } })
    await emit({ type: 'message_update', data: { type: 'text_delta', delta: text } })
  }

  test('中途失败后成功：只有灰字与次数，没有红框与建议', async () => {
    await emit({ type: 'agent_start', data: {} })
    await user('先回答一个问题')
    await fail('429 Too Many Requests: retry later')
    await say('好了，这一轮最终还是完成了。')
    await emit({ type: 'agent_settled', data: {} })

    await expect(page.getByText('好了，这一轮最终还是完成了。')).toBeVisible()
    // 摘要行告诉用户这一轮失败过几次
    const process = page.getByRole('button', { name: /^过程/ }).first()
    await expect(process).toContainText('1 次调用失败')
    // 红框与建议都不该出现
    await expect(page.getByText('检查模型额度或凭据后重试')).toHaveCount(0)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 展开过程 → 灰字 → 点开才看原始错误
    await process.click()
    const line = page.getByRole('button', { name: /调用失败，已继续/ })
    await expect(line).toBeVisible()
    await expect(page.getByText('429 Too Many Requests: retry later')).toHaveCount(0)
    await line.click()
    await expect(page.getByText('429 Too Many Requests: retry later')).toBeVisible()
  })

  test('只有失败：红框在答案位置，带失败类型、原始错误与建议', async () => {
    await emit({ type: 'agent_start', data: {} })
    await user('再问一次')
    await fail('401 Unauthorized: invalid api key')
    await emit({ type: 'agent_settled', data: {} })

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('模型鉴权失败')
    await expect(alert).toContainText('401 Unauthorized: invalid api key')
    await expect(alert).toContainText('检查模型额度或凭据后重试')
    // 失败轮次不再显示灰字（上一条自愈的灰字还在，恰好一条）
    await expect(page.getByRole('button', { name: /调用失败，已继续/ })).toHaveCount(1)
  })

  test('中止优先：即使带着错误文本，也只显示已中止', async () => {
    await emit({ type: 'agent_start', data: {} })
    await user('这一轮我要停掉')
    await say('说到一半')
    await fail('aborted by user', 'aborted')
    await emit({ type: 'agent_settled', data: {} })

    await expect(page.getByText('已中止')).toBeVisible()
    // 没有新增红框，也没有新增灰字
    await expect(page.getByRole('alert')).toHaveCount(1)
    await expect(page.getByRole('button', { name: /调用失败，已继续/ })).toHaveCount(1)
  })
})
