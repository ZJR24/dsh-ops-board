// 验证 BroadcastChannel 能否把回答送到「独立浏览器窗口」。
//
// 为什么是 BroadcastChannel：独立窗口和 Harness 页面**同源**（都在 127.0.0.1:1534），
// BroadcastChannel 按源隔离、跨 window 投递，不经过任何父窗口/iframe 关系。
// 这是"独立窗口收回答"最短的一条路，且**不需要改 Host、不需要重启应用**。
//
// 两个页面都真的 load 看板页（?chat=1），一个当"插件"发，一个当"独立窗"收。
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe',
  'C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe',
]
const EDGE = CANDIDATES.find((p) => existsSync(p))
const BASE = 'http://127.0.0.1:1534'
const BOARD = process.argv[2] || 'practise'
const PAGE = `${BASE}/ops-board/b/${BOARD}/?chat=1`
const PORT = 9334
const profile = mkdtempSync(join(tmpdir(), 'ob-bc-'))

const child = spawn(EDGE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  PAGE,
], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (pages.length) return pages
    } catch {}
    await sleep(250)
  }
  throw new Error('拿不到 CDP 目标')
}

function makeRpc() {
  let id = 0
  return (ws, method, params) => new Promise((resolve, reject) => {
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
const rpc = makeRpc()

async function evalOn(urlStr, expr) {
  const ws = new WebSocket(urlStr)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const r = await rpc(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  ws.close()
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''))
  return r.result.value
}

try {
  const [first] = await targets()
  await sleep(1000)

  // 开第二个真实页面（模拟独立窗口）
  const ws = new WebSocket(first.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const { targetId } = await rpc(ws, 'Target.createTarget', { url: PAGE })
  ws.close()
  await sleep(2500)

  const list = await targets()
  const others = list.filter((t) => t.id === targetId)
  if (!others.length) throw new Error('独立窗口没起来')
  const A = list.find((t) => t.id !== targetId)   // 当"插件"侧
  const B = others[0]                              // 当"独立窗"侧

  for (const t of [A, B]) {
    await evalOn(t.webSocketDebuggerUrl, `(() => {
      if (!window.__BC) {
        window.__BC = { received: [], ch: new BroadcastChannel('ops-board-answers') };
        window.__BC.ch.onmessage = (e) => window.__BC.received.push(e.data);
      }
      return true;
    })()`)
  }

  // 同一源的两个页面（一个可能是同一 tab 的两个 target，但 BroadcastChannel 仍按源投递）
  const sent = await evalOn(A.webSocketDebuggerUrl, `(() => {
    const f = new BroadcastChannel('ops-board-answers');
    f.postMessage({ type: 'ops-board/answer', askId: 'ask-c-bcprobe', surface: 'chat', text: '跨窗口投递检查' });
    f.close();
    return true;
  })()`)
  await sleep(1200)

  const gotB = await evalOn(B.webSocketDebuggerUrl, 'JSON.stringify(window.__BC.received)')
  const gotA = await evalOn(A.webSocketDebuggerUrl, 'JSON.stringify(window.__BC.received)')

  console.log(JSON.stringify({ sent, standaloneReceived: JSON.parse(gotB), senderReceived: JSON.parse(gotA) }, null, 2))
} catch (e) {
  console.log('FAILED: ' + e.message)
} finally {
  try { child.kill() } catch {}
  await sleep(400)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
}
