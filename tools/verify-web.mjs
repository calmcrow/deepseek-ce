// 用 CDP 驱动无头 Edge 做真实交互验证：打开设置看新增项、填假 Key 发一条消息看报错链路
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'

const PORT = process.env.CDP_PORT ?? '9222'
const BASE = `http://127.0.0.1:${PORT}`
const OUT = process.env.OUT_DIR ?? 'tools'

const log = (label, value) =>
  console.log(`\n### ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('ws error'))
    })
    const cdp = new Cdp(ws)
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      const entry = msg.id ? cdp.pending.get(msg.id) : undefined
      if (!entry) return
      cdp.pending.delete(msg.id)
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
    }
    return cdp
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        `${result.exceptionDetails.text} :: ${result.exceptionDetails.exception?.description ?? ''}`
      )
    }
    return result.result.value
  }

  async pressEscape() {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
        nativeVirtualKeyCode: 27,
      })
    }
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    await writeFile(`${OUT}/${name}`, Buffer.from(data, 'base64'))
  }
}

const findTarget = async () => {
  for (let i = 0; i < 60; i++) {
    const targets = await fetch(`${BASE}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    const page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:8091'))
    if (page) return page
    await sleep(300)
  }
  throw new Error('page target not found')
}

/** 页面可能已经换过一次 document，求值前等到应用真的挂载完成 */
const waitReady = async (cdp) => {
  for (let i = 0; i < 60; i++) {
    const ready = await cdp
      .evaluate(`document.readyState === 'complete' && !!document.querySelector('textarea')`)
      .catch(() => false)
    if (ready) return true
    await sleep(300)
  }
  throw new Error('app never became ready')
}

const page = await findTarget()
const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await waitReady(cdp)

// 1) 写入假 Key，用真实导航重新加载整页
await cdp.evaluate(`(() => {
  try { localStorage.setItem('chat-demo:api-key', 'sk-dummy-for-smoke-test'); return 'set' }
  catch (error) { return error.name + ': ' + error.message }
})()`)
await cdp.send('Page.navigate', { url: 'http://127.0.0.1:8091/' })
await sleep(2500)
await waitReady(cdp)

// 2) 打开设置 → 通用设置，检查新增的模型与系统提示词
const openedSettings = await cdp.evaluate(`(() => {
  const entry = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '设置')
  if (!entry) {
    return { ok: false, buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()) }
  }
  entry.click()
  return { ok: true }
})()`)
log('点击侧栏「设置」', openedSettings)
await sleep(900)

const openedGeneral = await cdp.evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role=tab]')]
  const general = tabs.find((b) => b.textContent.includes('通用设置'))
  if (!general) return { ok: false, tabs: tabs.map((b) => b.textContent) }
  general.click()
  return { ok: true }
})()`)
log('打开通用设置', openedGeneral)
await sleep(900)
await cdp.shot('01-settings-general.png')

const settingsText = await cdp.evaluate(`(() => {
  const panel = document.querySelector('[role=tabpanel]')
  return panel ? panel.innerText : '(no panel)'
})()`)
log('通用设置面板文本', settingsText)

const modelState = await cdp.evaluate(`(() => {
  const selects = [...document.querySelectorAll('button[aria-haspopup=listbox]')].map((b) => b.innerText.trim())
  const textarea = document.querySelector('textarea')
  return { selects, systemPromptValue: textarea ? textarea.value : null }
})()`)
log('选择器与系统提示词初值', modelState)

// 3) 关掉设置，发一条消息看请求链路（假 Key 预期 401）
await cdp.pressEscape()
await sleep(700)
await cdp.shot('02-welcome.png')

const typed = await cdp.evaluate(`(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return { ok: false }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '你好，这是一条冒烟测试消息')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  return { ok: true, value: ta.value }
})()`)
log('输入并回车', typed)
await sleep(9000)
await cdp.shot('03-after-send.png')

const conversation = await cdp.evaluate(`document.body.innerText.slice(0, 2000)`)
log('发送后的页面文本', conversation)

console.log('\nDONE')
process.exit(0)
