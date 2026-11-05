import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * Dock 菜单（只在 macOS 上有）。
 *
 * 右键点 Dock 图标，菜单里列出当前打开的窗口，点一个就切过去。
 * 列表里的名字就是窗口自己的标题 —— 所以窗口标题要设对（见 index.ts / consoleIpc.ts）。
 *
 * 为什么自己搭这个菜单：默认的 Dock 菜单不保证列出窗口，
 * 而「从 Dock 直接跳到某个窗口」正是这个应用需要的（主窗口、设置、控制台三个窗口）。
 */
export function refreshDockMenu(): void {
  if (process.platform !== 'darwin') return
  const dock = app.dock
  if (!dock) return

  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed())
  const template: MenuItemConstructorOptions[] = []

  for (const win of windows) {
    template.push({
      label: win.getTitle(),
      click: () => {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
  }
  if (template.length > 0) template.push({ type: 'separator' })

  template.push(
    {
      label: '显示全部窗口',
      click: () => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue
          if (win.isMinimized()) win.restore()
          win.show()
        }
      }
    },
    { role: 'hide', label: '隐藏' },
    { role: 'hideOthers', label: '隐藏其他' },
    { role: 'unhide', label: '显示所有' },
    { type: 'separator' },
    { role: 'quit', label: '退出' }
  )

  dock.setMenu(Menu.buildFromTemplate(template))
}
