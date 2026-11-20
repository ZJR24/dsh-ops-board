// 把本地 HEAD 推到 GitHub，走 API（本机 git 凭据助手被禁用，裸 push 必挂）。
//
// token 来源：Windows 凭据管理器 `GitHub - https://api.github.com/ZJR24`
// （见 scripts/lib/wincred.ps1）。以前这里读 $env:TEMP\.gh-tok —— 那个文件会被
// 系统清理，一没了就报「推不了」，看着像权限问题，其实是凭据源选错了。
//
// ⚠️ 三个踩过的坑，改这里之前先读：
//   ① 不能直接用 `git rev-list <remote>..HEAD`：有好几次提交是**通过 API 建的**，
//      远端 commit sha 和本地 sha 不是同一个（内容一样、sha 不同），本地根本没有
//      远端那个对象，`rev-list 24f692c..HEAD` 会报 "Invalid revision range"。
//      → 所以不依赖共享历史，改成**按文件内容比对**。
//   ② 不能用「读文件成字符串再 base64」：截图是二进制，按 utf8 读会损坏；
//      而且本地工作区是 CRLF、对象库是 LF，手写规范化容易漏。
//      → 一律走 git 自己的对象：`git ls-tree` 拿 blob sha（已按 core.autocrlf 规范化），
//        `git cat-file blob` 拿原始字节。这样二进制和换行都不会出错。
//   ③ 本地删掉的文件必须显式从远端 tree 里删（`sha: null`），否则远端留一份过时副本。
//
// 同步游标记在 .git/github-last-sync（本地 sha），只影响 commit message 的取法。
//
// 用法：
//   node scripts/push-github.mjs            推送
//   node scripts/push-github.mjs --dry-run  只列出会推什么
//   node scripts/push-github.mjs --repo owner/name
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const MARK = join(ROOT, '.git', 'github-last-sync')

const argv = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const i = argv.indexOf('--' + name)
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback
}
const REPO = argOf('repo', 'ZJR24/dsh-ops-board')
const DRY = argv.includes('--dry-run')

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const gitBuf = (...args) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 })

function readToken() {
  const ps = [
    "$ErrorActionPreference='Stop'",
    `. '${join(HERE, 'lib', 'wincred.ps1').replace(/'/g, "''")}'`,
    '$t = Get-GitHubToken',
    'if ($t) { $t } else { exit 3 }',
  ].join('; ')
  try {
    return execFileSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error('凭据管理器里读不到 GitHub token（target: GitHub - https://api.github.com/ZJR24）')
  }
}

const token = readToken()
const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'dsh-ops-board-push',
}
const API = `https://api.github.com/repos/${REPO}`

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : {}
}

const localHead = git('rev-parse', 'HEAD')
const remote = await call('GET', '/git/ref/heads/main')
const remoteSha = remote.object.sha
const remoteCommit = await call('GET', `/git/commits/${remoteSha}`)
const remoteTree = await call('GET', `/git/trees/${remoteCommit.tree.sha}?recursive=1`)

const remoteBlobs = new Map()
for (const e of remoteTree.tree || []) {
  if (e.type === 'blob') remoteBlobs.set(e.path, e.sha)
}

// 本地跟踪文件 → blob sha（git 对象库里已经是 LF 规范化后的内容，和 GitHub 存的同一套）
const localBlobs = new Map()
for (const line of git('ls-tree', '-r', '-z', 'HEAD').split('\0')) {
  if (!line.trim()) continue
  const tab = line.indexOf('\t')
  const meta = line.slice(0, tab).split(/\s+/)
  const path = line.slice(tab + 1).split('\\').join('/')
  if (meta[1] === 'blob') localBlobs.set(path, meta[2])
}

const changed = [...localBlobs.keys()].filter((p) => remoteBlobs.get(p) !== localBlobs.get(p))
const removed = [...remoteBlobs.keys()].filter((p) => !localBlobs.has(p))

if (!changed.length && !removed.length) {
  console.log('远端内容已经和本地一致（' + remoteSha.slice(0, 7) + '），不用推。')
  writeFileSync(MARK, localHead + '\n', 'utf8')
  process.exit(0)
}

console.log(`远端 ${remoteSha.slice(0, 7)} → 本地 ${localHead.slice(0, 7)}：${changed.length} 个文件有变化`)
for (const p of changed) console.log('  ~ ' + p)
for (const p of removed) console.log('  - ' + p + '（本地已删）')

if (DRY) {
  console.log('\n--dry-run：没有真的写远端。')
  process.exit(0)
}

// commit message：优先「上次同步点之后」的提交信息，退回本地 HEAD 那一条。
let message = git('log', '-1', '--pretty=%B')
try {
  const last = existsSync(MARK) ? readFileSync(MARK, 'utf8').trim() : ''
  if (last && /^[0-9a-f]{40}$/.test(last)) {
    execFileSync('git', ['cat-file', '-e', last + '^{commit}'], { cwd: ROOT, stdio: 'ignore' })
    const range = git('log', `${last}..HEAD`, '--pretty=%B%n---')
    if (range) message = range.replace(/\n---\n?$/, '')
  }
} catch {}

const tree = []
for (const p of changed) {
  const buf = gitBuf('cat-file', 'blob', localBlobs.get(p))
  const blob = await call('POST', '/git/blobs', {
    content: buf.toString('base64'),
    encoding: 'base64',
  })
  tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${p} → ${blob.sha.slice(0, 10)} (${buf.length} 字节)`)
}
// sha:null = 从 tree 里删掉这个路径
for (const p of removed) tree.push({ path: p, mode: '100644', type: 'blob', sha: null })

const newTree = await call('POST', '/git/trees', { base_tree: remoteCommit.tree.sha, tree })
const commit = await call('POST', '/git/commits', { message, tree: newTree.sha, parents: [remoteSha] })
const patched = await call('PATCH', '/git/refs/heads/main', { sha: commit.sha, force: false })
writeFileSync(MARK, localHead + '\n', 'utf8')
console.log('\n远端 main → ' + patched.object.sha)
console.log('同步点已记：' + localHead.slice(0, 7))
