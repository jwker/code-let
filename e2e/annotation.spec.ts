import { expect, test } from '@playwright/test'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 原型标注的端到端用例（本功能的主接缝）。
 *
 * 悬停与点击必须是真的输入事件，走的是主进程：
 * `webContents.sendInputEvent()` 派发合成的 mouseMove / mouseDown / mouseUp，
 * 再 `executeJavaScript` 读回页面状态（悬停的是哪一块、哪些块带着角标）。
 * 渲染层的断言（工具栏、输入框里的引用）照常用 Playwright 直接写。
 *
 * 断言落在用户能看见的东西上：页面上的角标、输入框里的 chip、发出去的消息文本。
 */

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
let projectDir = ''
let userDataDir = ''
let app: ElectronApplication | null = null
let page: Page
let prototypeUrl = ''

/** 主进程测试钩子（`globalThis.__codeletBrowser`）里的标注状态 */
interface HookAnnotationState {
  enabled: boolean
  file: string | null
  blocks: Array<{ block: number; anchor: string | null; selector: string; text: string }>
}

interface PageAnnotationState {
  enabled: boolean
  hover: string | null
  badges: string[]
  numbers: boolean
}

test.describe.serial('原型标注', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-annotation-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-annotation-e2e-userdata-'))
    writeFileSync(
      join(projectDir, 'pricing.html'),
      `<!doctype html>
<html><head><meta charset="utf-8"><title>原型</title>
<style>
  body { margin: 0; font: 14px/1.6 -apple-system, sans-serif; }
  .m-nav { height: 64px; background: #eef0f2; padding: 14px; box-sizing: border-box; }
  .m-pricing { display: flex; gap: 16px; padding: 16px; }
  .m-card { flex: 1; border: 1px solid #ccc; border-radius: 8px; padding: 16px; }
  .m-card.pro { border-color: #356a9a; }
  #buy { padding: 6px 14px; }
  .m-filler { height: 1600px; background: #fafbfc; }
  .m-foot { padding: 18px; background: #eef0f2; }
</style></head>
<body>
  <div class="m-nav" data-block="1">顶部导航 产品 定价 文档</div>
  <div class="m-pricing">
    <div class="m-card" data-block="3"><div>基础版</div><div>¥0 / 月</div><div>3 个项目</div></div>
    <div class="m-card pro" data-block="4">
      <div>专业版</div><div>¥68 / 月</div><div>无限项目 并行 agent 优先支持</div>
      <button id="buy">升级</button>
    </div>
  </div>
  <div class="m-quote" data-temp="T1">客户评价（没有锚点，这一轮不参与登记）</div>
  <div class="m-filler"></div>
  <div class="m-foot" data-block="5">页脚 © 2026 隐私 条款</div>
  <script>
    window.clicks = 0
    document.getElementById('buy').addEventListener('click', function () {
      window.clicks += 1
      document.getElementById('buy').setAttribute('data-clicked', 'yes')
    })
  </script>
</body></html>
`
    )
    prototypeUrl = pathToFileURL(join(projectDir, 'pricing.html')).toString()

    const now = Date.now()
    const agent = (over: Record<string, unknown>) => ({
      id: 'agent-a',
      name: '通用 1',
      type: 'general',
      instance: 1,
      cwd: projectDir,
      sessionPath: null,
      createdAt: now,
      lastActiveAt: now,
      archivedAt: null,
      turns: 0,
      ...over
    })
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
            agent({ id: 'agent-a', name: '通用 1' }),
            agent({ id: 'agent-p', name: '产品 1', type: 'product' })
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
              activeAgentId: 'agent-a'
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

  /** 找到原型页面那个 webContents 的 id */
  async function contentId(): Promise<number> {
    const id = await app!.evaluate(({ webContents }, needle) => {
      const found = webContents.getAllWebContents().find((item) => item.getURL().includes(needle))
      return found ? found.id : 0
    }, 'pricing.html')
    if (!id) throw new Error('没找到原型页面')
    return id
  }

  /** 在原型页面里执行一段脚本并读回结果 */
  async function evalPage<T>(script: string): Promise<T> {
    const id = await contentId()
    return (await app!.evaluate(async ({ webContents }, args) => {
      const contents = webContents.fromId(args.id)
      if (!contents) throw new Error('原型页面没了')
      return contents.executeJavaScript(args.script)
    }, { id, script })) as T
  }

  /** 页面里某一块的中心点（视图坐标 = CSS 像素） */
  async function blockCenter(block: number): Promise<{ x: number; y: number }> {
    return evalPage<{ x: number; y: number }>(
      `(() => { const el = document.querySelector('[data-block="${block}"]'); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
    )
  }

  /** 派发真的输入事件：悬停，或者一次完整点击 */
  async function mouseAt(x: number, y: number, click: boolean): Promise<void> {
    const id = await contentId()
    await app!.evaluate(({ webContents }, args) => {
      const contents = webContents.fromId(args.id)
      if (!contents) throw new Error('原型页面没了')
      const point = { x: Math.round(args.x), y: Math.round(args.y) }
      contents.sendInputEvent({ type: 'mouseMove', ...point })
      if (!args.click) return
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    }, { id, x, y, click })
  }

  /** 在原型页面里敲一个键（真的输入事件） */
  async function pressKey(keyCode: string): Promise<void> {
    const id = await contentId()
    await app!.evaluate(({ webContents }, args) => {
      const contents = webContents.fromId(args.id)
      if (!contents) throw new Error('原型页面没了')
      contents.sendInputEvent({ type: 'keyDown', keyCode: args.keyCode })
      contents.sendInputEvent({ type: 'keyUp', keyCode: args.keyCode })
    }, { id, keyCode })
  }

  /** 把鼠标移到页面空白处，清掉悬停候选（不然它会顶掉那一块的常驻角标） */
  async function clearHover(): Promise<void> {
    const point = await evalPage<{ x: number; y: number }>(
      `(() => { const r = document.querySelector('.m-filler').getBoundingClientRect(); return { x: r.left + 30, y: r.top + 40 } })()`
    )
    await mouseAt(point.x, point.y, false)
  }

  /** 页面上真的画着几个常驻角标 */
  function badgeCount(): Promise<number> {
    return evalPage<number>(
      `document.querySelectorAll('#codelet-annotation-layer .codelet-annotation-badge:not(.hover)').length`
    )
  }

  function hookState(): Promise<HookAnnotationState> {
    return app!.evaluate(
      (_electron, host) =>
        (
          globalThis as unknown as {
            __codeletBrowser: { annotationState: (host: string) => HookAnnotationState }
          }
        ).__codeletBrowser.annotationState(host),
      'agent:agent-p'
    ) as Promise<HookAnnotationState>
  }

  function pageState(): Promise<PageAnnotationState> {
    return evalPage<PageAnnotationState>(
      'window.__codeletAnnotation ? window.__codeletAnnotation.state() : null'
    )
  }

  /** 打开产品 agent 的预览并导航到原型页面 */
  async function openPrototype(): Promise<void> {
    await page
      .getByRole('navigation', { name: '项目导航' })
      .getByRole('button', { name: '产品 1' })
      .click()
    const addressBar = page.getByLabel('浏览器地址')
    await addressBar.fill(prototypeUrl)
    await addressBar.press('Enter')
    await expect(page.getByRole('button', { name: /原型/ })).toBeVisible({ timeout: 10_000 })
  }

  test('预览有标注开关，块登记只读 data-block', async () => {
    await openPrototype()

    await expect(page.getByRole('button', { name: '标注' })).toBeVisible()
    // 工具栏上写的是相对项目根的文件路径 —— 也是引用载荷里「文件」那一行
    await expect(page.getByText('pricing.html').first()).toBeVisible()

    const state = await hookState()
    expect(state.file).toBe('pricing.html')
    expect(state.blocks.map((block) => block.block)).toEqual([1, 3, 4, 5])
    // 没有锚点的块这一轮不登记（临时号是下一票的事）
    expect(state.blocks.every((block) => block.anchor?.startsWith('data-block='))).toBe(true)
    expect(state.blocks.find((block) => block.block === 4)?.selector).toContain('.m-card')
    expect(state.blocks.find((block) => block.block === 4)?.text).toContain('专业版')
  })

  test('悬停出现描边，点一下角标常驻、输入框出现 #4', async () => {
    await page.getByRole('button', { name: '标注' }).click()
    await expect(page.getByText(/标注模式 · 点击选块/)).toBeVisible()

    // 悬停：页面里记下「鼠标压着的是哪一块」
    const third = await blockCenter(3)
    await mouseAt(third.x, third.y, false)
    await expect.poll(async () => (await pageState()).hover).toBe('3')

    // 点击：角标常驻，输入框落下一个引用
    const pro = await blockCenter(4)
    await mouseAt(pro.x, pro.y, true)
    await expect(page.getByLabel('移除引用「#4」')).toBeVisible()
    await expect.poll(async () => (await pageState()).badges).toContain('4')

    // 重复点同一块不新增引用
    await mouseAt(pro.x, pro.y, true)
    await expect(page.locator('[aria-label="移除引用「#4」"]')).toHaveCount(1)

    // 标注模式下，点在原型自己的按钮上也不触发原型的行为
    const buy = await evalPage<{ x: number; y: number }>(
      `(() => { const r = document.getElementById('buy').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
    )
    await mouseAt(buy.x, buy.y, true)
    await expect.poll(() => evalPage<number>('window.clicks')).toBe(0)
  })

  test('发送带引用的消息时，载荷附在消息末尾', async () => {
    const composer = page.locator('textarea').first()
    await composer.fill('把 #4 的按钮换成实心')
    await composer.press('Enter')

    const lastPrompt = (): Promise<string | null> =>
      app!.evaluate(
        () =>
          (globalThis as unknown as { __codeletLastPrompt?: { text: string } }).__codeletLastPrompt
            ?.text ?? null
      )

    // 没有真模型可发；主进程在交给 Pi 之前记下了这一条消息的正文（测试钩子）
    await expect.poll(lastPrompt).toContain('[引用] 原型块')
    const text = (await lastPrompt()) ?? ''
    expect(text.startsWith('把 #4 的按钮换成实心\n\n---\n[引用] 原型块\n')).toBe(true)
    expect(text).toContain('文件    pricing.html')
    expect(text).toContain('块号    4')
    expect(text).toContain('锚点    data-block="4"')
    expect(text).toContain('选择器  ')
    expect(text).toContain('文字    专业版 ¥68 / 月')
    // 不带源码片段
    expect(text).not.toContain('<div')
    expect(text).not.toContain('</')
  })

  test('关掉标注后点击还给原型，不会选中任何块', async () => {
    await page.getByRole('button', { name: '标注' }).click()
    await expect(page.getByText(/标注模式 · 点击选块/)).toHaveCount(0)
    await expect.poll(async () => (await pageState()).enabled).toBe(false)

    const buy = await evalPage<{ x: number; y: number }>(
      `(() => { const r = document.getElementById('buy').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`
    )
    await mouseAt(buy.x, buy.y, true)
    await expect.poll(() => evalPage<number>('window.clicks')).toBe(1)

    // 角标还留着（关掉标注模式不撤号），也没有新引用
    await expect.poll(async () => (await pageState()).badges).toEqual(['4'])
    await expect.poll(badgeCount).toBe(1)
    await expect(page.locator('[aria-label="移除引用「#4」"]')).toHaveCount(1)

    // 再打开，然后在页面里按 Esc 退出 —— 不用回去点工具栏
    await page.getByRole('button', { name: '标注' }).click()
    await expect(page.getByText(/标注模式 · 点击选块/)).toBeVisible()
    await pressKey('Escape')
    await expect(page.getByText(/标注模式 · 点击选块/)).toHaveCount(0)
    await expect.poll(async () => (await pageState()).enabled).toBe(false)
  })

  test('编号能整体隐藏角标，「清单」列出标过的块并能滚过去', async () => {
    await page.getByRole('button', { name: '标注' }).click()
    await expect(page.getByText(/标注模式 · 点击选块/)).toBeVisible()
    await clearHover()
    await expect.poll(badgeCount).toBe(1)

    // 关掉编号：角标全隐，引用还在（号不丢）
    await page.getByRole('button', { name: '编号' }).click()
    await expect.poll(badgeCount).toBe(0)
    await expect.poll(async () => (await pageState()).numbers).toBe(false)
    await expect(page.locator('[aria-label="移除引用「#4」"]')).toHaveCount(1)

    // 再打开：全部回来
    await page.getByRole('button', { name: '编号' }).click()
    await expect.poll(badgeCount).toBe(1)
    await expect.poll(async () => (await pageState()).numbers).toBe(true)

    // 滚到底部，把页脚也标上
    await evalPage('window.scrollTo(0, document.documentElement.scrollHeight)')
    const foot = await blockCenter(5)
    await mouseAt(foot.x, foot.y, true)
    await expect(page.getByLabel('移除引用「#5」')).toBeVisible()
    await clearHover()
    await expect.poll(badgeCount).toBe(2)

    // 清单：块号 + 文字摘要，点一条滚到那一块
    await page.getByRole('button', { name: '清单' }).click()
    const list = page.getByLabel('标注清单')
    await expect(list).toBeVisible()
    await expect(list.getByRole('button')).toHaveCount(2)
    await expect(list).toContainText('#4')
    await expect(list).toContainText('专业版')
    await expect(list).toContainText('#5')
    await expect(list).toContainText('页脚')

    await evalPage('window.scrollTo(0, 0)')
    await expect.poll(() => evalPage<number>('window.scrollY')).toBe(0)
    await list.getByRole('button').filter({ hasText: '#5' }).click()
    await expect.poll(() => evalPage<number>('window.scrollY')).toBeGreaterThan(500)

    // 删掉 #5 的引用：角标和清单里那一条一起消失
    await page.getByLabel('移除引用「#5」').click()
    await expect(list.getByRole('button')).toHaveCount(1)
    await expect.poll(badgeCount).toBe(1)
  })

  test('项目级浏览器的页面点不出标注', async () => {
    const projectState = await app!.evaluate(
      async (_electron, host) => {
        const manager = (
          globalThis as unknown as {
            __codeletBrowser: {
              annotationState: (host: string) => HookAnnotationState
              setAnnotation: (host: string, enabled: boolean) => Promise<HookAnnotationState>
            }
          }
        ).__codeletBrowser
        const opened = await manager.setAnnotation(host, true)
        return { state: manager.annotationState(host), enabled: opened.enabled }
      },
      'project'
    )
    expect(projectState.enabled).toBe(false)
    expect(projectState.state.blocks).toEqual([])

    await page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '浏览器', exact: true }).click()
    await expect(page.getByRole('button', { name: '标注' })).toHaveCount(0)
  })
})
