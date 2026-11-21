// 验证安卓壳子的原生保存通道：移动端抽屉 → 设置 → 数据管理 → 导出聊天记录
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'

const PORT = process.env.CDP_PORT ?? '9333'
const BASE = `http://127.0.0.1:${PORT}`
const OUT = process.env.OUT_DIR ?? 'tools'

const log = (label, value) =>
  console.log(`\n### ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

const targets = await fetch(`${BASE}/json/list`).then((r) => r.json())
const page = targets.find((t) => t.url.includes('appassets.androidplatform.net'))
if (!page) {
  console.log('没有找到 WebView 目标')
  process.exit(1)
}

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
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(`${OUT}/${name}`, Buffer.from(data, 'base64'))
}

await send('Runtime.enable')
await send('Page.enable')

// 1) 先确认原生桥接对象在页面里可见
log('AndroidBridge 方法', await evaluate(`(() => {
  const bridge = window.AndroidBridge
  if (!bridge) return 'missing'
  return ['beginFile', 'appendFileChunk', 'endFile'].filter((name) => typeof bridge[name] === 'function')
})()`))

// 2) 打开移动端抽屉
log('点开抽屉', await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /sidebar/i.test(b.getAttribute('aria-label') ?? ''))
  if (!button) return { ok: false, labels: [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean) }
  button.click()
  return { ok: true }
})()`))
await sleep(1200)

// 3) 抽屉里的「Settings」
log('点设置', await evaluate(`(() => {
  const entry = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Settings')
  if (!entry) return { ok: false, buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }
  entry.click()
  return { ok: true }
})()`))
await sleep(1200)
await shot('emu-08-drawer-settings.png')

// 4) 数据管理分组 + 点导出
log('切到数据管理', await evaluate(`(() => {
  const tab = [...document.querySelectorAll('[role=tab]')].find((b) => /Data/i.test(b.innerText))
  if (!tab) return { ok: false }
  tab.click()
  return { ok: true }
})()`))
await sleep(1000)

const clicked = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /Download/i.test(b.innerText) && b.offsetParent !== null)
  if (!button) return { ok: false, buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }
  if (button.disabled) return { ok: false, reason: 'button disabled（没有会话可导出）' }
  button.click()
  return { ok: true }
})()`)
log('点导出', clicked)

await sleep(2500)
log('导出后页面文本', await evaluate(`document.body.innerText.slice(0, 700)`))
await shot('emu-09-export-result.png')

console.log('\nDONE')
process.exit(0)
