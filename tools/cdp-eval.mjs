// 在已启动的无头 Edge / WebView 页面上求值一段 JS：
//   node tools/cdp-eval.mjs "<expression>"
// 目标可用 TARGET_FILTER 指定要匹配的 URL 片段（默认本地 8091 预览页）
const PORT = process.env.CDP_PORT ?? '9222'
const FILTER = process.env.TARGET_FILTER ?? '127.0.0.1:8091'

const findPage = async () => {
  const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
  return targets.find((t) => t.type === 'page' && t.url.includes(FILTER))
}

const page = await findPage()
if (!page) throw new Error('no page target')

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

const expression = process.argv.slice(2).join(' ')
const result = await send('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
  // 让 click() 之类算作真实用户手势，否则浏览器会拦掉文件选择框
  userGesture: true,
})
if (result.exceptionDetails) {
  console.log('EXCEPTION:', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
} else {
  console.log(JSON.stringify(result.result.value, null, 2))
}
process.exit(0)
