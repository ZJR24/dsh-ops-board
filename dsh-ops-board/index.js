/**
 * dsh-ops-board — host half (multi-board).
 *
 * One plugin, many project reports. Each entry in the board registry is an
 * ops-board checkout (ledger.json + board.config.json + scripts/serve.mjs);
 * every board gets its own local server on a private port, and the Harness
 * origin exposes a stable proxy namespace per board:
 *
 *   GET  /ops-board/state                  → registry + per-board status
 *   POST /ops-board/start                  → { board } ensure that server
 *   POST /ops-board/boards                 → { label, dir } add an existing checkout
 *   POST /ops-board/boards/probe          → { projectDir } what the project actually records
 *   POST /ops-board/boards/create          → { label?, projectDir?, root, mode? } scaffold a board
 *   POST /ops-board/boards/remove          → { id } remove from the registry
 *   POST /ops-board/ask                    → hand a question to every open Harness page
 *   GET  /ops-board/events                 → SSE ask bus
 *   ANY  /ops-board/b/<id>/*               → proxy to that board's server
 *   ANY  /ops-board/live/*                 → proxy to the last selected board (legacy)
 *
 * The board page is served through the proxy so the iframe is same-origin and
 * its `/api/*` calls are rewritten (by a shim injected into the HTML) to the
 * board prefix. The shim also sets `window.__OPS_HARNESS__ = {id,label,dir,projectDir}`:
 * in that mode the board's own per-item / global "问 AI" buttons post to
 * /ops-board/ask and the Client half turns that into a real Harness session
 * (created, opened and auto-sent).
 *
 * There is no second path: the template has no page-side model client at all
 * (no key, no provider, no endpoint). /ops-board/ask is the only way out, and
 * `verify-board.mjs` fails the build if any cloud-AI leftovers come back.
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-ops-board'
export const inject = ['webServer']

export const Config = Schema.object({
  /** Legacy single-board directory; only used when `boards` is empty. */
  boardDir: Schema.string().default(''),
  /** Declarative board list: [{ id?, label?, dir }]. Merged into the registry. */
  boards: Schema.array(
    Schema.object({
      id: Schema.string().default(''),
      label: Schema.string().default(''),
      dir: Schema.string().default(''),
    }),
  ).default([]),
  /** First port to try; further boards use an OS-assigned free port. */
  port: Schema.number().default(8790),
  /** Start the first/last board with Harness. */
  autoStart: Schema.boolean().default(true),
  /** How many board servers may run at once (least recently used are stopped). */
  maxRunning: Schema.number().default(2),
  /** Registry override (tests / multi-instance). */
  registryFile: Schema.string().default(''),
  /** Board checkout used as the scaffold template for new boards. Empty = first registered board. */
  templateDir: Schema.string().default(''),
  /** Default root under which "create board" creates <project> folders. */
  defaultCreateRoot: Schema.string().default(''),
  /** node executable; empty = managed node, then Electron Node mode. */
  nodePath: Schema.string().default(''),
  /** Keep plugin-owned board servers alive after Harness exits. */
  keepRunningOnExit: Schema.boolean().default(false),
})

const ROUTE = '/ops-board'
const LIVE = '/ops-board/live'
const BOARD_PREFIX = '/ops-board/b'
const PING_TIMEOUT_MS = 1200
const START_TIMEOUT_MS = 25000
const STATE_TTL_MS = 800
const LOG_LINES = 40
const MAX_BODY = 2 * 1024 * 1024

/* ─────────────────────────── tiny HTTP helpers ─────────────────────────── */

function sendJson(res, code, body) {
  const data = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': data.length,
  })
  res.end(data)
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sameOrigin(req) {
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 探一下这个项目里「能当依据的东西」有多少。
 * 目的不是给 agent 更多活干，而是给它一个诚实的输入范围：
 * 有历史就直说能挖到什么，没有就直说只能出骨架 —— 别在空地上编证据。
 */
function probeProject(projectDir) {
  const dir = String(projectDir || '').trim()
  if (!dir || !existsSync(dir)) {
    return { dir: '', kind: 'missing', ready: false, signals: [], note: '没有指定项目目录，只能按看板里的现有数据出骨架。' }
  }

  const signals = []
  let commits = 0
  let commitHits = 0

  // git：有提交历史才有「当时改了什么、为什么」可挖
  if (existsSync(join(dir, '.git'))) {
    try {
      const log = execFileSync('git', ['-C', dir, 'log', '--oneline', '-n', '400'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      })
      const lines = log.split('\n').filter(Boolean)
      commits = lines.length
      commitHits = lines.filter((l) => /修|改|补|问题|bug|fix|错|优化|回滚|revert/i.test(l)).length
      signals.push({ key: 'git', label: `git 历史 ${commits} 个 commit（${commitHits} 条提到修/改/问题）` })
    } catch {
      signals.push({ key: 'git', label: '有 .git，但读不到提交历史' })
    }
  }

  // 现成文档：有就是现成依据，优先级最高
  const docs = ['docs/ops/issues.json', 'docs/ops', 'docs', 'README.md', 'README']
  for (const rel of docs) {
    const p = join(dir, rel)
    if (existsSync(p)) {
      signals.push({ key: 'doc:' + rel, label: `有 ${rel}` })
    }
  }

  // 构建方式：决定「实测档」能不能跑
  const builds = [
    ['package.json', 'npm / node'],
    ['pom.xml', 'maven'],
    ['build.gradle', 'gradle'],
    ['build.gradle.kts', 'gradle'],
    ['build.xml', 'ant'],
    ['Cargo.toml', 'cargo'],
    ['go.mod', 'go'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['project.config.json', '微信小程序'],
  ]
  for (const [file, kind] of builds) {
    if (existsSync(join(dir, file))) {
      signals.push({ key: 'build:' + kind, label: `构建方式：${kind}（${file}）`, build: kind })
    }
  }

  const hasDoc = signals.some((s) => s.key.startsWith('doc:'))
  const hasBuild = signals.some((s) => s.build)

  let kind = 'empty'
  let note = ''
  if (hasDoc && commits > 0) {
    kind = 'rich'
    note = '这个项目有现成文档和提交历史，能挖到真实的「为什么」和「怎么验的」。'
  } else if (commits >= 20) {
    kind = 'history'
    note = `这个项目有 ${commits} 个 commit 但没有现成文档，可以从提交历史里挖出改过什么，但「为什么」多半要推断。`
  } else if (hasDoc || hasBuild) {
    kind = 'thin'
    note = '这个项目只有结构没有历史记录，能看出「有哪些东西」，看不出「为什么这么做、当时怎么验的」。'
  } else {
    note = '这个项目里几乎没有可依据的记录（没 git、没文档、没构建配置），只能按代码结构出骨架，每条都要标「待核实」。'
  }

  return {
    dir,
    kind,
    commits,
    commitHits,
    hasDoc,
    hasBuild,
    signals: signals.map((s) => s.label),
    note,
  }
}

/** 把探测结果写成给 agent 看的一段话：有什么、没有什么、别编。 */
function probeBlock(probe) {
  const lines = ['', '【这个项目里有多少可依据的东西】']
  if (!probe.signals.length) {
    lines.push('- 没找到 git 历史、文档或构建配置。')
  } else {
    for (const s of probe.signals) lines.push('- ' + s)
  }
  lines.push('', probe.note, '', '硬要求：')
  lines.push('- 上表没有的东西就是没有。不要凭代码风格推测「当初为什么这么做」。')
  lines.push('- 每条 items 的 evidence 只能是上面能指到的东西（文件、commit、配置、文档原文）；指不到的写「待核实：需要 XX 才能确认」，不要编。')
  lines.push('- 宁可少写几条真的，也不要凑数量。')
  return lines.join('\n')
}

/** 第一版报文的生成档位：fast（只读，出骨架）/ deep（跑构建跑测试，带硬证据）。 */
const GEN_MODES = {
  fast: {
    label: '快速档',
    intro: [
      '【快速档】目标是让你在 1 分钟内看到成品长什么样，不是一次到位。',
      '- 只读文件，不要跑构建、不要跑测试、不要跑任何会改变项目状态的命令。',
      '- 控制在 5~10 条 items，优先用现成文档；没有文档就按目录结构和入口文件列出「这个项目在做什么」。',
      '- 每条 evidence 写「待核实 + 需要看什么才能确认」，并说明这是快速档的骨架。',
    ],
  },
  deep: {
    label: '实测档',
    intro: [
      '【实测档】目标是产出带硬证据的台账，允许慢。',
      '- 可以跑构建 / 测试 / 只读的排查命令来拿真实证据；不要修改项目源码。',
      '- 条目数量按项目实际情况，不设上限。',
      '- 每条 evidence 要能落到具体命令输出、文件行、commit 或线上实测值。',
    ],
  },
}

/** First-pass prompt sent by the Host after a board is created for a project. */
function onboardingQuestion(entry, projectDir, mode = 'fast') {
  const probe = probeProject(projectDir)
  const gen = GEN_MODES[mode] || GEN_MODES.fast
  return [
    `新接入的项目：${projectDir || '（未指定项目目录）'}`,
    `看板目录：${entry.dir}`,
    '',
    probeBlock(probe),
    '',
    '【这次用哪个档】',
    ...gen.intro,
    '',
    '请先读看板里的 ledger.json、board.config.json，再按上面的范围读项目里真正有的东西。',
    '然后按 ledger.json 的原 schema 生成台账：',
    '{project:{name,subtitle,slug},updatedAt,headline,deck,conclusion,highlights:[{kind,text}],metrics:[{label,value,status,note}],snapshot:{},items:[{id,lane,title,status,severity,area,sections:[{label,text}],evidence:[{kind,text}],updatedAt}],history:[{at,kind,text}]}',
    '',
    '要求：',
    '- headline / deck / conclusion / highlights / metrics / snapshot 都要有内容；',
    '- metrics[].status 只能取 board.config.json 的 metricStatuses 里列出的值（默认 ok / warn / danger / muted）；写了表外的值渲染会没配色，自检会拦下来；',
    '- items 从项目事实里来（问题 / 需求 / 风险），每条要有四段 sections 和 evidence；',
    '- 生成完在最后一行输出 `MODE=' + mode + '`，方便看板记下这次用的是哪档；',
    '- history 追加一条本次生成记录（写明档位），updatedAt 用 ISO 8601（+08:00）；',
    '- 不要修改项目源码；把结果写回看板目录的 ledger.json；',
    '- 写完后在看板目录里依次跑 `node scripts/render.mjs` 和 `node scripts/verify-board.mjs` 确认能渲染，并说明改了哪些文件、生成了多少条。',
  ].join('\n')
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

function uniqueId(base, taken) {
  let id = base || 'board'
  if (!taken.has(id)) return id
  let index = 2
  while (taken.has(`${id}-${index}`)) index += 1
  return `${id}-${index}`
}

/* ───────────────────────────── ledger helpers ───────────────────────────── */

function readLedgerMeta(dir) {
  try {
    const ledger = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'))
    const project = ledger?.project ?? {}
    return {
      slug: typeof project.slug === 'string' ? project.slug : '',
      name: typeof project.name === 'string' ? project.name : '',
      subtitle: typeof project.subtitle === 'string' ? project.subtitle : '',
      updatedAt: typeof ledger?.updatedAt === 'string' ? ledger.updatedAt : '',
      items: Array.isArray(ledger?.items) ? ledger.items.length : 0,
      history: Array.isArray(ledger?.history) ? ledger.history.length : 0,
    }
  } catch {
    return null
  }
}

/**
 * 新建看板时要放进去的转发入口：文件名即转发目标，内容完全一样。
 *
 * 口径是「模板里有哪个脚本，看板里就有哪个入口」，而不是手写一份名单 ——
 * 手写的名单迟早和模板对不上：package.json 声明了 `ask` 和 `uitest:offline`，
 * 入口却没建，跑起来就是 Cannot find module。
 *
 * 也不能只从 package.json 的 scripts 推导：collect-skills.mjs 不在 scripts 里，
 * 但 serve.mjs 会调它刷新 skill 统计，少了它 Skill 页就一直是空的。
 */
function entryScriptNames(template) {
  const dir = join(template, 'scripts')
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.mjs') && f !== 'entry.mjs')
    .sort()
}

/**
 * 转发入口的源码。
 * 项目里只放数据，脚本从模板读；这个文件负责把调用转给模板里的同名脚本。
 * 优先复用模板里的 scripts/entry.mjs，保证入口逻辑也只有一份。
 */
function templateEntrySource(template) {
  const own = join(template, 'scripts', 'entry.mjs')
  if (existsSync(own)) return readFileSync(own, 'utf8')
  throw new Error(`模板缺少 scripts/entry.mjs：${own}`)
}

/**
 * 补齐一块看板缺的转发入口。
 *
 * 老看板是在 ENTRY_SCRIPTS 还是手写名单时建的，所以可能少了后来才加进
 * package.json 的那几个（ask / offline-test）。启动前补一次，用户不用重装。
 * 只补缺失的，已有文件一个字节都不动。
 */
function ensureEntryScripts(boardDir, template) {
  const scripts = join(boardDir, 'scripts')
  if (!existsSync(scripts)) return []
  let source
  try {
    source = templateEntrySource(template)
  } catch {
    return []
  }
  const added = []
  for (const name of entryScriptNames(template)) {
    const target = join(scripts, name)
    if (existsSync(target)) continue
    try {
      writeFileSync(target, source, 'utf8')
      added.push(name)
    } catch {}
  }
  return added
}

/** Infer a new board's name/subtitle from an optional project directory. */
function readProjectSeed(projectDir) {
  const seed = { name: '', subtitle: '', slug: '' }
  const raw = String(projectDir || '').trim()
  if (!raw) return seed
  const dir = resolve(raw)
  const base = basename(dir)
  seed.slug = slugify(base)
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (typeof pkg.description === 'string' && pkg.description.trim()) {
      seed.subtitle = pkg.description.trim()
    }
  } catch {}
  try {
    const readme = readFileSync(join(dir, 'README.md'), 'utf8').slice(0, 4000)
    const heading = readme.match(/^#\s+(.+)$/m)
    if (heading) {
      const text = heading[1].trim()
      if (text && text.length <= 60) seed.name = text
    }
  } catch {}
  if (!seed.name && seed.subtitle) seed.name = seed.subtitle
  if (!seed.name) seed.name = base
  if (!seed.subtitle) seed.subtitle = '项目工作报文'
  return seed
}

/* ───────────────────────────── port helpers ────────────────────────────── */

function portFree(port) {
  return new Promise((resolveFree) => {
    const server = createNetServer()
    server.once('error', () => resolveFree(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolveFree(true))
    })
  })
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

/* ───────────────────────────── board entry ────────────────────────────── */

class BoardEntry {
  constructor({ id, label, dir, projectDir }, owner) {
    this.id = id
    this.label = label || id
    this.dir = dir
    this.projectDir = String(projectDir || '').trim()
    this.owner = owner
    this.child = null
    this.port = 0
    this.ready = false
    this.starting = null
    this.error = ''
    this.log = []
    this.lastUsed = 0
    this.stateAt = 0
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}/` : ''
  }

  toJSON() {
    return { id: this.id, label: this.label, dir: this.dir, projectDir: this.projectDir || '' }
  }

  configured() {
    return (
      existsSync(this.dir) &&
      existsSync(join(this.dir, 'ledger.json')) &&
      existsSync(join(this.dir, 'scripts', 'serve.mjs'))
    )
  }

  pushLog(chunk) {
    const text = String(chunk || '').replace(/\r/g, '')
    for (const line of text.split('\n')) {
      if (line.trim()) this.log.push(line)
    }
    if (this.log.length > LOG_LINES) this.log.splice(0, this.log.length - LOG_LINES)
  }

  logTail() {
    return this.log.join('\n')
  }

  async probe() {
    if (!this.port) return false
    try {
      const response = await fetch(`${this.url}api/ping`, {
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return false
      const body = await response.json().catch(() => null)
      this.ready = Boolean(body && body.app === 'ops-board')
      return this.ready
    } catch {
      this.ready = false
      return false
    }
  }

  async refreshReady() {
    const now = Date.now()
    if (now - this.stateAt < STATE_TTL_MS) return this.ready
    const ready = await this.probe()
    this.stateAt = Date.now()
    return ready
  }

  async state() {
    const ready = await this.refreshReady()
    const meta = readLedgerMeta(this.dir)
    return {
      id: this.id,
      label: this.label,
      dir: this.dir,
      projectDir: this.projectDir || '',
      configured: this.configured(),
      ready,
      starting: Boolean(this.starting),
      port: this.port || 0,
      url: this.url,
      proxy: `${BOARD_PREFIX}/${this.id}/`,
      project: meta,
      error: ready ? '' : this.error,
      owned: Boolean(this.child && this.child.exitCode === null),
      ledgerAt: mtimeOf(join(this.dir, 'ledger.json')),
      log: ready ? '' : this.logTail(),
    }
  }

  dispose() {
    const child = this.child
    this.child = null
    this.ready = false
    // keepRunning true = leave the server alone on Harness exit.
    if (!child || this.owner.keepRunning) return
    try {
      child.kill()
    } catch {}
  }
}

/* ───────────────────────────── controller ─────────────────────────────── */

class BoardController {
  constructor(config = {}, logger) {
    this.config = config || {}
    this.logger = logger
    this.boards = new Map()
    this.order = []
    this.last = ''
    this.lastCreateDir = ''
    this.keepRunning = Boolean(this.config.keepRunningOnExit)
    this.registryFile =
      String(this.config.registryFile || '').trim() ||
      join(homedir(), '.dsh', 'ops-board', 'boards.json')
    this.sessionFile = join(dirname(this.registryFile), 'sessions.json')
    this.disposed = false
  }

  /* registry -------------------------------------------------------------- */

  load() {
    const saved = readJson(this.registryFile)
    const savedBoards = Array.isArray(saved?.boards) ? saved.boards : []
    for (const entry of savedBoards) this.upsert(entry, { persist: false, replaceLabel: false })
    for (const entry of this.config.boards || []) this.upsert(entry, { persist: false, replaceLabel: true })
    if (this.order.length === 0 && this.config.boardDir) {
      this.upsert({ dir: this.config.boardDir }, { persist: false, replaceLabel: true })
    }
    this.last = saved?.last && this.boards.has(saved.last) ? saved.last : this.order[0] || ''
    this.lastCreateDir = typeof saved?.lastCreateDir === 'string' ? saved.lastCreateDir : ''
    this.save()
  }

  upsert(input, { persist = true, replaceLabel = true } = {}) {
    const rawDir = String(input?.dir || '').trim()
    if (!rawDir) return null
    const dir = resolve(rawDir)
    const existing = [...this.boards.values()].find(
      (entry) => entry.dir.toLowerCase() === dir.toLowerCase(),
    )
    if (existing) {
      if (replaceLabel && input.label) existing.label = String(input.label)
      if (input.projectDir) existing.projectDir = resolve(String(input.projectDir))
      return existing
    }
    const meta = readLedgerMeta(dir)
    const baseId = slugify(input.id) || slugify(meta?.slug) || slugify(basename(dir)) || 'board'
    const id = uniqueId(baseId, new Set(this.boards.keys()))
    const entry = new BoardEntry(
      {
        id,
        label: String(input.label || '').trim() || meta?.name || basename(dir),
        dir,
        projectDir: input.projectDir || '',
      },
      this,
    )
    this.boards.set(id, entry)
    this.order.push(id)
    if (persist) this.save()
    return entry
  }

  remove(id) {
    const entry = this.boards.get(id)
    if (!entry) return false
    entry.dispose()
    this.boards.delete(id)
    this.order = this.order.filter((value) => value !== id)
    if (this.last === id) this.last = this.order[0] || ''
    this.save()
    return true
  }

  save() {
    try {
      mkdirSync(dirname(this.registryFile), { recursive: true })
      const temp = `${this.registryFile}.tmp`
      const data = {
        version: 1,
        last: this.last,
        lastCreateDir: this.lastCreateDir,
        boards: this.order.map((id) => this.boards.get(id)?.toJSON()).filter(Boolean),
      }
      writeFileSync(temp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(temp, this.registryFile)
    } catch (error) {
      this.logger?.warn?.(`dsh-ops-board: 写注册表失败 ${String(error?.message || error)}`)
    }
  }

  touch(id) {
    const entry = this.boards.get(id)
    if (!entry) return
    entry.lastUsed = Date.now()
    if (this.last !== id) {
      this.last = id
      this.save()
    }
  }

  /* session mapping ------------------------------------------------------- */

  /**
   * Per board + per item (or `__global__`) Harness session id. Persisted next
   * to the registry so the port changing between app starts does not lose it
   * (localStorage is origin+port scoped). A missing/removed session id simply
   * means the next ask creates a fresh conversation.
   */
  readSessionMap() {
    const data = readJson(this.sessionFile)
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  }

  writeSessionMap(map) {
    try {
      mkdirSync(dirname(this.sessionFile), { recursive: true })
      const temp = `${this.sessionFile}.tmp`
      writeFileSync(temp, JSON.stringify(map, null, 2), 'utf8')
      renameSync(temp, this.sessionFile)
    } catch (error) {
      this.logger?.warn?.(`dsh-ops-board: 写会话映射失败 ${String(error?.message || error)}`)
    }
  }

  setSession(board, key, sessionId) {
    const map = this.readSessionMap()
    const boardId = String(board || '').trim()
    const itemKey = String(key || '').trim()
    if (!boardId || !itemKey) return map
    if (!map[boardId]) map[boardId] = {}
    if (sessionId) map[boardId][itemKey] = String(sessionId)
    else delete map[boardId][itemKey]
    if (Object.keys(map[boardId]).length === 0) delete map[boardId]
    this.writeSessionMap(map)
    return map
  }

  /* lifecycle ------------------------------------------------------------- */

  nodeCommand() {
    const explicit = String(this.config.nodePath || '').trim()
    if (explicit) return { file: explicit, useElectron: false }
    const managed = join(
      homedir(),
      '.dsh',
      'dsh-runtimes',
      'dsh-primary-runtime',
      'dependencies',
      'node',
      'bin',
      process.platform === 'win32' ? 'node.exe' : 'node',
    )
    if (existsSync(managed)) return { file: managed, useElectron: false }
    if (process.versions?.electron) return { file: process.execPath, useElectron: true }
    return { file: process.execPath, useElectron: false }
  }

  async ensure(id) {
    const entry = this.boards.get(id)
    if (!entry) throw new Error(`没有这个看板：${id}`)
    if (entry.starting) return entry.starting
    entry.starting = this.startEntry(entry).finally(() => {
      entry.starting = null
      entry.stateAt = 0
    })
    return entry.starting
  }

  async startEntry(entry) {
    // 老看板可能缺后来才加进模板的转发入口（ask / offline-test），
    // 于是在那块板里跑 `npm run ask` 会报 Cannot find module。
    // 补一次，而且必须放在最前面 —— 服务已经在跑时会走下面那条
    // 提前返回的捷径，补入口就被跳过了。
    const filled = ensureEntryScripts(entry.dir, this.templateDir())
    if (filled.length) {
      entry.pushLog(`补上缺失的转发入口：${filled.join(', ')}`)
      this.logger?.info?.(`dsh-ops-board: ${entry.id} 补上 ${filled.join(', ')}`)
    }
    if (entry.port && (await entry.probe())) {
      this.touch(entry.id)
      return true
    }
    if (!entry.configured()) {
      entry.error = `目录里缺少 ledger.json 或 scripts/serve.mjs：${entry.dir}`
      return false
    }
    // A live child that is not answering yet: wait for the one we already have
    // instead of spawning a second server on another port.
    if (entry.child && entry.child.exitCode === null) {
      return this.waitReady(entry, 10000)
    }
    if (!this.disposed) {
      // keep the first board on the familiar port when it is free
      const preferred = this.order[0] === entry.id ? Number(this.config.port) || 0 : 0
      entry.port = preferred && (await portFree(preferred)) ? preferred : await freePort()
    }
    entry.error = ''
    entry.log = []
    const node = this.nodeCommand()
    const script = join(entry.dir, 'scripts', 'serve.mjs')
    const env = { ...process.env }
    if (node.useElectron) env.ELECTRON_RUN_AS_NODE = '1'

    try {
      const child = spawn(node.file, [script, String(entry.port)], {
        cwd: entry.dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      entry.child = child
      child.stdout?.setEncoding?.('utf8')
      child.stderr?.setEncoding?.('utf8')
      child.stdout?.on('data', (chunk) => entry.pushLog(chunk))
      child.stderr?.on('data', (chunk) => entry.pushLog(chunk))
      child.on('error', (error) => {
        entry.error = `启动看板服务失败：${error.message}`
        this.logger?.warn?.(`dsh-ops-board: ${entry.error}`)
      })
      child.on('exit', (code) => {
        if (entry.child === child) entry.child = null
        if (this.disposed) return
        entry.ready = false
        entry.stateAt = 0
        if (code !== 0 && code !== null) {
          entry.error = `看板服务退出（exit ${code}）。${entry.logTail()}`.trim()
        }
      })
      child.unref()
      this.logger?.info?.(`dsh-ops-board: 启动 ${entry.id} → ${node.file} ${script} ${entry.port}`)
    } catch (error) {
      entry.error = `启动看板服务失败：${String(error?.message || error)}`
      return false
    }

    const ready = await this.waitReady(entry)
    if (ready) {
      this.touch(entry.id)
      this.evict(entry.id)
    } else {
      // A failed spawn must not leave a half-dead child or a stale port behind:
      // the next ensure() should start from a clean slate.
      entry.dispose()
      entry.port = 0
      entry.stateAt = 0
    }
    return ready
  }

  async waitReady(entry, timeout = START_TIMEOUT_MS) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (this.disposed) return false
      if (await entry.probe()) {
        entry.error = ''
        this.logger?.info?.(`dsh-ops-board: ${entry.id} 就绪 ${entry.url}`)
        return true
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    entry.error =
      `等了 ${Math.round(timeout / 1000)} 秒，看板服务还没起来。` + (entry.logTail() ? `\n${entry.logTail()}` : '')
    return false
  }

  /** Stop the least-recently-used servers above the configured cap. */
  evict(justStarted) {
    const max = Math.max(1, Number(this.config.maxRunning) || 1)
    const running = this.order
      .map((id) => this.boards.get(id))
      .filter((entry) => entry && entry.id !== justStarted && entry.port && entry.child)
      .sort((a, b) => a.lastUsed - b.lastUsed)
    while (running.length + 1 > max && running.length > 0) {
      const victim = running.shift()
      this.stop(victim.id)
    }
  }

  stop(id) {
    const entry = this.boards.get(id)
    if (!entry) return
    entry.dispose()
    entry.port = 0
    entry.ready = false
    entry.error = ''
    entry.stateAt = 0
  }

  async state() {
    const boards = []
    for (const id of this.order) {
      const entry = this.boards.get(id)
      if (entry) boards.push(await entry.state())
    }
    return {
      ok: true,
      boards,
      last: this.last,
      lastCreateDir: this.lastCreateDir,
      defaultCreateDir: this.defaultCreateRoot(),
      templateDir: this.templateDir(),
      registryFile: this.registryFile,
      maxRunning: this.config.maxRunning,
    }
  }

  /* creation -------------------------------------------------------------- */

  /** The checkout new boards are scaffolded from. */
  templateDir() {
    const configured = String(this.config.templateDir || '').trim()
    if (configured && existsSync(join(resolve(configured), 'scripts', 'serve.mjs'))) {
      return resolve(configured)
    }
    for (const id of this.order) {
      const entry = this.boards.get(id)
      if (entry && existsSync(join(entry.dir, 'scripts', 'serve.mjs'))) return entry.dir
    }
    const fallback = join(homedir(), 'ops-board')
    return existsSync(join(fallback, 'scripts', 'serve.mjs')) ? fallback : ''
  }

  /** Last used storage root, else a sibling of the template, else ~/ops-board-reports. */
  defaultCreateRoot() {
    const configured = String(this.config.defaultCreateRoot || '').trim()
    if (configured) return resolve(configured)
    if (this.lastCreateDir) return this.lastCreateDir
    const template = this.templateDir()
    if (template) return join(dirname(template), `${basename(template)}-reports`)
    return join(homedir(), 'ops-board-reports')
  }

  /**
   * Create a new ops-board checkout under a storage root. The root is the
   * user-picked "report storage location"; the board folder itself is named
   * from the project/label (suffixed when the name is taken).
   */
  createBoard({ label, projectDir, root } = {}) {
    const template = this.templateDir()
    if (!template) {
      throw new Error('没有模板目录：请先在配置里设置 templateDir，或先登记一个可用的看板')
    }
    if (!existsSync(join(template, 'scripts', 'serve.mjs'))) {
      throw new Error(`模板目录不完整：${template}`)
    }

    const projectPath = String(projectDir || '').trim()
    if (projectPath && !existsSync(resolve(projectPath))) {
      throw new Error(`项目目录不存在：${projectPath}`)
    }
    const seed = readProjectSeed(projectPath)
    const name = String(label || '').trim() || seed.name || '新看板'
    const slug = seed.slug || slugify(name) || 'board'

    const storage = resolve(
      String(root || '').trim() || this.lastCreateDir || this.defaultCreateRoot(),
    )
    if (!storage) throw new Error('请选择报文存放位置')
    mkdirSync(storage, { recursive: true })

    let dir = join(storage, slug)
    let suffix = 2
    while (existsSync(dir) && readdirSync(dir).length > 0) {
      dir = join(storage, `${slug}-${suffix}`)
      suffix += 1
    }
    mkdirSync(dir, { recursive: true })

    // 只写数据，不拷贝脚本。
    // 脚本只有模板一份，项目里留下的 scripts/*.mjs 是转发入口（见 templateEntrySource）。
    // 这样以后升级渲染/服务逻辑，改模板即可，已有项目不用逐个重拷。
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    const entrySource = templateEntrySource(template)
    // 名单从模板的 package.json 推导：声明了哪个 script，就一定有对应入口。
    for (const name of entryScriptNames(template)) {
      writeFileSync(join(dir, 'scripts', name), entrySource, 'utf8')
    }
    for (const file of ['package.json', '.gitignore']) {
      const source = join(template, file)
      if (existsSync(source)) cpSync(source, join(dir, file))
    }

    const now = new Date().toISOString()
    const project = {
      name,
      subtitle: seed.subtitle || '项目工作报文',
      slug,
    }

    const boardConfig = readJson(join(template, 'board.config.json')) || {
      schemaVersion: 2,
      views: [],
      lanes: [],
    }
    boardConfig.project = project
    writeFileSync(join(dir, 'board.config.json'), JSON.stringify(boardConfig, null, 2), 'utf8')

    const ledger = {
      project,
      updatedAt: now,
      headline: projectPath ? `${name} 已接入项目看板` : `${name} 的看板已创建`,
      deck: projectPath ? `项目目录：${projectPath}` : '还没有选择项目目录，可以从「管理」里补充。',
      conclusion: projectPath
        ? '初始报文：项目已接入。点「总结项目状态」让 Harness 读项目并生成第一版台账。'
        : '看板刚建好，还没有梳理。可以先在「管理」里补充项目目录，再点「总结项目状态」。',
      highlights: [
        ...(seed.subtitle ? [{ kind: 'feature', text: seed.subtitle }] : []),
        ...(projectPath ? [{ kind: 'watch', text: `项目目录：${projectPath}` }] : []),
        { kind: 'watch', text: '点「总结项目状态」让 Harness 读项目并更新台账' },
      ],
      metrics: [
        { label: '条目', value: '0', status: 'muted', note: '等待第一次梳理' },
        { label: '未收口', value: '0', status: 'muted', note: '—' },
      ],
      snapshot: { phase: '刚接入', focus: '生成第一版报文' },
      items: [],
      history: [{ at: now, kind: 'ops', text: `创建看板（项目：${projectPath || '未指定'}）` }],
    }
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify(ledger, null, 2), 'utf8')

    // 记下模板位置：看板里的 scripts/ 只是转发入口，靠这个字段找到真身。
    writeFileSync(
      join(dir, 'project.json'),
      JSON.stringify(
        { projectDir: projectPath || '', templateDir: template },
        null,
        2,
      ),
      'utf8',
    )

    const entry = this.upsert(
      { id: slug, label: name, dir, projectDir: projectPath },
      { persist: false },
    )
    this.lastCreateDir = storage
    this.save()
    this.logger?.info?.(`dsh-ops-board: 创建看板 ${name} → ${dir}`)
    return entry
  }

  dispose() {
    this.disposed = true
    for (const entry of this.boards.values()) entry.dispose()
  }
}

/* ──────────────────────────────── proxying ──────────────────────────────── */

const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
])

/* The workbench is Harness-only: the board's own per-item / global "问 AI"
 * buttons POST to /ops-board/ask (handled below), and the client half turns
 * that into a Harness conversation. There is no page-side model client to skip.
 * The shim only (a) rewrites the board's /api/* calls to this board's proxy
 * prefix and (b) tells the board page it is running inside Harness, which is
 * what makes its ask buttons point at Harness instead of saying "open me from
 * the sidebar". */
const FETCH_SHIM = (prefix) =>
  `(function(){try{var f=window.fetch;if(!f)return;window.fetch=function(input,init){try{if(typeof input==="string"&&input.charAt(0)==="/"&&input.indexOf("/api/")===0){input="${prefix}"+input}}catch(e){}return f.call(this,input,init)}}catch(e){}})();`

function injectShim(html, prefix, entry) {
  // The board's own client references `window.__OPS_HARNESS__`; check for the
  // injected *assignment* so that reference cannot suppress the shim.
  if (html.includes('window.__OPS_HARNESS__=')) return html
  const config = JSON.stringify({
    id: entry.id,
    label: entry.label,
    dir: entry.dir,
    projectDir: entry.projectDir || '',
  }).replace(/</g, '\\u003c')
  const code = `window.__OPS_HARNESS__=${config};${FETCH_SHIM(prefix)}`
  const tag = `<script>${code}</script>`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${tag}`)
  return tag + html
}

async function forward(req, res, entry, rest, prefix) {
  const target = `${entry.url.replace(/\/$/, '')}${rest || '/'}`
  const abort = new AbortController()
  const onClose = () => abort.abort()
  res.on('close', onClose)

  try {
    let body
    if (req.method !== 'GET' && req.method !== 'HEAD') body = await readBody(req)

    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (HOP_HEADERS.has(key.toLowerCase())) continue
      if (value !== undefined) headers[key] = value
    }

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      signal: abort.signal,
      redirect: 'manual',
    })
    const type = upstream.headers.get('content-type') || 'application/octet-stream'

    if (type.includes('text/html')) {
      const html = injectShim(await upstream.text(), prefix, entry)
      const data = Buffer.from(html, 'utf8')
      res.writeHead(upstream.status, {
        'content-type': type,
        'cache-control': 'no-store',
        'content-length': data.length,
      })
      res.end(data)
      return
    }

    res.writeHead(upstream.status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-ops-board-proxy': entry.id,
    })
    res.flushHeaders?.()
    if (upstream.body) {
      const reader = upstream.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolveDrain) => res.once('drain', resolveDrain))
        }
      }
    }
    res.end()
  } catch {
    // Board down: drop the connection so the page's own fallback decides how
    // to explain it (the authored "后端没起来" wording stays intact).
    if (!res.headersSent) res.destroy()
    else res.end()
  } finally {
    res.off('close', onClose)
  }
}

/* ───────────────────────────────── routes ───────────────────────────────── */

/**
 * Local ask bus: the board page (any browser tab, no opener needed) POSTs a
 * question; every open Harness page is subscribed over SSE and turns it into a
 * session. No auth, because plugin routes are public; POST is origin-guarded.
 */
class AskHub {
  constructor() {
    this.clients = new Set()
  }

  subscribe(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    this.clients.add(res)
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {}
    }, 20000)
    ping.unref?.()
    const done = () => {
      clearInterval(ping)
      this.clients.delete(res)
    }
    req.on('close', done)
    res.on('close', done)
  }

  publish(payload) {
    const frame = `data: ${JSON.stringify(payload)}\n\n`
    for (const client of this.clients) {
      try {
        client.write(frame)
      } catch {}
    }
  }

  get size() {
    return this.clients.size
  }

  dispose() {
    for (const client of this.clients) {
      try {
        client.end()
      } catch {}
    }
    this.clients.clear()
  }
}

function createHandler(controller, hub) {
  return async (req, res) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { ok: false, error: 'bad url' })
    }
    const pathname = url.pathname

    try {
      if (pathname === `${ROUTE}/state` && req.method === 'GET') {
        // `origin` lets the Client build a *browser-openable* absolute URL even
        // when the page itself was loaded from a non-http origin (dsh-app://),
        // where window.location.origin is not something a browser can visit.
        const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
        const scheme = forwarded === 'https' ? 'https' : 'http'
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').trim()
        return sendJson(res, 200, {
          ...(await controller.state()),
          origin: host ? `${scheme}://${host}` : '',
          askListeners: hub.size,
        })
      }

      if (pathname === `${ROUTE}/start` && req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const id = String(body.board || controller.last || controller.order[0] || '')
        await controller.ensure(id)
        return sendJson(res, 200, await controller.state())
      }

      if (pathname === `${ROUTE}/sessions` && req.method === 'GET') {
        return sendJson(res, 200, controller.readSessionMap())
      }

      if (pathname === `${ROUTE}/sessions` && req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const sessions = controller.setSession(body.board, body.key, body.sessionId)
        return sendJson(res, 200, { ok: true, sessions })
      }

      if (pathname === `${ROUTE}/events` && req.method === 'GET') {
        return hub.subscribe(req, res)
      }

      if (pathname === `${ROUTE}/ask` && req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const question = String(body.question || '').trim()
        if (!question) return sendJson(res, 400, { ok: false, error: '问题是空的' })
        if (hub.size === 0) {
          return sendJson(res, 200, { ok: false, error: 'Harness 窗口没开着，先把 Harness 打开或切到前台' })
        }
        hub.publish({
          type: 'ask',
          board: String(body.board || ''),
          dir: String(body.dir || ''),
          label: String(body.label || ''),
          item: String(body.item || ''),
          title: String(body.title || ''),
          fresh: Boolean(body.fresh),
          question,
        })
        return sendJson(res, 200, { ok: true, listeners: hub.size })
      }

      if (pathname === `${ROUTE}/boards/probe` && req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        try {
          const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
          return sendJson(res, 200, {
            ok: true,
            probe: probeProject(String(body.projectDir || '').trim()),
          })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message || error) })
        }
      }

      if (pathname === `${ROUTE}/boards/create` && req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        try {
          const entry = controller.createBoard(body)
          let generating = false
          if (body.generate !== false && entry && hub.size > 0) {
            hub.publish({
              type: 'ask',
              board: entry.id,
              dir: entry.dir,
              label: entry.label,
              item: '__onboard__',
              title: '生成项目报文',
              sessionTitle: `${entry.label} · 生成项目报文`,
              fresh: false,
              question: onboardingQuestion(
                entry,
                String(body.projectDir || '').trim(),
                String(body.mode || 'fast'),
              ),
            })
            generating = true
          }
          return sendJson(res, 200, {
            ok: true,
            board: entry?.toJSON(),
            dir: entry?.dir || '',
            generating,
            // 让前端能立刻显示「这个项目有多少可依据的东西」，而不是等 agent 说完才知道
            probe: probeProject(String(body.projectDir || '').trim()),
            mode: String(body.mode || 'fast'),
            state: await controller.state(),
          })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String(error?.message || error) })
        }
      }

      if (pathname === `${ROUTE}/boards` && req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const dir = String(body.dir || '').trim()
        if (!dir) return sendJson(res, 400, { ok: false, error: '请填写看板目录' })
        if (!existsSync(resolve(dir))) return sendJson(res, 400, { ok: false, error: `目录不存在：${dir}` })
        if (!existsSync(join(resolve(dir), 'ledger.json'))) {
          return sendJson(res, 400, { ok: false, error: '目录里没有 ledger.json，不像是 ops-board 看板' })
        }
        if (!existsSync(join(resolve(dir), 'scripts', 'serve.mjs'))) {
          return sendJson(res, 400, { ok: false, error: '目录里没有 scripts/serve.mjs，无法启动看板服务' })
        }
        const entry = controller.upsert({ label: body.label, dir }, { replaceLabel: true })
        controller.save()
        return sendJson(res, 200, { ok: true, board: entry?.toJSON(), state: await controller.state() })
      }

      if (pathname === `${ROUTE}/boards/remove` && req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}')
        const removed = controller.remove(String(body.id || ''))
        if (!removed) return sendJson(res, 404, { ok: false, error: '没有这个看板' })
        return sendJson(res, 200, { ok: true, state: await controller.state() })
      }

      const boardMatch = pathname.match(/^\/ops-board\/b\/([a-z0-9][a-z0-9-]*)(\/.*)?$/)
      if (boardMatch) {
        const id = boardMatch[1]
        const rest = (boardMatch[2] || '/') + (url.search || '')
        if (!controller.boards.has(id)) return sendJson(res, 404, { ok: false, error: `没有这个看板：${id}` })
        await controller.ensure(id)
        return await forward(req, res, controller.boards.get(id), rest, `${BOARD_PREFIX}/${id}`)
      }

      if (pathname === LIVE || pathname.startsWith(`${LIVE}/`)) {
        const id = controller.last || controller.order[0]
        if (!id) return sendJson(res, 404, { ok: false, error: '还没有看板' })
        const rest = (pathname.slice(LIVE.length) || '/') + (url.search || '')
        await controller.ensure(id)
        return await forward(req, res, controller.boards.get(id), rest, LIVE)
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      if (!res.headersSent) {
        return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      }
      res.end()
    }
  }
}

/* ───────────────────────────────── apply ────────────────────────────────── */

export function apply(ctx, config) {
  const controller = new BoardController(config, ctx.logger)
  controller.load()
  const hub = new AskHub()

  ctx.effect(() => {
    if (config?.autoStart !== false) {
      const timer = setTimeout(() => {
        const id = controller.last || controller.order[0]
        if (id) controller.ensure(id).catch(() => {})
      }, 800)
      timer.unref?.()
      return () => {
        clearTimeout(timer)
        controller.dispose()
        hub.dispose()
      }
    }
    return () => {
      controller.dispose()
      hub.dispose()
    }
  }, 'dsh-ops-board: board server lifecycle')

  const handler = createHandler(controller, hub)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-ops-board: routes')

  ctx.logger?.info?.(
    `dsh-ops-board: ${controller.order.length} board(s) at ${ROUTE} (${controller.order.join(', ') || 'none'})`,
  )
}
