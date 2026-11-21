// 复现「导入历史对话后白屏」：把任意 deepseek_data-*.zip 走一遍真实导入 UI，
// 收集未捕获异常、控制台错误，并判断页面是否白屏。
//
// 前置：
//   node tools/serve-dist.mjs chat-demo/dist 8091
//   msedge --headless=new --remote-debugging-port=9222 --user-data-dir=tmp/edge-repro http://127.0.0.1:8091/
// 用法：
//   node tools/repro-import.mjs <archive.zip> [--fresh]
// --fresh：导入前先清空本地 IndexedDB，便于重复复现
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { basename, resolve } from 'node:path'

const APP = process.env.APP_URL ?? 'http://127.0.0.1:8091'
const PORT = process.env.CDP_PORT ?? '9222'
const DIST = process.env.DIST_DIR ?? 'chat-demo/dist'
// 安卓 WebView 的目标 URL 是 appassets.androidplatform.net，用 TARGET_FILTER 指过去
const FILTER = process.env.TARGET_FILTER ?? '127.0.0.1:8091'
// 已经在目标页面上（例如安卓应用内的 WebView）时不要重新导航
const SKIP_NAVIGATE = process.env.SKIP_NAVIGATE === '1'
// 目标页面取不到本地文件时（安卓 WebView 的 appassets 源），直接把归档字节塞进去
const INJECT_BASE64 = process.env.INJECT_BASE64 === '1'
const fresh = process.argv.includes('--fresh')
const zipPath = resolve(process.argv[2] ?? '')
const servedName = '__repro.zip'

const log = (label, value) =>
  console.log(`\n### ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.events = []
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      if (!msg.id) {
        this.events.push(msg)
        return
      }
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result)
    }
  }

  static async connect(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => {
      ws.onopen = res
      ws.onerror = () => rej(new Error('ws error'))
    })
    return new Cdp(ws)
  }

  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }))
  }

  async evaluate(expression, userGesture = false) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    })
    if (result.exceptionDetails) {
      return { __exception: result.exceptionDetails.text, detail: result.exceptionDetails.exception?.description }
    }
    return result.result.value
  }
}

const findTarget = async () => {
  for (let i = 0; i < 60; i++) {
    const targets = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      .then((r) => r.json())
      .catch(() => [])
    const page = targets.find((t) => t.type === 'page' && t.url.includes(FILTER))
    if (page) return page
    await sleep(300)
  }
  throw new Error('CDP 页面目标没找到，Edge 起来了吗？')
}

await copyFile(zipPath, resolve(DIST, servedName))
log('待导入归档', `${zipPath} → ${DIST}/${servedName}`)

const page = await findTarget()
const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
await cdp.send('Runtime.enable')
await cdp.send('Page.enable')
await cdp.send('Log.enable')
// 桌面宽度，侧栏才会常驻显示会话列表；安卓 WebView 保持设备自身的视口
if (!SKIP_NAVIGATE) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
}

// 在任何脚本事前装好错误收集器，跨越整页导航
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__repro = { errors: [], rejections: [], toasts: [] };
    window.addEventListener('error', (e) => {
      window.__repro.errors.push(String(e.error && e.error.stack || e.message));
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e.reason;
      window.__repro.rejections.push(String(r && r.stack || r));
    });
  `,
})

// 模拟老 WebView：把这些新 API 删掉，看垫片兜不兜得住
if (process.env.SIMULATE_OLD_WEBVIEW === '1') {
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      delete Array.prototype.toSorted;
      delete Array.prototype.toReversed;
      delete Array.prototype.at;
      delete Object.hasOwn;
      window.__reproOldWebView = {
        toSorted: typeof Array.prototype.toSorted,
        toReversed: typeof Array.prototype.toReversed,
        at: typeof Array.prototype.at,
        hasOwn: typeof Object.hasOwn,
      };
    `,
  })
  log('已模拟老 WebView（删掉 toSorted/toReversed/at/hasOwn）', 'on')
}

const waitReady = async () => {
  for (let i = 0; i < 80; i++) {
    const ready = await cdp
      .evaluate(`document.readyState === 'complete' && !!document.querySelector('textarea')`)
      .catch(() => false)
    if (ready) return
    await sleep(250)
  }
  throw new Error('应用没挂载起来')
}

if (fresh) {
  const cleared = await cdp.evaluate(`new Promise((res) => {
    const request = indexedDB.deleteDatabase('chat-demo')
    request.onsuccess = () => res('cleared')
    request.onerror = () => res('error')
    request.onblocked = () => res('blocked')
  })`)
  log('清空本地库', cleared)
}

if (!SKIP_NAVIGATE) {
  await cdp.send('Page.navigate', { url: `${APP}/` })
  await sleep(2200)
}
await waitReady()

// 设置 → 数据管理（中文界面用「设置」，英文界面用 Settings；手机端侧栏要先展开）
const drawer = await cdp.evaluate(
  `(() => {
    const open = document.querySelector('[aria-label="Open sidebar"]')
    if (!open) return { ok: true, already: true }
    open.click(); return { ok: true, opened: true }
  })()`,
  true
)
log('展开侧栏', drawer)
await sleep(600)

const openSettings = await cdp.evaluate(
  `(() => {
    const labels = ['设置', 'Settings']
    const entry = [...document.querySelectorAll('button')].find((b) => labels.includes(b.innerText.trim()))
    if (!entry) return { ok: false, buttons: [...document.querySelectorAll('button')].map((b) => b.innerText.trim()) }
    entry.click(); return { ok: true }
  })()`,
  true
)
log('打开设置', openSettings)
await sleep(800)

const openData = await cdp.evaluate(
  `(() => {
    const labels = ['数据管理', 'Data']
    const tab = [...document.querySelectorAll('[role=tab], button')]
      .find((b) => labels.includes(b.textContent.trim()))
    if (!tab) return { ok: false, labels: [...document.querySelectorAll('[role=tab]')].map((b) => b.textContent) }
    tab.click(); return { ok: true }
  })()`,
  true
)
log('切到数据管理', openData)
await sleep(700)

// 把归档塞给真实的 file input
const base64 = INJECT_BASE64 ? (await readFile(zipPath)).toString('base64') : ''
const attached = await cdp.evaluate(
  `(async () => {
    const input = [...document.querySelectorAll('input[type=file]')]
      .find((i) => (i.accept || '').includes('zip'))
    if (!input) return { ok: false, inputs: [...document.querySelectorAll('input[type=file]')].map((i) => i.accept) }
    ${
      INJECT_BASE64
        ? `const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: 'application/zip' })`
        : `const blob = await (await fetch('/${servedName}')).blob()`
    }
    const file = new File([blob], ${JSON.stringify(basename(zipPath))}, { type: 'application/zip' })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, size: file.size }
  })()`,
  true
)
log('塞入归档', attached)
await sleep(800)

const CONFIRM = `['确认导入', 'Import']`

const modal = await cdp.evaluate(
  `(() => {
    const text = document.body.innerText
    const confirm = [...document.querySelectorAll('button')].find((b) => ${CONFIRM}.includes(b.innerText.trim()))
    return { hasConfirm: !!confirm, dialogText: text.slice(0, 400) }
  })()`,
  true
)
log('覆盖确认弹窗', modal)

const clicked = await cdp.evaluate(
  `(() => {
    const confirm = [...document.querySelectorAll('button')].find((b) => ${CONFIRM}.includes(b.innerText.trim()))
    if (!confirm) return { ok: false }
    confirm.click(); return { ok: true }
  })()`,
  true
)
log('点击确认导入', clicked)
const importStartedAt = Date.now()

// 等导入结束：或出现结果文案，或整棵 React 树炸掉
const deadline = Date.now() + Number(process.env.IMPORT_WAIT_MS ?? 900000)
let state = null
let lastProgress = ''
while (Date.now() < deadline) {
  state = await cdp.evaluate(`(() => {
    const root = document.getElementById('root')
    const text = document.body.innerText
    const progress = document.querySelector('[data-import-progress]')
    return {
      rootChildren: root ? root.children.length : -1,
      bodyTextLen: text.length,
      text: text.slice(0, 600),
      progress: progress ? progress.textContent.trim() : null,
      hasProgressModal: text.includes('正在导入') || text.includes('Importing'),
      imported: /已导入\\s*\\d+\\s*个对话|Imported\\s+\\d+\\s+chats?/.test(text),
      failed: /文件导入失败|Import failed/.test(text),
      blank: !!root && root.children.length === 0,
      errors: (window.__repro?.errors ?? []).slice(0, 5),
      rejections: (window.__repro?.rejections ?? []).slice(0, 5),
    }
  })()`)
  if (state?.progress && state.progress !== lastProgress) {
    lastProgress = state.progress
    console.log(`  [${((Date.now() - importStartedAt) / 1000).toFixed(1)}s] ${state.progress}`)
  }
  if (state?.imported || state?.failed || state?.blank) break
  await sleep(700)
}
log('导入耗时(秒)', ((Date.now() - importStartedAt) / 1000).toFixed(1))

// 导入成功后真正打开会话渲染一遍：官方归档里的 TOOL_FIND / TOOL_OPEN(null) / READ_LINK
// 这些片段要经过 toLocal 转成本地块，渲染期最容易在这里炸。
if (state?.imported) {
  const closed = await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  })
  void closed
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  })
  await sleep(700)

  const opened = await cdp.evaluate(
    `(() => {
      const row = [...document.querySelectorAll('a, button, [role=button], li, div')]
        .filter((el) => el.children.length === 0 && el.textContent.trim() === '汇率查询')[0]
        ?? [...document.querySelectorAll('*')].find((el) => el.textContent.trim() === '汇率查询')
      if (!row) return { ok: false, sidebar: document.body.innerText.slice(0, 300) }
      row.click()
      return { ok: true, tag: row.tagName }
    })()`,
    true
  )
  log('打开导入的会话', opened)
  await sleep(2500)

  const rendered = await cdp.evaluate(`(() => {
    const root = document.getElementById('root')
    return {
      rootChildren: root ? root.children.length : -1,
      blank: !!root && root.children.length === 0,
      text: document.body.innerText.slice(0, 800),
      errors: (window.__repro?.errors ?? []).slice(0, 5),
      rejections: (window.__repro?.rejections ?? []).slice(0, 5),
    }
  })()`)
  log('会话渲染结果', rendered)
}

const exceptions = cdp.events
  .filter((e) => e.method === 'Runtime.exceptionThrown')
  .map((e) => e.params?.exceptionDetails?.exception?.description ?? e.params?.exceptionDetails?.text)
const consoleErrors = cdp.events
  .filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
  .map((e) => e.params.entry.text)

log('最终状态', state)
log('未捕获异常（Runtime.exceptionThrown）', exceptions)
log('控制台错误（Log.entryAdded）', consoleErrors)

const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
await writeFile('tmp/repro-import.png', Buffer.from(data, 'base64'))
log('截图', 'tmp/repro-import.png')

console.log('\nDONE')
process.exit(0)
