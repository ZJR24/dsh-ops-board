/**
 * Client-half smoke test: load the hand-written bundle in a fake browser,
 * run apply(), and assert the main panel + sidebar entries register.
 *
 *   node test/client-smoke.mjs
 *
 * It deliberately does not need a React install: a tiny hook stub is enough to
 * call the panel function once and inspect the element tree it returns.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(Infinity) }
}

const React = {
  createElement,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
}

const styles = []
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => styles.push(tag) },
}

let loaded = null
const sources = []
class FakeEventSource {
  constructor(url) {
    this.url = url
    this.closed = false
    this.onmessage = null
    sources.push(this)
  }
  close() {
    this.closed = true
  }
}

const windowListeners = new Map()
const windowStub = {
  __ModuleLoader__: {
    load: (entry) => {
      loaded = entry
    },
  },
  addEventListener: (type, handler) => windowListeners.set(type, handler),
  removeEventListener: (type) => windowListeners.delete(type),
  location: { origin: 'http://127.0.0.1:9488' },
}

const sessionMap = {}
const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  EventSource: FakeEventSource,
  fetch: async (url, options = {}) => {
    if (String(url).indexOf('/ops-board/sessions') === 0) {
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        sessionMap[body.board] = sessionMap[body.board] || {}
        sessionMap[body.board][body.key] = body.sessionId
        return { json: async () => ({ ok: true }) }
      }
      return { json: async () => sessionMap }
    }
    throw new Error('unexpected fetch: ' + url)
  },
  setTimeout,
  clearTimeout,
  console,
})
vm.runInContext(readFileSync(join(root, 'client.js'), 'utf8'), context, { filename: 'client.js' })

const fail = (message) => {
  console.error('FAIL:', message)
  process.exitCode = 1
}
const ok = (message) => console.log('ok  ', message)

if (!loaded || loaded.id !== 'dsh-ops-board') fail('module id is not dsh-ops-board: ' + JSON.stringify(loaded?.id))
else ok('module registers under dsh-ops-board')

const exportsObject = loaded.factory((spec) => {
  if (spec === 'react') return React
  throw new Error('unexpected require: ' + spec)
})

const registered = []
const cleanups = []
const injectedSlots = []
const localeDictionaries = []

const asked = []
const createdWorkspaces = []
const createdSessions = []
const openedSessions = []
const sentPrompts = []
const renamedSessions = []
const uiWorkspace = {
  workspaces: {
    list: {
      getSnapshot: () => ({ items: [{ workspaceId: 'ws-board', path: 'D:\\WorkSpace-Tools\\ops-board' }] }),
    },
    create: async ({ path }) => {
      createdWorkspaces.push(path)
      return { workspaceId: 'ws-created', path }
    },
  },
  startSession: (id, options) => {
    asked.push({ id, options })
  },
  openSession: (id) => {
    openedSessions.push(id)
  },
  pickDirectory: async () => 'D:\\picked-directory',
}

const sessions = {
  list: {
    getSnapshot: () => ({ byId: { 'sess-1': {} } }),
  },
  create: async ({ workspaceId }) => {
    createdSessions.push(workspaceId)
    return 'sess-1'
  },
  binding: (id) =>
    id === 'sess-1'
      ? {
          session: {
            rename: async (title) => {
              renamedSessions.push(title)
              return { ok: true }
            },
            prompt: async (content, mode) => {
              sentPrompts.push({ content, mode })
              return { ok: true }
            },
          },
        }
      : undefined,
}

const ctx = {
  effect: (fn) => {
    cleanups.push(fn())
  },
  get: (name) => {
    if (name === 'uiWorkspace') return uiWorkspace
    if (name === 'sessions') return sessions
    return undefined
  },
  locale: {
    bind: () => (key) => key,
    register: (namespace, dictionaries) => {
      localeDictionaries.push({ namespace, dictionaries })
      return () => {}
    },
  },
  slots: {
    inject: (slot, factory) => {
      injectedSlots.push(slot)
      factory()
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
}

exportsObject.apply(ctx)

if (exportsObject.name !== 'dsh-ops-board') fail('exports.name mismatch')
else ok('exports.name is dsh-ops-board')

const expected = ['slots', 'locale', 'layout', 'sessions']
if (JSON.stringify(exportsObject.inject) !== JSON.stringify(expected)) fail('exports.inject mismatch: ' + JSON.stringify(exportsObject.inject))
else ok('exports.inject = slots, locale, layout, sessions')

if (localeDictionaries.length !== 1 || !localeDictionaries[0].dictionaries.zh || !localeDictionaries[0].dictionaries.en) {
  fail('locale dictionaries not registered')
} else ok('zh/en dictionaries registered')

if (!injectedSlots.includes('main') || !injectedSlots.includes('sidebar.panellist')) {
  fail('slots not injected: ' + JSON.stringify(injectedSlots))
} else ok('injects main + sidebar.panellist')

const main = registered.find((entry) => entry.options.name === 'main')
const icon = registered.find((entry) => entry.options.name === 'sidebar.panellist')
if (!main || main.options.key !== 'ops-board') fail('main panel not registered with key ops-board')
else ok('main panel registered with key ops-board')
if (!icon || icon.options.id !== 'ops-board' || icon.options.order !== 40) fail('sidebar entry not registered')
else ok('sidebar entry registered (id ops-board, order 40)')

// 面板与侧栏都叫「项目看板」（不是「工作台」）
const zhDict = localeDictionaries[0] && localeDictionaries[0].dictionaries.zh
const enDict = localeDictionaries[0] && localeDictionaries[0].dictionaries.en
if (!zhDict || zhDict.panel !== '项目看板' || zhDict.title !== '项目看板') {
  fail('zh 字典里 panel/title 应为「项目看板」，实际 ' + JSON.stringify(zhDict && { panel: zhDict.panel, title: zhDict.title }))
} else if (zhDict && /工作台/.test(JSON.stringify(zhDict))) {
  fail('字典里还留着「工作台」字样')
} else {
  ok('panel and sidebar are labelled 项目看板')
}
if (!enDict || !enDict.panel) fail('en 字典缺 panel')
else ok('en dictionary still has panel/title')

function classesOf(node, found = []) {
  if (!node || typeof node !== 'object') return found
  const className = node.props && node.props.className
  if (typeof className === 'string') found.push(className)
  for (const child of node.children || []) classesOf(child, found)
  return found
}

if (typeof main.component === 'function') {
  try {
    const tree = main.component({ t: (key) => key })
    const classes = classesOf(tree)
    if (!classes.includes('ob-root') || !classes.includes('ob-bar')) {
      fail('panel did not render its shell: ' + JSON.stringify(classes))
    } else {
      ok('panel renders shell markup (' + classes.join(' ') + ')')
    }
  } catch (error) {
    fail('panel render threw: ' + (error && error.stack ? error.stack : error))
  }
}

if (typeof icon.component === 'function') {
  const glyph = icon.component({ size: 18 })
  if (!glyph || glyph.type !== 'svg') fail('sidebar icon did not render an svg')
  else ok('sidebar icon renders an svg')
}

if (styles.length !== 1) fail('expected one style tag, got ' + styles.length)
else ok('stylesheet injected once')

if (sources.length !== 1) fail('ask bridge did not open an SSE channel, got ' + sources.length)
else if (sources[0].url !== '/ops-board/events') fail('ask bridge SSE url mismatch: ' + sources[0].url)
else ok('ask bridge subscribes to /ops-board/events')

if (typeof windowListeners.get('message') !== 'function') fail('ask bridge postMessage fallback not registered')
else ok('ask bridge postMessage fallback registered')

async function testAskBridge() {
  const source = sources[0]

  source.onmessage({ data: '{not json' })
  source.onmessage({ data: JSON.stringify({ type: 'other' }) })
  await new Promise((resolve) => setTimeout(resolve, 5))
  if (asked.length !== 0) fail('ask bridge reacted to a non-ask frame')
  else ok('ask bridge ignores non-ask frames')

  source.onmessage({
    data: JSON.stringify({
      type: 'ask',
      board: 'sample-board',
      dir: 'D:\\WorkSpace-Tools\\ops-board',
      label: '项目报告',
      item: 'OPS-030',
      title: '项目榜定时任务',
      question: '这轮还剩什么没验证？',
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (createdSessions.length !== 1 || createdSessions[0] !== 'ws-board') {
    fail('ask bridge did not create a session in the matching workspace: ' + JSON.stringify(createdSessions))
  } else if (openedSessions[0] !== 'sess-1') {
    fail('ask bridge did not open the created session: ' + JSON.stringify(openedSessions))
  } else if (sentPrompts.length !== 1 || !String(sentPrompts[0].content[0].text).includes('这轮还剩什么没验证？')) {
    fail('ask bridge did not auto-send the question: ' + JSON.stringify(sentPrompts))
  } else if (sentPrompts[0].mode !== 'queue') {
    fail('ask bridge used the wrong prompt mode: ' + sentPrompts[0].mode)
  } else if (!String(renamedSessions[0] || '').includes('OPS-030')) {
    fail('ask bridge did not title the new session: ' + JSON.stringify(renamedSessions))
  } else {
    ok('ask bridge creates a session, titles it, opens it, and auto-sends the question')
  }

  source.onmessage({
    data: JSON.stringify({
      type: 'ask',
      board: 'sample-board',
      dir: 'D:\\WorkSpace-Tools\\ops-board',
      label: '项目报告',
      item: 'OPS-030',
      title: '项目榜定时任务',
      question: '再问一次',
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (createdSessions.length !== 1 || sentPrompts.length !== 2 || renamedSessions.length !== 1) {
    fail(
      'ask bridge did not reuse the same session for the same item: ' +
        JSON.stringify({ createdSessions, sentPrompts: sentPrompts.length, renamedSessions }),
    )
  } else {
    ok('ask bridge reuses the same session for the same item')
  }

  source.onmessage({
    data: JSON.stringify({
      type: 'ask',
      board: 'other',
      dir: 'D:\\WorkSpace-Tools\\other-board',
      label: '其它看板',
      item: 'OPS-999',
      title: '别的条目',
      question: '看一下',
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (createdWorkspaces.length !== 1 || createdSessions[1] !== 'ws-created') {
    fail('ask bridge did not create a workspace for an unknown board dir: ' + JSON.stringify({ createdWorkspaces, createdSessions }))
  } else ok('ask bridge creates a workspace when the board dir is not a workspace yet')

  source.onmessage({
    data: JSON.stringify({
      type: 'ask',
      board: 'sample-board',
      dir: 'D:\\WorkSpace-Tools\\ops-board',
      label: '项目报告',
      item: 'OPS-030',
      title: '项目榜定时任务',
      fresh: true,
      question: '新开一个会话再问',
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (createdSessions.length !== 3 || createdSessions[2] !== 'ws-board' || sentPrompts.length !== 4) {
    fail(
      'ask bridge did not start a new session when fresh was requested: ' +
        JSON.stringify({ createdSessions, sentPrompts: sentPrompts.length }),
    )
  } else {
    ok('ask bridge starts a new session when fresh is requested')
  }

  source.onmessage({
    data: JSON.stringify({
      type: 'ask',
      board: 'sample-board',
      dir: 'D:\\WorkSpace-Tools\\ops-board',
      label: '项目报告',
      item: '__onboard__',
      title: '生成项目报文',
      sessionTitle: '项目报告 · 生成项目报文',
      question: '生成一份台账',
    }),
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (
    createdSessions.length !== 4 ||
    sentPrompts.length !== 5 ||
    renamedSessions[3] !== '项目报告 · 生成项目报文'
  ) {
    fail(
      'ask bridge did not honor the custom session title: ' +
        JSON.stringify({ createdSessions, sentPrompts: sentPrompts.length, renamedSessions }),
    )
  } else {
    ok('ask bridge honors a custom session title')
  }

  const injected = main.options.inject()
  const picked = await injected.pickDirectory()
  if (picked !== 'D:\\picked-directory') fail('pickDirectory helper did not forward to uiWorkspace: ' + picked)
  else ok('pickDirectory helper forwards to uiWorkspace.pickDirectory')
}

await testAskBridge()

for (const cleanup of cleanups) if (typeof cleanup === 'function') cleanup()

if (!sources[0].closed) fail('ask bridge SSE channel was not closed on cleanup')
else ok('ask bridge SSE channel closed on cleanup')

if (windowListeners.get('message') !== undefined) fail('postMessage fallback listener was not removed on cleanup')
else ok('postMessage fallback listener cleaned up')

// 两档生成 + 探测：前端必须把档位传上去、把探测结果摊开
const clientSrc = readFileSync(join(root, 'client.js'), 'utf8')
if (!clientSrc.includes("const PROBE_URL = '/ops-board/boards/probe'")) {
  fail('client does not know the probe route')
} else ok('client probes the project before generating')
if (!/mode:\s*genMode/.test(clientSrc)) fail('client does not send the generation mode')
else ok('client sends the generation mode')
if (!clientSrc.includes("useState('fast')")) fail('fast mode is not the default')
else ok('fast mode is the default')
for (const needle of ['genModeFast', 'genModeDeep', 'ob-modes', 'ob-probe']) {
  if (!clientSrc.includes(needle)) fail('create dialog is missing ' + needle)
}
ok('create dialog offers both modes and shows the probe result')

if (!process.exitCode) console.log('\nclient smoke: PASS')
