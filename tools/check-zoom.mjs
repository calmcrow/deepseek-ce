// 检查四档界面缩放下有没有横向溢出、输入框是否还在视口内
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

await send('Runtime.enable')

// 页面可能换过一次 document，先等应用挂载完成再读 localStorage
for (let i = 0; i < 80; i++) {
  const ready = await evaluate(
    `document.readyState === 'complete' && !!document.querySelector('textarea')`
  ).catch(() => false)
  if (ready) break
  await sleep(300)
}

const measure = () =>
  evaluate(`(() => {
    const input = document.querySelector('textarea')?.closest('div')
    const box = input?.getBoundingClientRect()
    return {
      zoom: getComputedStyle(document.documentElement).zoom,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      inputBottom: box ? Math.round(box.bottom) : null,
      inputInView: box ? box.bottom <= window.innerHeight + 1 : null,
    }
  })()`)

const results = []
for (const [key, label] of [
  ['small', '小 0.9'],
  ['standard', '标准 1.0'],
  ['large', '大 1.15'],
  ['xlarge', '特大 1.3'],
]) {
  await evaluate(`localStorage.setItem('chat-demo:font-size', '${key}')`)
  await send('Page.navigate', { url: 'http://127.0.0.1:8091/' })
  await sleep(1800)
  results.push({ label, ...(await measure()) })
}
console.log(JSON.stringify(results, null, 2))
process.exit(0)
