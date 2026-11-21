// 手机视口下逐档检查：抽屉里的「设置」是否还在屏幕内、能否点中
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.env.CDP_PORT ?? '9222'
const BASE = `http://127.0.0.1:${PORT}`

const findPage = async () => {
  for (let i = 0; i < 60; i++) {
    const targets = await fetch(`${BASE}/json/list`).then((r) => r.json()).catch(() => [])
    const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8091'))
    if (page) return page
    await sleep(300)
  }
  throw new Error('找不到页面')
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('ws error'))
})

let id = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  const entry = msg.id ? pending.get(msg.id) : undefined
  if (!entry) return
  pending.delete(msg.id)
  msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
}
const send = (method, params = {}) => {
  const messageId = ++id
  ws.send(JSON.stringify({ id: messageId, method, params }))
  return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }))
}
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}
const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    const ready = await evaluate(
      `document.readyState === 'complete' && !!document.querySelector('textarea')`
    ).catch(() => false)
    if (ready) return
    await sleep(300)
  }
  throw new Error('页面没挂载')
}

await send('Runtime.enable')
await send('Page.enable')
// 模拟手机：390x844 @3x
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 3,
  mobile: true,
})

await waitReady()
await evaluate(`localStorage.clear(); localStorage.setItem('chat-demo:api-key', 'sk-dummy-mobile-test')`)

const results = []
for (const [key, label] of [
  ['small', '小 0.9'],
  ['standard', '标准 1.0'],
  ['large', '大 1.15'],
  ['xlarge', '特大 1.3'],
]) {
  await evaluate(`localStorage.setItem('chat-demo:font-size', '${key}')`)
  await send('Page.navigate', { url: 'http://127.0.0.1:8091/' })
  await sleep(1500)
  await waitReady()
  // 打开抽屉
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '打开边栏')?.click()`)
  await sleep(700)
  const check = await evaluate(`(() => {
    const drawerOpen = Boolean(document.querySelector('[class*=drawerMask], [class*=drawer-]'))
    // 手机上侧边栏只存在于抽屉里，所以页面里只有一个「设置」按钮
    const button = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '设置')
    if (!button) return { found: false, drawerOpen }
    const rect = button.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const hit = document.elementFromPoint(cx, cy)
    return {
      found: true,
      drawerOpen,
      rect: { top: Math.round(rect.top), bottom: Math.round(rect.bottom) },
      viewportHeight: window.innerHeight,
      inViewport: rect.top >= 0 && rect.bottom <= window.innerHeight + 1,
      clickable: Boolean(hit && (hit === button || button.contains(hit))),
      zoom: getComputedStyle(document.documentElement).zoom,
    }
  })()`)
  results.push({ label, ...check })
  // 关掉抽屉，准备下一轮
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '收起边栏')?.click()`)
  await sleep(300)
}

console.log(JSON.stringify(results, null, 2))
process.exit(0)
