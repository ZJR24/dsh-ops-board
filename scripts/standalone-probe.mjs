// 独立系统窗口可行性实测（不是推断，是实测）。
//
// 要回答的问题：从 Harness 页面用 window.open("http://127.0.0.1:1534/ops-board/b/<id>/?chat=1")
// 打开的**系统浏览器窗口**里，能不能：
//   ① 拿到看板页面（同源，所以 /ops-board/ask 可以直连）
//   ② POST /ops-board/ask 成功（sameOrigin 检查过得去）
//   ③ 挂上 EventSource /ops-board/events 收到 Host 推的帧
//
// 这里用 CDP 起一个独立 Edge 进程模拟"系统浏览器窗口"，
// 直接 load 那个 URL，然后在该页面上下文里跑 fetch/EventSource。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe',
  'C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe',
]
const EDGE = CANDIDATES.find((p) => existsSync(p))
if (!EDGE) { console.log('找不到 Edge'); process.exit(1) }

const BASE = 'http://127.0.0.1:1534'
const BOARD = process.argv[2] || 'practise'
const URL_ = `${BASE}/ops-board/b/${BOARD}/?chat=1`
const PORT = 9333
const profile = mkdtempSync(join(tmpdir(), 'ob-standalone-'))

const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--window-size=560,720',
  URL_,
], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('拿不到 CDP 目标')
}

let id = 0
function rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const myId = ++id
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id !== myId) return
      ws.removeEventListener('message', onMsg)
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
}

async function evaluate(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}

try {
  const wsUrl = await getWs()
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  await rpc(ws, 'Runtime.enable', {})
  await rpc(ws, 'Page.enable', {})

  // 等页面真的 load 完
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(ws, 'document.readyState').catch(() => '')
    if (ready === 'complete') break
    await sleep(250)
  }
  await sleep(800)

  const out = await evaluate(ws, `(async () => {
    const R = { url: location.href, origin: location.origin };
    R.isChatOnly = document.documentElement.getAttribute('data-chat') === '1';
    R.hasHarnessEnv = !!window.__OPS_HARNESS__;
    R.harnessId = window.__OPS_HARNESS__ && window.__OPS_HARNESS__.id;
    // 页面里的 chrome 应该被 chat-only 模式藏掉
    const nav = document.querySelector('.nav');
    R.navHidden = !nav || getComputedStyle(nav).display === 'none';

    // ① POST /ops-board/ask（同源，应能过 sameOrigin）
    try {
      const t0 = Date.now();
      const r = await fetch('/ops-board/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          board: R.harnessId || 'practise', item: '__global__',
          title: '独立窗连通性探针', askId: 'probe-standalone-1',
          inline: true, surface: 'chat',
          question: '这是独立窗口连通性探针，请不要实际执行任何操作，只回一句 OK。',
        }),
      });
      R.askStatus = r.status;
      R.askBody = await r.json();
      R.askMs = Date.now() - t0;
    } catch (e) { R.askError = e.name + ': ' + e.message; }

    // ② EventSource /ops-board/events —— 独立窗口能不能收到 Host 的推送？
    R.sse = await new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; try{es.close()}catch{}; resolve(v) } };
      let es;
      try { es = new EventSource('/ops-board/events') } catch (e) { return resolve({ error: String(e) }) }
      const timer = setTimeout(() => finish({ connected: false, note: '8s 内没有 open 事件' }), 8000);
      es.addEventListener('open', () => { finish({ connected: true }); clearTimeout(timer) });
      es.addEventListener('error', (e) => { /* 先不判失败，等超时 */ });
    });

    return R;
  })()`)

  console.log(JSON.stringify(out, null, 2))
  ws.close()
} catch (e) {
  console.log('FAILED: ' + e.message)
} finally {
  try { child.kill() } catch {}
  await sleep(400)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
