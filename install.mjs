#!/usr/bin/env node
/**
 * install.mjs —— 一条命令把 dsh-ops-board 装进 DSH 桌面端。
 *
 * 这个脚本做的事，就是 README 里那三步手工安装：
 *   1. 插件本体复制进 <profile>/node_modules/dsh-ops-board（必须是真实目录）
 *   2. profile 的 package.json 里加 dependencies 和 dsh.profile.bundles
 *   3. 看板模板放到插件默认认的位置（~/ops-board），这样零配置就能新建看板
 *
 * 第 3 步是关键：插件的 templateDir() 兜底顺序是
 *   配置的 templateDir → 已注册看板 → ~/ops-board
 * 所以模板放进 ~/ops-board 时，不需要改 profile 的 cordis.patch.yml，
 * 也就不存在「两处同时注册」的 duplicate loader entry id 问题。
 *
 * 用法：
 *   node install.mjs                 # 装到 desktop profile，模板放 ~/ops-board
 *   node install.mjs --dry-run       # 只说要改什么，不动文件
 *   node install.mjs --profile web   # 装到别的 profile
 *   node install.mjs --template-dir D:\my\template   # 模板放别处（会打印要贴的 YAML）
 *   node install.mjs --force         # 覆盖已存在的模板目录
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PKG = 'dsh-ops-board'

/** 复制时要跳过的东西：生成物、运行时数据、版本库。 */
const SKIP = new Set(['.git', 'dist', 'skills.json', 'data', 'node_modules'])

const args = process.argv.slice(2)
const opt = {
  dryRun: args.includes('--dry-run'),
  force: args.includes('--force'),
  profile: valueOf('--profile') || 'desktop',
  dshHome: valueOf('--dsh-home') || process.env.DSH_HOME || join(homedir(), '.dsh'),
  templateDir: valueOf('--template-dir'),
}

function valueOf(flag) {
  const i = args.indexOf(flag)
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null
}

const say = (msg) => console.log(msg)
const ok = (msg) => console.log(`  ✓ ${msg}`)
const warn = (msg) => console.log(`  ! ${msg}`)
const bad = (msg) => console.log(`  ✗ ${msg}`)

function die(msg, hint) {
  console.error(`\n✗ ${msg}`)
  if (hint) console.error(`\n${hint}`)
  process.exit(1)
}

/** 一个目录像不像看板模板：有 scripts/lib（真脚本都在那儿）和 board.config.json。 */
function looksLikeTemplate(dir) {
  return (
    existsSync(join(dir, 'scripts', 'entry.mjs')) &&
    existsSync(join(dir, 'scripts', 'lib')) &&
    existsSync(join(dir, 'board.config.json'))
  )
}

/** 像不像一个已存在的看板：有 project.json。 */
function looksLikeBoard(dir) {
  return existsSync(join(dir, 'project.json'))
}

function copyTree(src, dst) {
  cpSync(src, dst, {
    recursive: true,
    filter: (from) => {
      if (from === src) return true
      return !SKIP.has(basename(from))
    },
  })
}

/** 备份后原子写入，返回备份路径。 */
function writeWithBackup(file, text) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const backup = `${file}.bak-${stamp}`
  if (existsSync(file)) cpSync(file, backup)
  const temp = `${file}.tmp-${process.pid}`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, file)
  return backup
}

/* -------------------------------------------------------------------------- */

say(`\ndsh-ops-board 安装器${opt.dryRun ? '（dry-run，不改文件）' : ''}\n`)

// 1. 源目录检查
const srcPlugin = join(ROOT, PKG)
const srcTemplate = join(ROOT, 'ops-board-template')

if (!existsSync(join(srcPlugin, 'index.js')) || !existsSync(join(srcPlugin, 'client.js'))) {
  die(
    `找不到插件本体：${srcPlugin}`,
    '请把 install.mjs 放在仓库根目录（和 dsh-ops-board/、ops-board-template/ 同级）再运行。',
  )
}
if (!looksLikeTemplate(srcTemplate)) {
  die(
    `找不到模板骨架：${srcTemplate}`,
    '仓库不完整。模板目录里应该有 scripts/entry.mjs、scripts/lib/、board.config.json。',
  )
}
ok(`源：插件 ${PKG} + 模板 ops-board-template`)

// 2. 定位 profile
const profileDir = join(opt.dshHome, 'profiles', opt.profile)
const manifestPath = join(profileDir, 'package.json')

if (!existsSync(manifestPath)) {
  const profilesRoot = join(opt.dshHome, 'profiles')
  const names = existsSync(profilesRoot)
    ? readdirSync(profilesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : []
  die(
    `找不到 profile：${profileDir}`,
    names.length
      ? `这个 DSH 里现有的 profile：${names.join(', ')}\n用 --profile <名字> 指定其中一个。`
      : `没有可用的 profile。确认 DSH 已经启动过至少一次（会生成 ${profilesRoot}）。`,
  )
}
ok(`profile：${profileDir}`)

// 3. 决定模板去处
const templateTarget = resolve(
  opt.templateDir || join(homedir(), 'ops-board'),
)
const templateIsDefault = !opt.templateDir

if (existsSync(templateTarget) && !opt.force) {
  if (looksLikeBoard(templateTarget)) {
    die(
      `${templateTarget} 已经是一个看板（里面有 project.json），不能当模板覆盖。`,
      '换一个位置：node install.mjs --template-dir <别的目录>\n' +
        '脚本会打印需要贴进 cordis.patch.yml 的配置片段。',
    )
  }
  if (looksLikeTemplate(templateTarget)) {
    warn(`模板已存在，跳过复制：${templateTarget}（要更新用 --force）`)
  } else {
    warn(`${templateTarget} 已存在但不像模板，跳过（要覆盖用 --force）`)
  }
}

/* -------------------------------------------------------------------------- */

if (opt.dryRun) {
  say('\n将要做的改动：')
  say(`  1. 复制 ${PKG}/ → ${join(profileDir, 'node_modules', PKG)}`)
  say(`  2. ${manifestPath}`)
  say(`       dependencies["${PKG}"] = <版本>`)
  say(`       dsh.profile.bundles 追加 "${PKG}"`)
  say(`  3. 复制 ops-board-template/ → ${templateTarget}`)
  if (!templateIsDefault) {
    say(`  4. 需要你手工在 cordis.patch.yml 里加 templateDir（脚本会打印片段）`)
  }
  say('\n（dry-run 结束，什么都没改）\n')
  process.exit(0)
}

// 4. 复制插件本体
const dstPlugin = join(profileDir, 'node_modules', PKG)
mkdirSync(dstPlugin, { recursive: true })
copyTree(srcPlugin, dstPlugin)
ok(`插件已复制 → ${dstPlugin}`)

// 5. 改 profile 的 package.json
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const version = JSON.parse(readFileSync(join(srcPlugin, 'package.json'), 'utf8')).version

manifest.dependencies = manifest.dependencies || {}
const hadDep = PKG in manifest.dependencies
manifest.dependencies[PKG] = version

manifest.dsh = manifest.dsh || {}
manifest.dsh.profile = manifest.dsh.profile || {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || []
const hadBundle = manifest.dsh.profile.bundles.includes(PKG)
if (!hadBundle) manifest.dsh.profile.bundles.push(PKG)

const backup = writeWithBackup(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
ok(`profile 清单已更新（备份：${basename(backup)}）`)
if (hadDep) warn(`dependencies 里本来就有 ${PKG}，已按 ${version} 覆盖`)
if (hadBundle) warn(`bundles 里本来就有 ${PKG}，未重复添加`)

// 6. 放模板
// 已有模板且没 --force 时跳过（上面已经 warn 过）；--force 则覆盖。
// 已有目录但不像模板时同样只有 --force 才覆盖，避免往用户目录里乱写。
if (!existsSync(templateTarget) || opt.force) {
  mkdirSync(templateTarget, { recursive: true })
  copyTree(srcTemplate, templateTarget)
  ok(`模板已复制 → ${templateTarget}`)
} else if (looksLikeTemplate(templateTarget)) {
  ok(`模板已是最新判断：保留现有 ${templateTarget}`)
} else {
  warn(`保留现有目录不动：${templateTarget}`)
}

// 7. 自检
say('\n自检：')
let failed = 0
const check = (label, cond) => {
  if (cond) ok(label)
  else {
    bad(label)
    failed += 1
  }
}
check('插件 index.js 已就位', existsSync(join(dstPlugin, 'index.js')))
check('插件 client.js 已就位', existsSync(join(dstPlugin, 'client.js')))
check('插件是真实目录（不是链接）', !existsSync(join(dstPlugin, '.link-marker')))
check('清单里声明了依赖', PKG in manifest.dependencies)
check('清单里挂进了 bundles', manifest.dsh.profile.bundles.includes(PKG))
check('模板可被插件识别', looksLikeTemplate(templateTarget))
if (templateIsDefault) {
  check('模板在插件默认位置（零配置）', looksLikeTemplate(templateTarget))
} else {
  warn('模板放到了自定义位置 —— 还要手工配 templateDir（见下）')
}

if (failed > 0) {
  say(`\n✗ ${failed} 项没通过。可以从备份恢复：${backup}\n`)
  process.exit(1)
}

// 8. 收尾提示
say('\n装好了。还需要两步：')

if (!templateIsDefault) {
  say(`\n① 在 ${join(profileDir, 'cordis.patch.yml')} 里加这段配置（改 templateDir 指向模板）：`)
  say('')
  say('   - id: ops-board')
  say('     config:')
  say(`       templateDir: "${templateTarget.replace(/\\/g, '\\\\')}"`)
  say('')
  say('   注意：是给已有的 ops-board 条目补 config，不要再 insert 一个新的 ——')
  say('   插件通过 bundles 引用时自带 patch 层，两处同时注册会报 duplicate loader entry id。')
  say('\n② 重启 DSH 桌面端。')
} else {
  say('\n① 重启 DSH 桌面端。')
  say('\n② 侧栏会出现「项目看板」，点进去新建一个看板试试。')
  say(`\n   模板放在 ${templateTarget}，插件默认就认这个位置，不用改配置。`)
  say('   更新模板时重跑这个脚本并加 --force。')
}

say('')
