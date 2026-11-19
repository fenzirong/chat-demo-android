// 验证第三方服务商的客户端联网搜索：检索 → 注入 → 出答案
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'

const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell`
const APP = 'http://127.0.0.1:8123/index.html'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=9333',
    '--user-data-dir=/tmp/chrome-e2e-search',
    '--window-size=420,900',
    'about:blank',
  ],
  { stdio: 'ignore' }
)

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (c) => (data += c))
      res.on('end', () => {
        try { resolve(JSON.parse(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })

let version
for (let i = 0; i < 60; i++) {
  try { version = await getJson('http://127.0.0.1:9333/json/version'); break } catch { await sleep(250) }
}
if (!version) { console.error('chrome 未启动'); process.exit(1) }

const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

let nextId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result)
  }
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const call = (method, params) => send(method, params, sessionId)
await call('Page.enable', {})
await call('Runtime.enable', {})
await call('Log.enable', {})
await call('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 2, mobile: true })

const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const provider = {
  id: 'commandcode',
  name: 'CommandCode',
  baseUrl: 'http://127.0.0.1:18080/v1',
  protocol: 'anthropic',
  authMode: 'bearer',
  model: 'claude-sonnet-5',
  anthropicVersion: null,
  capabilities: {
    thinking: 'anthropic',
    search: false,
    clientSearch: true,
    files: false,
    title: false,
    speech: false,
    latestReminder: false,
    safetyCheck: false,
  },
}

await call('Page.navigate', { url: APP })
await sleep(1500)
await evaluate(`
  localStorage.setItem('chat-demo:provider', ${JSON.stringify(JSON.stringify(provider))});
  localStorage.setItem('chat-demo:api-keys', ${JSON.stringify(JSON.stringify({ commandcode: 'sk-test' }))});
  localStorage.setItem('chat-demo:locale', 'zh-CN');
  localStorage.setItem('chat-demo:search', 'true');
  localStorage.setItem('chat-demo:search-provider', 'searxng');
  localStorage.setItem('chat-demo:searxng-url', 'http://127.0.0.1:18081');
  localStorage.setItem('chat-demo:search-read-pages', 'false');
  localStorage.removeItem('chat-demo:search-count');
  'ok'
`)
await call('Page.reload', {})
await sleep(2000)

let failures = 0
const check = (name, ok, detail) => {
  if (ok) console.log(`  ok   ${name}`)
  else { failures++; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`) }
}

const toggleOn = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '智能搜索');
  return btn ? btn.getAttribute('aria-pressed') : 'missing';
})()`)
check('智能搜索开关对第三方可用', toggleOn === 'true', toggleOn)

const enabled = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '智能搜索');
  return btn ? !btn.disabled : false;
})()`)
check('智能搜索开关未置灰', enabled === true)

await evaluate(`document.querySelector('textarea').focus(); 'ok'`)
await call('Input.insertText', { text: 'DeepSeek 官方文档在哪里？' })
await sleep(300)
for (const type of ['keyDown', 'keyUp']) {
  await call('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
}
await sleep(6000)

const bodyText = await evaluate('document.body.innerText')
check('回复已渲染', bodyText.includes('DeepSeek 官方文档'), bodyText.slice(-200))

// 校验发往模型服务商的请求：system 里应包含注入的检索资料
const lines = readFileSync('/tmp/mock-requests.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const chatRequest = lines.filter((l) => l.url === '/v1/messages').at(-1)
const payload = JSON.parse(chatRequest.body)
check('请求带上了搜索注入的 system', typeof payload.system === 'string' && payload.system.includes('[1] DeepSeek 官方文档'), payload.system?.slice(0, 120))
check('注入内容标注了来源', payload.system?.includes('https://api-docs.deepseek.com/zh-cn/'))
check('注入了引用规范', payload.system?.includes('[编号]'), payload.system?.slice(0, 200))
check('没有把 DeepSeek 私有字段发给第三方', payload.tools === undefined && payload.safety_check === undefined)

// 设置界面
await evaluate(`(() => {
  const openSider = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '打开边栏');
  openSider?.click(); return 'ok';
})()`)
await sleep(600)
await evaluate(`(() => {
  const target = [...document.querySelectorAll('button')].find((b) => (b.className || '').includes('settings'));
  target?.click(); return 'ok';
})()`)
await sleep(700)
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('[role=tab]')].find((el) => el.textContent.trim() === '接口');
  tab?.click(); return 'ok';
})()`)
await sleep(600)
const settingsText = await evaluate('document.body.innerText')
check('设置里出现联网搜索分组', settingsText.includes('联网搜索'), settingsText.slice(0, 200))
check('显示搜索服务选择', settingsText.includes('SearXNG'))
check('显示结果条数', settingsText.includes('结果条数'))
const shot = await call('Page.captureScreenshot', { format: 'png' })
writeFileSync('/tmp/e2e-search-settings.png', Buffer.from(shot.data, 'base64'))

chrome.kill()
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
