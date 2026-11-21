// 验证「刷新模型列表」：把 /models 打桩成含新模型的响应，看列表是否真的追加进来
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'

const PORT = process.env.CDP_PORT ?? '9222'
const BASE = `http://127.0.0.1:${PORT}`
const OUT = process.env.OUT_DIR ?? 'tools'
const log = (label, value) =>
  console.log(`\n### ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

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
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(`${OUT}/${name}`, Buffer.from(data, 'base64'))
}
const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('textarea')`).catch(() => false)) return
    await sleep(300)
  }
  throw new Error('页面没挂载')
}

await send('Runtime.enable')
await send('Page.enable')
await waitReady()

// 1) 写入假 Key 并重载（跳过首次设置流程）
await evaluate(`localStorage.setItem('chat-demo:api-key', 'sk-dummy-model-test')`)
await send('Page.navigate', { url: 'http://127.0.0.1:8091/' })
await sleep(2500)
await waitReady()

// 2) 打开设置 → 通用设置
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '设置')?.click()`)
await sleep(900)
await evaluate(
  `[...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.includes('通用设置'))?.click()`
)
await sleep(900)
log('刷新前的模型选项', await evaluate(`(() => {
  const row = [...document.querySelectorAll('[aria-haspopup=listbox]')]
  return row.map((b) => b.innerText.trim())
})()`))

// 3) 把 /models 打桩成含一个「新模型」的响应
log('打桩 fetch', await evaluate(`(() => {
  if (!window.__origFetch) window.__origFetch = window.fetch
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/models')) {
      const body = {
        object: 'list',
        data: [
          { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4.1-Flash' },
          { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V4-Pro' },
          { id: 'deepseek-v5-preview', object: 'model', owned_by: 'deepseek', name: 'DeepSeek-V5-Preview' }
        ]
      }
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      }))
    }
    return window.__origFetch(input, init)
  }
  return 'stubbed'
})()`))

// 4) 点刷新按钮
log('点刷新', await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') ?? b.innerText).trim() === '刷新模型列表')
  if (!btn) return { ok: false, labels: [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean) }
  btn.click()
  return { ok: true }
})()`))
await sleep(1800)
await shot('model-01-refreshed.png')
log('提示条', await evaluate(`document.body.innerText.split('\\n').filter((line) => line.includes('模型')).slice(0, 6)`))

// 5) 打开下拉看新模型是否在列表里
await evaluate(`[...document.querySelectorAll('button[aria-haspopup=listbox]')].find((b) => /Flash|Pro|V5/.test(b.innerText))?.click()`)
await sleep(800)
await shot('model-02-options.png')
log('下拉里的模型', await evaluate(`[...document.querySelectorAll('[role=option]')].map((o) => o.innerText.trim())`))
log('localStorage 里的模型表', await evaluate(`localStorage.getItem('chat-demo:models')`))

console.log('\nDONE')
process.exit(0)
