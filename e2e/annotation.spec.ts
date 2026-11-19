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

/**
 * 测试用的原型页面。
 *
 * `quoteBlock` 是评价块上的锚点：空串 = 没有锚点（要点出来一个临时号），
 * 给个数字 = 模拟 agent 给它补上了 `data-block`（转正）。
 */
function prototypeHtml(quoteBlock = ''): string {
  return `<!doctype html>
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
  .m-quote { padding: 18px; background: #fff7e6; }
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
  <div class="m-quote"${quoteBlock ? ` data-block="${quoteBlock}"` : ''}>客户评价 以前这件事要开三个窗口</div>
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
}

test.describe.serial('原型标注', () => {
  test.beforeAll(async () => {
    projectDir = mkdtempSync(join(tmpdir(), 'codelet-annotation-e2e-project-'))
    userDataDir = mkdtempSync(join(tmpdir(), 'codelet-annotation-e2e-userdata-'))
    writeFileSync(join(projectDir, 'pricing.html'), prototypeHtml())
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
      /*
       * CODELET_ECHO_PROMPT：主进程记下发出去的消息就返回，不调模型。
       * 标注的用例只关心「发出去的是什么」，不该为此请求真实 provider。
       */
      env: { ...process.env, CODELET_USER_DATA: userDataDir, CODELET_ECHO_PROMPT: '1' },
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

  /**
   * 找到**产品 agent 预览**那个 webContents 的 id。
   *
   * 项目浏览器可能也开着同一个文件（地址带 `?project=1`），要把它排除掉。
   */
  async function contentId(): Promise<number> {
    const id = await app!.evaluate(({ webContents }, needle) => {
      const found = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes(needle) && !item.getURL().includes('project=1'))
      return found ? found.id : 0
    }, 'pricing.html')
    if (!id) throw new Error('没找到原型页面')
    return id
  }

  /** 在项目级浏览器的那个页面里执行脚本 */
  async function evalProjectPage<T>(script: string): Promise<T> {
    const id = await app!.evaluate(({ webContents }) => {
      const found = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes('project=1'))
      return found ? found.id : 0
    })
    if (!id) throw new Error('没找到项目浏览器的页面')
    return (await app!.evaluate(async ({ webContents }, args) => {
      const contents = webContents.fromId(args.id)
      if (!contents) throw new Error('项目浏览器的页面没了')
      return contents.executeJavaScript(args.script)
    }, { id, script })) as T
  }

  /**
   * 把一轮合成事件送进宿主（测试钩子）。
   *
   * 真模型在测试里跑不了，但「一轮开始 / 结束」这条路径要和真事件走同一条。
   */
  async function emitSession(type: 'agent_start' | 'agent_settled'): Promise<void> {
    await app!.evaluate(
      async (_electron, args) => {
        const push = (
          globalThis as unknown as {
            __codeletSessionEvent: (event: { type: string; data: unknown; agentId: string }) => void
          }
        ).__codeletSessionEvent
        push({ type: args.type, data: {}, agentId: 'agent-p' })
      },
      { type }
    )
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
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

  /** 某个选择器里的一个安全点（大块只取靠上的位置，保证在视野里） */
  async function pointIn(selector: string): Promise<{ x: number; y: number }> {
    return evalPage<{ x: number; y: number }>(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + Math.min(40, r.height / 2) } })()`
    )
  }

  /**
   * 主进程在交给 Pi 之前记下的最后一条消息正文。
   *
   * 没有真模型可发 —— 这个钩子（`host/main/ipc.ts`）让用例能断言「发出去的是什么」。
   */
  function lastPrompt(): Promise<string | null> {
    return app!.evaluate(
      () =>
        (globalThis as unknown as { __codeletLastPrompt?: { text: string } }).__codeletLastPrompt
          ?.text ?? null
    )
  }

  /** 在输入框里写一句、回车发送，等主进程收到 */
  async function sendMessage(text: string): Promise<void> {
    const composer = page.locator('textarea').first()
    await composer.fill(text)
    await composer.press('Enter')
    await expect.poll(lastPrompt).toContain(text)
  }

  /** 页面上画着的常驻角标都写着什么 */
  function badgeTexts(): Promise<string[]> {
    return evalPage<string[]>(
      `Array.from(document.querySelectorAll('#codelet-annotation-layer .codelet-annotation-badge:not(.hover)')).map((node) => node.textContent)`
    )
  }

  /** 其中用警示色画的那几个（临时号） */
  function tempBadgeTexts(): Promise<string[]> {
    return evalPage<string[]>(
      `Array.from(document.querySelectorAll('#codelet-annotation-layer .codelet-annotation-badge.temp:not(.hover)')).map((node) => node.textContent)`
    )
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
    await sendMessage('把 #4 的按钮换成实心')
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

  test('没有锚点的块拿临时号，补上锚点后转正', async () => {
    // 回到产品 agent 的预览；标注模式还开着（主进程记着）
    await page.getByRole('navigation', { name: '项目导航' }).getByRole('button', { name: '产品 1' }).click()
    await expect(page.getByRole('button', { name: /原型/ })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/标注模式 · 点击选块/)).toBeVisible()
    await evalPage('window.scrollTo(0, 0)')

    // 点没有 data-block 的评价块 → T1，chip 与角标都是警示色
    const quote = await pointIn('.m-quote')
    await mouseAt(quote.x, quote.y, true)
    const t1Chip = page.getByLabel('移除引用「#T1」')
    await expect(t1Chip).toBeVisible()
    await expect(t1Chip.locator('..')).toHaveClass(/text-warn/)
    await expect.poll(badgeTexts).toEqual(['4', 'T1'])
    await expect.poll(tempBadgeTexts).toEqual(['T1'])

    // 再点另一个没有锚点的块 → T2，不重号
    const filler = await pointIn('.m-filler')
    await mouseAt(filler.x, filler.y, true)
    await expect(page.getByLabel('移除引用「#T2」')).toBeVisible()
    await expect(page.getByLabel('移除引用「#T1」')).toHaveCount(1)
    await expect(page.getByLabel('移除引用「#T3」')).toHaveCount(0)

    // 重复点 T1 那一块：不多一个引用，也不再分配号
    await mouseAt(quote.x, quote.y, true)
    await expect(page.getByLabel('移除引用「#T1」')).toHaveCount(1)
    await expect(page.getByLabel('移除引用「#T3」')).toHaveCount(0)

    // 发送：临时号那一段写明「无锚点」，不出现锚点行、也不编块号
    await sendMessage('把评价那段改大一号')
    const tempPayload = (await lastPrompt()) ?? ''
    const sections = tempPayload.split('\n\n')
    const t1Section = sections.find((part) => part.includes('临时号')) ?? ''
    expect(t1Section).toContain('临时号  T1（无锚点，凭文字和选择器找）')
    expect(t1Section).not.toContain('锚点    ')
    expect(t1Section).not.toContain('块号    ')
    expect(sections.some((part) => part.includes('块号    4'))).toBe(true)
    expect(tempPayload).toContain('临时号  T2（无锚点，凭文字和选择器找）')

    // agent 给那一块补上 data-block，页面重建块登记 → 同一个选择器转正
    writeFileSync(join(projectDir, 'pricing.html'), prototypeHtml('7'))
    await app!.evaluate(({ webContents }) => {
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.getURL().includes('pricing.html'))
      contents?.reload()
    })
    await expect.poll(async () => (await hookState()).blocks.map((block) => block.block)).toEqual([1, 3, 4, 7, 5])

    // 角标换成正式块号；输入框里已经写下的 #T1 不改写
    await expect.poll(badgeTexts).toEqual(['4', '7', 'T2'])
    await expect.poll(tempBadgeTexts).toEqual(['T2'])
    await expect(page.getByLabel('移除引用「#T1」')).toBeVisible()
    expect((await hookState()).blocks.find((block) => block.block === 7)?.selector).toContain('m-quote')

    // 清单里点 #T1 也能滚到那一块 —— 转正之后按块号找
    await page.getByRole('button', { name: '清单' }).click()
    await evalPage('window.scrollTo(0, document.documentElement.scrollHeight)')
    await expect.poll(() => evalPage<number>('window.scrollY')).toBeGreaterThan(500)
    await page.getByLabel('标注清单').getByRole('button').filter({ hasText: '#T1' }).click()
    await expect.poll(() => evalPage<number>('window.scrollY')).toBeLessThan(500)

    // 发送时按最新登记解析：T1 那段变成块号 7 与锚点，T2 仍是临时号
    await sendMessage('评价那块再窄一点')
    const promoted = (await lastPrompt()) ?? ''
    const promotedSection = promoted.split('\n\n').find((part) => part.includes('块号    7')) ?? ''
    expect(promotedSection).toContain('锚点    data-block="7"')
    expect(promotedSection).toContain('选择器  ')
    expect(promotedSection).not.toContain('临时号')
    expect(promoted).toContain('临时号  T2（无锚点，凭文字和选择器找）')
  })

  test('一轮结束时，动过原型文件就自动刷新预览', async () => {
    await expect.poll(badgeTexts).toEqual(['4', '7', 'T2'])

    // —— 改过文件：轮结束自动刷新，角标按块号回来 ——
    await emitSession('agent_start')
    // 等「一轮开始」那边把时间戳拍完（真实场景里中间隔着整轮的工具调用）
    await wait(150)
    writeFileSync(
      join(projectDir, 'pricing.html'),
      prototypeHtml('7').replace('顶部导航 产品 定价 文档', '顶部导航 产品 定价 文档 改过了')
    )
    await emitSession('agent_settled')

    // 没点刷新按钮，页面自己换了内容
    await expect.poll(() => evalPage<string>('document.body.innerText')).toContain('改过了')
    await expect.poll(badgeTexts).toEqual(['4', '7', 'T2'])
    await expect
      .poll(async () => (await hookState()).blocks.map((block) => block.block))
      .toEqual([1, 3, 4, 7, 5])

    // —— 没动过：不刷新，滚动位置留住 ——
    await evalPage('window.scrollTo(0, 400)')
    await expect.poll(() => evalPage<number>('window.scrollY')).toBeGreaterThan(300)
    await evalPage('window.__noReload = "yes"')
    await emitSession('agent_start')
    await wait(150)
    await emitSession('agent_settled')
    await wait(500)
    expect(await evalPage<string>('window.__noReload ?? ""')).toBe('yes')
    expect(await evalPage<number>('window.scrollY')).toBeGreaterThan(300)

    // —— 项目级浏览器的同一个页面不受影响 ——
    await app!.evaluate(async (_electron, url) => {
      const manager = (
        globalThis as unknown as {
          __codeletBrowser: {
            tool: (name: string, args: Record<string, unknown>, host: string) => Promise<unknown>
          }
        }
      ).__codeletBrowser
      await manager.tool('navigate', { url }, 'project')
    }, `${prototypeUrl}?project=1`)
    await expect.poll(() => evalProjectPage<string>('document.body.innerText')).toContain('改过了')
    await evalProjectPage('window.__projectMarker = "yes"')

    await emitSession('agent_start')
    await wait(150)
    writeFileSync(
      join(projectDir, 'pricing.html'),
      prototypeHtml('7').replace('顶部导航 产品 定价 文档', '顶部导航 产品 定价 文档 又改了一次')
    )
    await emitSession('agent_settled')

    await expect.poll(() => evalPage<string>('document.body.innerText')).toContain('又改了一次')
    expect(await evalProjectPage<string>('window.__projectMarker ?? ""')).toBe('yes')
    expect(await evalProjectPage<string>('document.body.innerText')).toContain('改过了')
  })
})
