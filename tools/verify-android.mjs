// 通过 WebView 远程调试（debug 包）验证 APK 内的真实行为：
// 设置 Key → 发消息看请求结果 → 导出聊天记录看原生保存通道
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'

const PORT = process.env.CDP_PORT ?? '9333'
const BASE = `http://127.0.0.1:${PORT}`
const OUT = process.env.OUT_DIR ?? 'tools'
const APP_URL = 'https://appassets.androidplatform.net/assets/www/index.html'

const log = (label, value) =>
  console.log(`\n### ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

const findTarget = async () => {
  for (let i = 0; i < 60; i++) {
    const targets = await fetch(`${BASE}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    const page = targets.find((t) => t.url.includes('appassets.androidplatform.net'))
    if (page) return page
    await sleep(500)
  }
  return null
}

const page = await findTarget()
if (!page) {
  console.log('没有找到 WebView 调试目标')
  process.exit(1)
}
console.log('target:', page.url)

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

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('textarea')`).catch(() => false)) return true
    await sleep(300)
  }
  throw new Error('app 没挂载起来')
}

await send('Runtime.enable')
await send('Page.enable')

// 1) 写入假 Key + Pro 模型 + 自定义系统提示词，然后整页导航
await evaluate(`(() => {
  localStorage.setItem('chat-demo:api-key', 'sk-dummy-smoke-test')
  localStorage.setItem('chat-demo:model', 'deepseek-v4-pro')
  localStorage.setItem('chat-demo:system-prompt', '安卓壳子冒烟测试')
  return 'seeded'
})()`)
await send('Page.navigate', { url: APP_URL })
await sleep(3000)
await waitReady()
log('页面已就绪', await evaluate(`document.body.innerText.slice(0, 300)`))

// 2) 发一条消息（假 Key，预期拿到官方 401 文案，说明请求真的出去了）
const typed = await evaluate(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, 'hello from android')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return ta.value
})()`)
log('已发送', typed)
await sleep(10000)
await shot('emu-05-cdp-chat.png')
log('发送后页面文本', await evaluate(`document.body.innerText.slice(0, 800)`))

// 3) 打开设置 → 数据管理 → 点下载（导出聊天记录），验证原生保存通道
const nav = await evaluate(`(() => {
  const entry = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Settings')
  if (entry) entry.click()
  return Boolean(entry)
})()`)
await sleep(1200)
const dataTab = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('[role=tab]')].find((b) => /Data/i.test(b.innerText))
  if (tab) tab.click()
  return Boolean(tab)
})()`)
await sleep(1000)
log('打开设置/数据管理', { nav, dataTab })
await shot('emu-06-cdp-settings.png')

const exportClicked = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /Download/.test(b.innerText) && b.offsetParent)
  if (!button) return { ok: false, buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean) }
  if (button.disabled) return { ok: false, reason: 'disabled' }
  button.click()
  return { ok: true }
})()`)
log('点击导出', exportClicked)
await sleep(4000)
log('导出后页面文本', await evaluate(`document.body.innerText.slice(0, 600)`))
await shot('emu-07-cdp-export.png')

console.log('\nDONE')
process.exit(0)
