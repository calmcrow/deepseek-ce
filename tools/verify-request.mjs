// 抓 /anthropic/v1/messages 的真实请求体，验证模型与系统提示词确实进了请求
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.env.CDP_PORT ?? '9222'
const BASE = `http://127.0.0.1:${PORT}`

const findPage = async () => {
  for (let i = 0; i < 60; i++) {
    const targets = await fetch(`${BASE}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8091'))
    if (page) return page
    await sleep(300)
  }
  throw new Error('no page target')
}

const page = await findPage()
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = () => reject(new Error('ws error'))
})

let id = 0
const pending = new Map()
const captured = []

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Network.requestWillBeSent') {
    const { request } = msg.params
    if (request.url.includes('/anthropic/v1/messages')) {
      captured.push({ url: request.url, method: request.method, postData: request.postData })
    }
  }
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed')
  return result.result.value
}

const waitReady = async () => {
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`document.readyState === 'complete' && !!document.querySelector('textarea')`).catch(() => false)) return
    await sleep(300)
  }
  throw new Error('not ready')
}

await send('Runtime.enable')
await send('Page.enable')
await send('Network.enable')
await waitReady()

// 设定 Pro 模型 + 自定义系统提示词
const seeded = await evaluate(`(() => {
  localStorage.setItem('chat-demo:api-key', 'sk-dummy-for-smoke-test')
  localStorage.setItem('chat-demo:model', 'deepseek-v4-pro')
  localStorage.setItem('chat-demo:system-prompt', '你是一只猫，只用喵回答。')
  return { model: localStorage.getItem('chat-demo:model'), system: localStorage.getItem('chat-demo:system-prompt') }
})()`)
console.log('### 写入设置\n', JSON.stringify(seeded, null, 2))

await send('Page.navigate', { url: 'http://127.0.0.1:8091/' })
await sleep(2500)
await waitReady()

const typed = await evaluate(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '你是谁？')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return ta.value
})()`)
console.log('### 已发送', typed)

for (let i = 0; i < 30 && captured.length === 0; i++) await sleep(500)

if (captured.length === 0) {
  console.log('### 没有抓到请求')
  process.exit(1)
}

const body = JSON.parse(captured[0].postData)
console.log('### 请求 URL\n', captured[0].url)
console.log(
  '### 请求体关键字段\n',
  JSON.stringify(
    {
      model: body.model,
      system: body.system,
      thinking: body.thinking,
      tools: body.tools,
      safety_check: body.safety_check,
      hasTitle: Boolean(body.title),
      stream: body.stream,
      messageRoles: body.messages.map((m) => m.role),
    },
    null,
    2
  )
)
process.exit(0)
