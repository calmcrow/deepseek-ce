// 验证侧边栏：搜索、置顶、多选批量删除
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
const items = () => evaluate(`document.querySelectorAll('[data-session-id]').length`)

/** 造一条会话：开新对话 → 输入 → 回车 */
const createSession = async (text) => {
  await evaluate(
    `[...document.querySelectorAll('button')].find((b) => b.innerText.includes('开启新对话'))?.click()`
  )
  await sleep(500)
  await evaluate(`(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return ta.value
  })()`)
  await sleep(2000)
}

await send('Runtime.enable')
await send('Page.enable')
await waitReady()
await evaluate(`localStorage.clear(); localStorage.setItem('chat-demo:api-key', 'sk-dummy-sidebar-test')`)
await send('Page.navigate', { url: 'http://127.0.0.1:8091/' })
await sleep(2500)
await waitReady()

// 1) 造三条会话
for (const text of ['alpha 第一个测试会话', 'beta 第二个测试会话', 'gamma 第三个测试会话']) {
  await createSession(text)
}
log('会话条数', await items())
await shot('sidebar-01-list.png')

// 2) 置顶第一条
log('打开第一条的菜单', await evaluate(`(() => {
  const item = document.querySelectorAll('[data-session-id]')[0]
  if (!item) return 'no item'
  const more = [...item.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '更多')
  if (!more) return 'no menu button'
  more.click()
  return 'menu opened'
})()`))
await sleep(900)
log('菜单项', await evaluate(`[...document.querySelectorAll('[role=menuitem]')].map((m) => m.innerText.trim())`))
log('点置顶', await evaluate(`(() => {
  const pin = [...document.querySelectorAll('[role=menuitem]')].find((m) => m.innerText.trim() === '置顶')
  if (!pin) return 'no pin option'
  pin.click()
  return 'pinned'
})()`))
await sleep(1200)
await shot('sidebar-02-pinned.png')
log('置顶后的列表文本', await evaluate(`document.body.innerText.split('\\n').filter((l) => l.trim()).slice(0, 12)`))

// 3) 搜索正文关键词
log('搜索 beta', await evaluate(`(() => {
  const input = document.querySelector('input[placeholder*="搜索对话内容"]')
  if (!input) return 'no search input'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'beta')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input.value
})()`))
await sleep(1800)
await shot('sidebar-03-search.png')
log('搜索结果条数', await items())
log('搜索结果文本', await evaluate(`document.body.innerText.split('\\n').filter((l) => l.trim()).slice(0, 10)`))

// 4) 清空搜索 → 多选 → 删两条
await evaluate(`(() => {
  const input = document.querySelector('input[placeholder*="搜索对话内容"]')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return 'cleared'
})()`)
await sleep(800)
log('进入多选', await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '多选')
  if (!btn) return { ok: false, labels: [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean) }
  btn.click()
  return { ok: true }
})()`))
await sleep(800)
log('勾选前两项', await evaluate(`(() => {
  const list = [...document.querySelectorAll('[data-session-id]')].slice(0, 2)
  list.forEach((item) => item.click())
  return list.length
})()`))
await sleep(600)
log('批量栏文本', await evaluate(`document.body.innerText.split('\\n').filter((l) => l.includes('已选')).join('|')`))
await shot('sidebar-04-selected.png')
log('点删除', await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '删除' && b.offsetParent !== null)
  if (!btn) return 'no delete button'
  btn.click()
  return 'delete clicked'
})()`))
await sleep(900)
await shot('sidebar-05-confirm.png')
log('确认弹窗标题', await evaluate(`document.querySelector('[role=dialog]')?.innerText.split('\\n')[0]`))
log('确认删除', await evaluate(`(() => {
  const dialog = document.querySelector('[role=dialog]')
  const btn = dialog ? [...dialog.querySelectorAll('button')].find((b) => b.innerText.trim() === '删除') : null
  if (!btn) return 'no confirm button'
  btn.click()
  return 'confirmed'
})()`))
await sleep(2500)
await shot('sidebar-06-after-delete.png')
log('删除后条数', await items())
log('删除后文本', await evaluate(`document.body.innerText.split('\\n').filter((l) => l.trim()).slice(0, 10)`))

console.log('\nDONE')
process.exit(0)
