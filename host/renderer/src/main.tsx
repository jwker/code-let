import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ConsoleApp } from './shell/ConsoleApp'
import { SettingsApp } from './shell/SettingsApp'
import './styles/global.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在')

/**
 * 设置窗口和控制台的独立窗口都复用同一个渲染页面，靠查询参数区分。
 *
 * 主窗口是 `index.html`，设置窗口是 `index.html?window=settings`，
 * 控制台窗口是 `index.html?window=console`。
 * 这样只有一份构建产物，preload 也只有一份。
 */
const mode = new URLSearchParams(window.location.search).get('window')

createRoot(container).render(
  <StrictMode>
    {mode === 'settings' ? <SettingsApp /> : mode === 'console' ? <ConsoleApp /> : <App />}
  </StrictMode>
)
