// 壳层对话窗的「离线预览」：不是替代真机验收，而是把没法在本会话里重启验证的
// 那一块（OpsBoardChatWindow 画出来的样子）用同一份 CSS + 同一份 ?chat=1 页面
// 拼起来看一眼。CSS 直接从插件源码里抽，避免「预览里好看、插件里难看」。
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const ROOT = 'D:/WorkSpace-Tools/dsh-ops-board'
const BOARD = process.argv[2] || 'D:/WorkSpace-Tools/ops-board-reports/practise'
const OUTDIR = 'D:/WorkSpace-DeepSeek'
const EDGES = [
  'C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe',
  'C:/Program Files (x86)/Microsoft/EdgeWebView/Application/141.0.3537.99/msedge.exe',
]

// ── 抽取插件里那段 CSS ───────────────────────────────────────────────
const src = readFileSync(join(ROOT, 'client.js'), 'utf8')
const begin = src.indexOf("'.ob-chatwin{")
if (begin < 0) throw new Error('没找到 .ob-chatwin 样式段')
// 字符串拼接以 `'` 结尾；抓到下一个不是以 + 续行的位置为止
const tail = src.indexOf("\n", begin)
let css = ''
let i = begin
const re = /'((?:[^'\\]|\\.)*)'/y
while (i < src.length) {
  re.lastIndex = i
  const m = re.exec(src)
  if (!m) break
  // 只吃以 .ob-chatwin 开头、或以 .ob-chatwin / data- 续接的相邻字符串
  const chunk = m[1]
  if (chunk.indexOf('.ob-chatwin') >= 0 || /^\.ob-chatwin|^\[data-(pinned|collapsed)|^\.is-moving/.test(chunk)) {
    css += chunk + '\n'
  }
  let j = re.lastIndex
  while (j < src.length && /\s/.test(src[j])) j++
  if (src[j] === '+') {
    let k = j + 1
    while (k < src.length && /\s/.test(src[k])) k++
    if (src[k] === "'") { i = k; continue }
    break
  }
  break
}
if (css.indexOf('.ob-chatwin-head') < 0) throw new Error('CSS 抽取不完整')
console.log('抽出 CSS 规则数：', (css.match(/\{/g) || []).length)

// ── 用同一份 CSS + 真实 ?chat=1 页面搭一个静态页 ─────────────────────
const boardHtml = readFileSync(join(BOARD, 'dist', 'index.html'), 'utf8')

// 插件用的是 Harness 自己的主题 token（--dsw-alias-*）。真机上由外壳提供，
// 预览页得自己补上，否则窗口标题栏和边框是透明的，看着像"样式没写对"，
// 其实是预览环境缺变量 —— 这种假象比不预览更误导人。
const TOKENS_NIGHT = `
  --dsw-alias-bg-base:#0d1117;
  --dsw-alias-bg-layer-1:#161b22;
  --dsw-alias-bg-layer-2:#1c2128;
  --dsw-alias-border-l2:#30363d;
  --dsw-alias-border-l3:#3d444d;
  --dsw-alias-interactive-bg-hover:#21262d;
  --dsw-alias-label-primary:#e6edf3;
  --dsw-alias-label-secondary:#9aa4b2;
  --dsw-alias-label-tertiary:#8b949e;
  --dsw-alias-label-quaternary:#6e7681;
`
const TOKENS_PAPER = `
  --dsw-alias-bg-base:#f6f3ea;
  --dsw-alias-bg-layer-1:#fffdf7;
  --dsw-alias-bg-layer-2:#f1ece0;
  --dsw-alias-border-l2:#d9d2c2;
  --dsw-alias-border-l3:#c6bda9;
  --dsw-alias-interactive-bg-hover:#efe9db;
  --dsw-alias-label-primary:#2f2a22;
  --dsw-alias-label-secondary:#5a5346;
  --dsw-alias-label-tertiary:#6b6355;
  --dsw-alias-label-quaternary:#8a8172;
`

const HARNESS_CSS = `
  :root{color-scheme:dark}
  body{margin:0;font:13px/1.5 -apple-system,"Segoe UI",sans-serif;
       background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);height:100vh;overflow:hidden}
  .fake-shell{display:flex;height:100vh}
  .fake-side{flex:none;width:240px;background:var(--dsw-alias-bg-layer-1);
             border-right:.5px solid var(--dsw-alias-border-l2);padding:12px}
  .fake-side b{display:block;margin-bottom:10px;color:var(--dsw-alias-label-tertiary);
               font-size:11px;letter-spacing:.08em}
  .fake-row{padding:6px 8px;border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:12px}
  .fake-row:nth-child(3){background:color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent);
                         color:var(--dsw-alias-label-primary)}
  .fake-main{flex:1;display:flex;flex-direction:column}
  .fake-top{flex:none;height:44px;display:flex;align-items:center;gap:10px;
            padding:0 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);
            background:var(--dsw-alias-bg-layer-1);
            font-size:12px;color:var(--dsw-alias-label-tertiary)}
  .fake-body{flex:1;position:relative;padding:18px}
  .fake-bubble{max-width:520px;margin:0 auto;padding:16px;
               border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;
               background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}
`

// 窗口内嵌的真实看板页面：直接内联成 srcdoc 太脆，改成指向本地静态路由
const FAKE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>壳层对话窗预览</title><style>T:root{TOKENS}</style><style>${HARNESS_CSS}</style><style>${css}</style>
</head><body>
<div class="fake-shell">
  <div class="fake-side"><b>HARNESS 侧边栏</b>
    <div class="fake-row">会话 A</div><div class="fake-row">会话 B</div>
    <div class="fake-row">项目看板</div><div class="fake-row">会话 C</div>
  </div>
  <div class="fake-main">
    <div class="fake-top">← 顶部工具栏（这条也在窗口下面）</div>
    <div class="fake-body">
      <div class="fake-bubble">这里是 Harness 的聊天区。
      下面这个窗口就是插件画在 document.body 上的那块 ——
      它<b>盖住了侧边栏和这条顶栏</b>，因为它是外壳层的 fixed，不是看板 iframe 里的 fixed。</div>
    </div>
  </div>
</div>
<div class="ob-chatwin" data-pinned="PINNED" data-collapsed="0"
     style="left:GEOMX;top:GEOMY;width:GEOMW;height:GEOMH">
  <div class="ob-chatwin-head">
    <span class="ob-chatwin-title">项目看板 · prev</span>
    <button type="button" class="ob-chatwin-btn" title="钉在最上层">○</button>
    <button type="button" class="ob-chatwin-btn" title="收起">—</button>
    <button type="button" class="ob-chatwin-btn" title="关掉">×</button>
  </div>
  <div class="ob-chatwin-body">
    <iframe class="ob-chatwin-frame" src="/board?chat=1&scope=__global__" title="项目看板"></iframe>
  </div>
  ${['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'].map((d) => `<span class="ob-chatwin-grip" data-dir="${d}"></span>`).join('\n  ')}
</div>
</body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/board') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(boardHtml)
    return
  }
  // 预览页本身按主题和几何参数生成
  const theme = url.searchParams.get('theme') || 'night'
  const vw = Number(url.searchParams.get('vw') || 1280)
  const vh = Number(url.searchParams.get('vh') || 760)
  const w = Math.min(520, vw - 60)
  const h = Math.min(660, vh - 90)
  // 默认放右下角（跟真机的 defaultChatGeom 一致）；pos=left 时挪到左上，
  // 好让"盖住侧边栏 + 顶栏"这件事在截图里一眼可见。
  const pos = url.searchParams.get('pos') || 'right'
  const x = pos === 'left' ? 90 : Math.max(6, vw - w - 24)
  const y = pos === 'left' ? 20 : Math.max(6, vh - h - 24)
  const html = FAKE
    .replace('T:root{TOKENS}', ':root{' + (theme === 'paper' ? TOKENS_PAPER : TOKENS_NIGHT) + '}')
    .replace('PINNED', url.searchParams.get('pinned') === '1' ? '1' : '0')
    .replace('GEOMX', x + 'px')
    .replace('GEOMY', y + 'px')
    .replace('GEOMW', w + 'px')
    .replace('GEOMH', h + 'px')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
console.log('preview on', port)

// ── 截图 ─────────────────────────────────────────────────────────────
const edge = EDGES.find((p) => existsSync(p))
if (!edge) throw new Error('没找到 Edge')

async function shoot(theme, pinned, file, vw, vh, pos) {
  const profile = join(OUTDIR, '.preview-profile-' + theme + '-' + Date.now())
  const argList = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    '--window-size=' + vw + ',' + vh,
    'about:blank',
  ]
  const child = spawn(edge, argList, { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
  const portFile = join(profile, 'DevToolsActivePort')
  let dbg = null
  for (let t = 0; t < 100; t++) {
    if (existsSync(portFile)) {
      const txt = readFileSync(portFile, 'utf8').split('\n')
      if (txt[0]) { dbg = Number(txt[0]); break }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!dbg) throw new Error('抓不到调试端口')

  const targets = await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  await new Promise((r) => (ws.onopen = r))
  const send = (method, params = {}) =>
    new Promise((resolve) => { const n = ++id; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })) })

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/?theme=${theme}&pinned=${pinned}&vw=${vw}&vh=${vh}&pos=${pos}` })
  await new Promise((r) => setTimeout(r, 2600))
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUTDIR, file), Buffer.from(shot.result.data, 'base64'))

  // 顺手量一下：窗口是否真的盖住侧边栏
  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const w = document.querySelector('.ob-chatwin').getBoundingClientRect();
      const side = document.querySelector('.fake-side').getBoundingClientRect();
      const top = document.querySelector('.fake-top').getBoundingClientRect();
      const overlapSide = w.left < side.right;
      const overlapTop = w.top < top.bottom;
      return JSON.stringify({
        win: [Math.round(w.left), Math.round(w.top), Math.round(w.width), Math.round(w.height)],
        vw: innerWidth, vh: innerHeight,
        overlapSide, overlapTop,
        z: getComputedStyle(document.querySelector('.ob-chatwin')).zIndex,
        grips: document.querySelectorAll('.ob-chatwin-grip').length,
        frameOk: !!document.querySelector('.ob-chatwin-frame'),
      });
    })()`,
    returnByValue: true,
  })
  ws.close()
  try { child.kill() } catch {}
  return JSON.parse(probe.result.result.value)
}

const night = await shoot('night', '0', 'chatwin-shell-night.png', 1280, 760, 'left')
console.log('night:', JSON.stringify(night))
const paper = await shoot('paper', '1', 'chatwin-shell-paper.png', 1100, 700, 'left')
console.log('paper:', JSON.stringify(paper))

server.close()
console.log('done')