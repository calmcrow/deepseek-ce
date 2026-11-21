// 验证：字体大小、四语言切换、自动朗读（用打桩的 SSE 回复 + TTS 计数）
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

/** 打开设置 → 通用设置 */
const openGeneral = async () => {
  await evaluate(`[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '设置')?.click()`)
  await sleep(900)
  await evaluate(`[...document.querySelectorAll('[role=tab]')].find((b) => /通用设置|General/.test(b.innerText))?.click()`)
  await sleep(900)
}

/** 点开某个下拉，再点其中一个选项 */
const chooseSelect = async (triggerText, optionText) => {
  const opened = await evaluate(`(() => {
    const trigger = [...document.querySelectorAll('button[aria-haspopup=listbox]')]
      .find((b) => b.innerText.trim() === ${JSON.stringify(triggerText)})
    if (!trigger) return 'no trigger'
    trigger.click()
    return 'opened'
  })()`)
  await sleep(700)
  const chosen = await evaluate(`(() => {
    const option = [...document.querySelectorAll('[role=option]')]
      .find((o) => o.innerText.trim() === ${JSON.stringify(optionText)})
    if (!option) return { ok: false, options: [...document.querySelectorAll('[role=option]')].map((o) => o.innerText.trim()) }
    option.click()
    return { ok: true }
  })()`)
  await sleep(700)
  return { opened, chosen }
}

await send('Runtime.enable')
await send('Page.enable')
await waitReady()
await evaluate(`localStorage.clear(); localStorage.setItem('chat-demo:api-key', 'sk-dummy-settings-test')`)
await send('Page.navigate', { url: 'http://127.0.0.1:8091/' })
await sleep(2500)
await waitReady()

// ---------- 1) 设置里三项都在 ----------
await openGeneral()
const panelText = await evaluate(`document.querySelector('[role=tabpanel]')?.innerText ?? ''`)
log('通用设置文本', panelText.split('\n').filter((line) => line.trim()).slice(0, 30))
for (const label of ['语言', '字体大小', '自动朗读']) {
  console.log(`包含「${label}」: ${panelText.includes(label)}`)
}
await shot('settings-01-general.png')

// ---------- 2) 字号：特大 ----------
log('切到特大', await chooseSelect('标准', '特大'))
log('zoom 与是否横向溢出', await evaluate(`(() => {
  const root = document.documentElement
  const rect = document.body.getBoundingClientRect()
  return {
    inlineZoom: root.style.zoom,
    computedZoom: getComputedStyle(root).zoom,
    innerWidth: window.innerWidth,
    bodyWidth: Math.round(rect.width),
    overflowX: document.documentElement.scrollWidth > window.innerWidth,
  }
})()`))
await shot('settings-02-font-xl.png')
await chooseSelect('特大', '标准')

// ---------- 3) 语言：日本語 → 繁體中文 → 简体中文 ----------
log('切到日本語', await chooseSelect('简体中文', '日本語'))
await sleep(900)
log('日文界面抽样', await evaluate(`document.body.innerText.split('\\n').filter((l) => l.trim()).slice(0, 14)`))
log('html lang', await evaluate(`document.documentElement.lang`))
await shot('settings-03-ja.png')

await openGeneral()
log('切到繁體中文', await chooseSelect('日本語', '繁體中文'))
await sleep(900)
log('繁中界面抽样', await evaluate(`document.body.innerText.split('\\n').filter((l) => l.trim()).slice(0, 14)`))
await shot('settings-04-zh-tw.png')

await openGeneral()
log('切回简体中文', await chooseSelect('繁體中文', '简体中文'))
await sleep(900)
log('回到简中', await evaluate(`document.body.innerText.split('\\n').filter((l) => l.trim()).slice(0, 8)`))

// ---------- 4) 自动朗读 ----------
// 打桩：/messages 返回一段假 SSE 回复；/tts 记录调用次数
log('打桩 fetch', await evaluate(`(() => {
  window.__ttsCalls = []
  if (!window.__origFetch) window.__origFetch = window.fetch
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg-test","model":"deepseek-flash"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"这是一段测试回答。"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":5,"output_tokens":8,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    ''
  ].join('\\n')
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    if (url.includes('/anthropic/v1/messages')) {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        }
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }))
    }
    if (url.includes('/v1/tools/tts')) {
      window.__ttsCalls.push(url)
      const pcm = new Uint8Array(4800)
      return Promise.resolve(new Response(pcm, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }))
    }
    return window.__origFetch(input, init)
  }
  return 'stubbed'
})()`))

const sendMessage = async (text) => {
  await evaluate(`(() => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, ${JSON.stringify(text)})
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    return ta.value
  })()`)
  await sleep(3500)
}

// 关闭状态下先发一条：不应触发 TTS
await sendMessage('关闭自动朗读时的测试')
log('关闭时 TTS 调用次数', await evaluate(`window.__ttsCalls.length`))

// 点顶部喇叭开启
log('点喇叭开启', await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '开启自动朗读')
  if (!btn) return { ok: false, labels: [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')).filter(Boolean) }
  btn.click()
  return { ok: true }
})()`))
await sleep(600)
log('提示条 / 设置值', await evaluate(`({ toast: document.body.innerText.split('\\n').find((l) => l.includes('自动朗读') && l.includes('开启')) ?? null, stored: localStorage.getItem('chat-demo:auto-read-aloud') })`))
await shot('settings-05-autoread-on.png')

// 开启后再发一条：应触发一次 TTS
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '新对话' || b.innerText.includes('开启新对话'))?.click()`)
await sleep(800)
await sendMessage('开启自动朗读后的测试')
log('开启后 TTS 调用次数', await evaluate(`window.__ttsCalls.length`))
log('朗读请求直达的地址', await evaluate(`window.__ttsCalls[0] ?? null`))

console.log('\nDONE')
process.exit(0)
