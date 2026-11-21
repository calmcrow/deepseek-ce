// 必须排在其它 import 之前：老 WebView 缺的 API 要在任何模块执行前补上
import './app/compat.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupPreferences } from './app/preferences.js'
import { setupTheme } from './app/theme.js'
import { ErrorBoundary } from './components/base/ErrorBoundary.js'
import { ensureKatex } from './services/markdown/katex.js'
import { setupAutoRead } from './services/speech/autoRead.js'
import './app/theme.css'
import './app/global.css'

ensureKatex()
setupPreferences()
setupTheme()
setupAutoRead()

createRoot(document.getElementById('root') as HTMLElement).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)

// 告诉安卓壳子「页面真的跑起来了」，原生那边据此收起「正在加载 / 没能启动」的状态层。
// 浏览器里没有这个桥，可选调用即可。
;(
  window as unknown as { AndroidBridge?: { notifyReady?: () => void } }
).AndroidBridge?.notifyReady?.()
