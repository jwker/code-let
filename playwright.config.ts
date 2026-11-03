import { defineConfig } from '@playwright/test'

/**
 * Electron 端到端测试（PLAN.md D35）。
 *
 * 不启动浏览器：每个 spec 自己用 `_electron.launch()` 打开真实应用。
 * 所以 `test:e2e` 先构建，再让 Playwright 跑 `e2e` 目录下的 spec。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  // Electron 窗口占真实 userData / 单实例锁，串行跑最稳
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure'
  }
})
