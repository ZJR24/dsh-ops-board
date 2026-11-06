/**
 * Host-half smoke test (multi-board): mount the plugin on a throwaway HTTP
 * server, drive its registry/start/proxy routes for two boards, and check the
 * board-server lifecycle end to end.
 *
 *   node test/host-smoke.mjs [boardDir] [port]
 *
 * Defaults: <模板目录> (or OPS_TEMPLATE_DIR), first port 8792. A second board is
 * cloned into the OS temp dir with a different project name, so neither the
 * real registry nor a running 8790 server is touched.
 */
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply } from '../index.js'

const boardDir = process.argv[2] || process.env.OPS_BOARD_DIR || 'D:\\WorkSpace-Tools\\ops-board'
const port = Number(process.argv[3] || 8792)

const failures = []
const ok = (message) => console.log('ok  ', message)
const fail = (message) => {
  failures.push(message)
  console.error('FAIL:', message)
}
const assert = (condition, message) => (condition ? ok(message) : fail(message))

if (!existsSync(join(boardDir, 'scripts', 'serve.mjs'))) {
  console.error(`not an ops-board checkout: ${boardDir}`)
  process.exit(2)
}

const sandbox = mkdtempSync(join(tmpdir(), 'dsh-ops-board-test-'))
const secondDir = join(sandbox, 'board-b')
cpSync(boardDir, secondDir, { recursive: true })
const ledgerPath = join(secondDir, 'ledger.json')
const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
ledger.project = { ...(ledger.project || {}), name: '测试看板 B', slug: 'board-b', subtitle: '多看板探针' }
writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), 'utf8')
const registryFile = join(sandbox, 'boards.json')

const routes = []
const cleanups = []
const logs = []

const ctx = {
  effect(fn) {
    cleanups.push(fn())
    return () => {}
  },
  webServer: {
    register(options) {
      routes.push(options)
      return () => {}
    },
  },
  logger: {
    info: (message) => logs.push(String(message)),
    warn: (message) => logs.push('WARN ' + String(message)),
  },
}

apply(ctx, {
  boardDir,
  boards: [{ id: 'board-a', label: '看板 A', dir: boardDir }],
  port,
  autoStart: false,
  maxRunning: 2,
  registryFile,
  templateDir: boardDir,
  defaultCreateRoot: join(sandbox, 'roots'),
  nodePath: '',
  keepRunningOnExit: false,
})

assert(routes.length === 1 && routes[0].path === '/ops-board', 'registers one /ops-board prefix route')

const server = createServer((req, res) => routes[0].handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const getJson = async (path) => {
  const response = await fetch(origin + path)
  return { status: response.status, body: await response.json() }
}
const postJson = async (path, body) => {
  const response = await fetch(origin + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

let state = (await getJson('/ops-board/state')).body
assert(Array.isArray(state.boards) && state.boards.length === 1, 'starts with one configured board')
assert(state.boards[0].id === 'board-a' && state.boards[0].ready === false, 'board A is registered but not started')
assert(state.boards[0].proxy === '/ops-board/b/board-a/', 'board A has its own proxy namespace')

const started = await postJson('/ops-board/start', { board: 'board-a' })
assert(started.status === 200, 'POST /ops-board/start returns 200')
state = started.body
assert(state.boards[0].ready === true, 'board A starts')
assert(state.boards[0].project && state.boards[0].project.name === '项目报告', 'reads board A ledger project')

const ping = await getJson('/ops-board/b/board-a/api/ping')
assert(ping.status === 200 && ping.body.app === 'ops-board', 'proxies board A /api/ping')

const added = await postJson('/ops-board/boards', { label: '看板 B', dir: secondDir })
assert(added.status === 200 && added.body.ok === true, 'POST /ops-board/boards adds an existing checkout')
const boardB = added.body.state.boards.find((entry) => entry.dir === secondDir)
assert(Boolean(boardB), 'board B appears in state: ' + JSON.stringify(added.body.state.boards.map((entry) => entry.id)))
assert(boardB && boardB.label === '看板 B', 'board B keeps the supplied label')

const badAdd = await postJson('/ops-board/boards', { dir: join(sandbox, 'missing') })
assert(badAdd.status === 400 && badAdd.body.ok === false, 'adding a missing directory is rejected')

const createRoot = join(sandbox, 'roots')
const created = await postJson('/ops-board/boards/create', { projectDir: boardDir, root: createRoot })
assert(created.status === 200 && created.body.ok === true, 'creates a new board from the template')
const createdDir = created.body.dir
assert(createdDir === join(createRoot, 'ops-board'), 'new board folder is derived from the project dir: ' + createdDir)
assert(existsSync(join(createdDir, 'scripts', 'serve.mjs')), 'scaffolds scripts/serve.mjs')
assert(existsSync(join(createdDir, 'ledger.json')), 'writes ledger.json')
assert(existsSync(join(createdDir, 'board.config.json')), 'writes board.config.json')

// 脚本不再整目录拷贝：项目里只有转发入口，真身在模板。
const entrySrc = readFileSync(join(createdDir, 'scripts', 'serve.mjs'), 'utf8')
assert(entrySrc.length < 4000, 'scripts/serve.mjs is a thin forwarder, not a full copy')
assert(entrySrc.includes('OPS_TEMPLATE_DIR'), 'forwarder can locate the template')
assert(!existsSync(join(createdDir, 'scripts', 'lib')), 'no scripts/lib copy in the project')

// 关键不变量：package.json 里声明的每个 script 都必须有对应的入口文件。
// 少了任何一个，`npm run <script>` 在那块看板里就是 Cannot find module ——
// ask / uitest:offline 之前就是这么坏的。
const createdPkg = JSON.parse(readFileSync(join(createdDir, 'package.json'), 'utf8'))
const declared = new Set()
for (const command of Object.values(createdPkg.scripts || {})) {
  for (const part of String(command).split('&&')) {
    const m = part.match(/node\s+scripts[\\/]([\w.-]+\.mjs)/)
    if (m) declared.add(m[1])
  }
}
for (const name of declared) {
  assert(
    existsSync(join(createdDir, 'scripts', name)),
    `每个 package.json script 都有入口：缺 ${name}`,
  )
}
// 反过来，模板里每个脚本都要有入口（collect-skills 不在 scripts 里，但 serve 会调它）
for (const name of readdirSync(join(boardDir, 'scripts'))) {
  if (!name.endsWith('.mjs') || name === 'entry.mjs') continue
  assert(existsSync(join(createdDir, 'scripts', name)), `forwarder for ${name}`)
}
const createdProject = JSON.parse(readFileSync(join(createdDir, 'project.json'), 'utf8'))
assert(createdProject.templateDir === boardDir, 'project.json records templateDir: ' + createdProject.templateDir)
const createdLedger = JSON.parse(readFileSync(join(createdDir, 'ledger.json'), 'utf8'))
assert(Boolean(createdLedger.project && createdLedger.project.name), 'ledger has a project name: ' + JSON.stringify(createdLedger.project))
assert(
  Boolean(createdLedger.headline && createdLedger.highlights.length && createdLedger.metrics.length),
  'starter ledger carries a first-pass report (headline/highlights/metrics)',
)
assert(created.body.board.projectDir === boardDir, 'created board remembers its project directory')
const createdConfig = JSON.parse(readFileSync(join(createdDir, 'board.config.json'), 'utf8'))
assert(createdConfig.project && createdConfig.project.slug === 'ops-board', 'board.config project is rewritten')
assert(created.body.state.lastCreateDir === createRoot, 'lastCreateDir remembers the storage root')
const createdBoard = created.body.state.boards.find((entry) => entry.dir === createdDir)
assert(Boolean(createdBoard), 'created board is registered')
if (createdBoard) {
  const startCreated = await postJson('/ops-board/start', { board: createdBoard.id })
  const entryCreated = startCreated.body.boards.find((entry) => entry.id === createdBoard.id)
  assert(entryCreated && entryCreated.ready === true, 'created board starts')
  const pageCreated = await fetch(`${origin}/ops-board/b/${createdBoard.id}/`)
  const htmlCreated = await pageCreated.text()
  assert(pageCreated.status === 200, 'created board renders a page')
  assert(htmlCreated.includes(createdLedger.project.name), 'created board page contains its project name')
  const removedCreated = await postJson('/ops-board/boards/remove', { id: createdBoard.id })
  assert(removedCreated.status === 200 && removedCreated.body.ok === true, 'created board can be removed')
}

if (boardB) {
  const startB = await postJson('/ops-board/start', { board: boardB.id })
  const entryB = startB.body.boards.find((entry) => entry.id === boardB.id)
  assert(entryB && entryB.ready === true, 'board B starts on its own port')
  assert(entryB && entryB.port !== state.boards[0].port, 'board B does not share board A port')

  const boardJsonB = await getJson(`/ops-board/b/${boardB.id}/api/board`)
  assert(boardJsonB.status === 200 && boardJsonB.body.project.slug === 'board-b', 'proxies board B ledger')

  const pageB = await fetch(`${origin}/ops-board/b/${boardB.id}/`)
  const htmlB = await pageB.text()
  assert(pageB.status === 200 && htmlB.includes(`/ops-board/b/${boardB.id}`), 'serves board B page with its own shim prefix')
  assert(htmlB.includes('window.__OPS_HARNESS__='), 'injects the Harness-mode marker into the board page')
  assert(!htmlB.includes('在 Harness 里问'), 'does not inject a floating ask button')

  const removed = await postJson('/ops-board/boards/remove', { id: boardB.id })
  assert(removed.status === 200 && removed.body.ok === true, 'removes board B from the registry')
  assert(!removed.body.state.boards.some((entry) => entry.id === boardB.id), 'board B is gone from state')

  await delay(400)
  const bPing = await fetch(`http://127.0.0.1:${entryB.port}/api/ping`).then(() => true).catch(() => false)
  assert(bPing === false, 'removing board B stops its server')
}

const legacy = await getJson('/ops-board/live/api/ping')
assert(legacy.status === 200 && legacy.body.app === 'ops-board', 'legacy /ops-board/live still serves the last board')

const sessions0 = await getJson('/ops-board/sessions')
assert(sessions0.status === 200 && typeof sessions0.body === 'object', 'GET /ops-board/sessions returns a map')
const savedSession = await postJson('/ops-board/sessions', { board: 'board-a', key: 'OPS-001', sessionId: 'sess-test-1' })
assert(
  savedSession.status === 200 && savedSession.body.sessions['board-a']['OPS-001'] === 'sess-test-1',
  'POST /ops-board/sessions stores the mapping',
)
const sessions1 = await getJson('/ops-board/sessions')
assert(sessions1.body['board-a']['OPS-001'] === 'sess-test-1', 'session mapping survives a subsequent read')
const clearedSession = await postJson('/ops-board/sessions', { board: 'board-a', key: 'OPS-001', sessionId: '' })
assert(!clearedSession.body.sessions['board-a'], 'POST /ops-board/sessions clears an empty mapping')

// SSE ask bus: a page subscribes, the board page POSTs a question, the frame arrives.
async function openEvents() {
  const abort = new AbortController()
  const response = await fetch(`${origin}/ops-board/events`, { signal: abort.signal })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const readUntil = async (predicate, timeoutMs = 2500) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        delay(Math.max(0, deadline - Date.now())).then(() => ({ timeout: true })),
      ])
      if (result.timeout) break
      if (result.done) break
      buffer += decoder.decode(result.value, { stream: true })
      if (predicate(buffer)) break
    }
    return buffer
  }
  return { readUntil, close: () => abort.abort() }
}

const events = await openEvents()
await events.readUntil((text) => text.includes('connected'))
const ask = await postJson('/ops-board/ask', {
  board: 'board-a',
  dir: boardDir,
  label: '看板 A',
  item: 'OPS-001',
  title: '测试条目',
  fresh: true,
  question: '这条台账还缺什么证据？',
})
assert(ask.status === 200 && ask.body.ok === true, 'POST /ops-board/ask publishes to a subscribed Harness page')
assert(ask.body.listeners >= 1, 'ask reports at least one subscriber')
const frame = await events.readUntil((text) => text.includes('这条台账还缺什么证据？'))
assert(frame.includes('"type":"ask"') && frame.includes('这条台账还缺什么证据？'), 'SSE frame carries the question')
assert(frame.includes('"item":"OPS-001"') && frame.includes('"title":"测试条目"'), 'SSE frame carries the item identity')
assert(frame.includes('"fresh":true'), 'SSE frame carries the new-session flag')

const onboard = await postJson('/ops-board/boards/create', {
  label: '接入测试',
  projectDir: boardDir,
  root: createRoot,
  generate: true,
})
assert(onboard.status === 200 && onboard.body.generating === true, 'create with generate publishes an onboarding ask')
const onboardFrame = await events.readUntil((text) => text.includes('新接入的项目'))
assert(
  onboardFrame.includes('"item":"__onboard__"') && onboardFrame.includes('生成项目报文'),
  'onboarding ask carries the board/item identity',
)

// 默认档是快速档：明确「只读、不跑构建、5~10 条骨架」，别让人第一次就等十几分钟
assert(onboard.body.mode === 'fast', 'default generation mode is fast: ' + onboard.body.mode)
assert(onboardFrame.includes('【快速档】'), 'onboarding prompt states the fast mode')
assert(onboardFrame.includes('不要跑构建'), 'fast mode forbids builds')
assert(onboardFrame.includes('MODE=fast'), 'onboarding prompt echoes the mode for the board to record')

// 探测：项目里有什么、没什么，必须在 prompt 里说清楚，别让 agent 在空地上编
assert(onboard.body.probe && typeof onboard.body.probe.kind === 'string', 'create returns the project probe')
assert(onboardFrame.includes('这个项目里有多少可依据的东西'), 'prompt carries the probe block')
assert(onboardFrame.includes('不要凭代码风格推测'), 'prompt forbids inventing the rationale')

// 实测档：允许跑构建、不设条目上限
const deep = await postJson('/ops-board/boards/create', {
  label: '实测档测试',
  projectDir: boardDir,
  root: createRoot,
  generate: true,
  mode: 'deep',
})
assert(deep.status === 200 && deep.body.mode === 'deep', 'accepts an explicit deep mode')
const deepFrame = await events.readUntil((text) => text.includes('【实测档】'))
assert(deepFrame.includes('可以跑构建'), 'deep mode allows builds')
assert(deepFrame.includes('MODE=deep'), 'deep prompt echoes the mode')
if (deep.body.board && deep.body.board.id) {
  await postJson('/ops-board/boards/remove', { id: deep.body.board.id })
}

// 探一个什么都没有的目录：要老实说「只能出骨架」
const bareDir = join(sandbox, 'bare-project')
mkdirSync(bareDir, { recursive: true })
const bareProbe = await postJson('/ops-board/boards/probe', { projectDir: bareDir })
assert(bareProbe.status === 200 && bareProbe.body.ok === true, 'probe route answers')
assert(bareProbe.body.probe.kind === 'empty', 'empty project is detected: ' + bareProbe.body.probe.kind)
assert(bareProbe.body.probe.signals.length === 0, 'empty project reports no signals')

if (onboard.body.board && onboard.body.board.id) {
  await postJson('/ops-board/boards/remove', { id: onboard.body.board.id })
}

events.close()
await delay(250)
const noListener = await postJson('/ops-board/ask', { question: '没人接的时候' })
assert(noListener.status === 200 && noListener.body.ok === false, 'ask without a subscriber reports ok=false')

const askDenied = await fetch(origin + '/ops-board/ask', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
  body: JSON.stringify({ question: 'x' }),
})
assert(askDenied.status === 403, 'cross-origin ask is rejected')

const unknown = await getJson('/ops-board/nope')
assert(unknown.status === 404, 'unknown route returns 404')

const denied = await fetch(origin + '/ops-board/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
  body: '{}',
})
assert(denied.status === 403, 'cross-origin start is rejected')

const portA = state.boards[0].port
for (const cleanup of cleanups) {
  if (typeof cleanup === 'function') cleanup()
}
await delay(500)
await new Promise((resolve) => server.close(resolve))

const aPing = await fetch(`http://127.0.0.1:${portA}/api/ping`).then(() => true).catch(() => false)
assert(aPing === false, 'dispose stops the board server it started')

if (failures.length) {
  console.error(`\nhost smoke: FAIL (${failures.length})`)
  console.error(logs.join('\n'))
  process.exit(1)
}
console.log('\nhost smoke: PASS')
