#!/usr/bin/env node
// scripts/export-plugin.mjs — 把 dsh-ops-board 插件本体 + 看板模板骨架导成一份干净、可分发的成果。
//
// 干净的判据（任何一条不满足就拒绝导出）：
//   1. 不带运行时数据：data/ 整个目录剔除（boards.json / sessions.json 记着本机绝对路径）
//   2. 不带 docs/ 截图（截的是真实台账内容）
//   3. 导出后全目录再扫一遍：命中本机路径 / 示例项目名即失败
//
// 用法：
//   node scripts/export-plugin.mjs [--out <目录>] [--plugin <插件源码目录>] [--no-template]

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}
function has(name) {
  return process.argv.includes("--" + name);
}

const outDir = resolve((argValue("out") || "").trim() || join("D:\\", "Output"));
const pluginSrc = resolve((argValue("plugin") || "").trim() || join(HERE, "..", "..", "dsh-ops-board"));
const templateSrc = resolve((argValue("template") || "").trim() || join(HERE, ".."));
const withTemplate = !has("no-template");

for (const [what, p] of [
  ["插件源码目录", pluginSrc],
  ["看板模板目录", templateSrc],
]) {
  if (!existsSync(p)) {
    console.error(`找不到${what}：${p}`);
    process.exit(1);
  }
}
for (const f of ["index.js", "client.js", "package.json"]) {
  if (!existsSync(join(pluginSrc, f))) {
    console.error(`插件源码目录不完整（缺 ${f}）：${pluginSrc}`);
    process.exit(1);
  }
}
if (withTemplate && !existsSync(join(templateSrc, "scripts", "serve.mjs"))) {
  console.error(`看板模板目录不完整（缺 scripts/serve.mjs）：${templateSrc}`);
  process.exit(1);
}

// ── 常量 ────────────────────────────────────────────────────────
const TEXT_EXT = /\.(js|mjs|json|yml|yaml|md|ps1|cmd|txt)$/;
const SCAN_SKIP = new Set(["data", "docs", "node_modules", ".git", ".uitest"]);
// 本机专有痕迹：绝对路径、用户名目录、本机项目名。
// 用片段拼接构造，免得这段正则自己命中自己。
const BS = String.fromCharCode(92); // 单个反斜杠
const DRIVE = "D:" + BS + "WorkSpace";
const USERS = "C:" + BS + "Users";
const HOST_TRACE = new RegExp(
  [DRIVE, USERS + BS + "[A-Za-z]", "cyber-egg", "赛博鸡蛋", "hetu-notes", "practise"].join("|"),
  "i"
);
const PATH_TRACE = new RegExp(DRIVE + "|" + USERS + BS + "[A-Za-z]", "i");

// ── 白名单：只拷这些，也只扫这些 ───────────────────────────────
// 教训（2026-11-18）：早先自检扫「整个 scripts/」，复制却按白名单走，
// 两个范围不一致 → 41 个开发用脚本里的本机路径（测试断言里写死的看板路径）
// 把导出永久拦死，而那些文件根本不会进产物。判据与产物必须同源。
const PLUGIN_FILES = ["index.js", "client.js", "package.json", "cordis.patch.yml", "icon.svg", "README.md", "sync.ps1"];
const PLUGIN_DIRS = ["locale", "test"];

// 模板要带走的脚本：页面运行 + 自检需要的全部，不含开发期的一次性测试/截图脚本。
const TEMPLATE_FILES = ["board.config.json", "package.json", ".gitignore", "README.md", "start.cmd"];
const TEMPLATE_SCRIPTS = [
  "render.mjs",
  "serve.mjs",
  "ask.mjs",
  "verify-board.mjs",
  "gen-ledger.mjs",
  "collect-skills.mjs",
  "entry.mjs",
  "uitest.mjs",
  "offline-test.mjs",
];
// render/serve/ask 的本地依赖。**不要只靠这份手写清单**：下面 resolveLibs()
// 会从 TEMPLATE_SCRIPTS 出发递归解析真实 import，把漏掉的补上并在控制台点名。
// （教训：2026-11-18 手写清单漏了 evidence-path.mjs，产物交付即 ERR_MODULE_NOT_FOUND。）
const TEMPLATE_LIBS_SEED = [
  "client.js", // 不是 import，是 render.mjs 读进来内联的，必须单独列
  "planner.mjs", // 同上：render.mjs 读进来包成 IIFE 内联，不在 import 图里
  "css.mjs",
  "parts.mjs",
  "context.mjs",
];

// 从入口脚本出发，递归收集 ./lib/*.mjs 的真实依赖闭包
function resolveLibs(scriptsDir, entries) {
  const found = new Set();
  const missing = [];
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const p = join(scriptsDir, "lib", name);
    if (!existsSync(p)) {
      missing.push(name);
      return;
    }
    found.add(name);
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/from\s+"\.\/([^"]+\.mjs)"/g)) walk(m[1]);
  };
  for (const f of entries) {
    const p = join(scriptsDir, f);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    for (const m of text.matchAll(/from\s+"\.\/lib\/([^"]+\.mjs)"/g)) walk(m[1]);
  }
  return { found, missing };
}

function scanFile(p, label, hits, bad) {
  if (!existsSync(p) || !TEXT_EXT.test(p)) return;
  readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
    if (!bad.test(line)) return;
    // 占位符（<...>）与 homedir() 属于"跟着收件人环境走"的合法写法
    if (/homedir\(\)/.test(line)) return;
    if (/<[^>]+>/.test(line) && !PATH_TRACE.test(line)) return;
    hits.push(`${label}:${i + 1}  ${line.trim().slice(0, 100)}`);
  });
}

function scanTree(dir, prefix, hits, bad, skip) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (skip && skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      scanTree(p, `${prefix}${name}/`, hits, bad, skip);
      continue;
    }
    scanFile(p, `${prefix}${name}`, hits, bad);
  }
}

// ── 导出前：源码自检（只扫会被复制的文件）────────────────────────
// 模板的 lib 清单 = 手写种子（client.js 等非 import 项）+ 递归解析出的真实依赖闭包
const tplLibSet = new Set(TEMPLATE_LIBS_SEED);
if (withTemplate) {
  const { found, missing } = resolveLibs(join(templateSrc, "scripts"), TEMPLATE_SCRIPTS);
  if (missing.length) {
    console.error(`模板依赖缺失：${missing.join(", ")}`);
    process.exit(1);
  }
  for (const f of found) tplLibSet.add(f);
}
const TEMPLATE_LIBS = [...tplLibSet].sort();

const pollution = [];
for (const f of PLUGIN_FILES) scanFile(join(pluginSrc, f), f, pollution, HOST_TRACE);
for (const d of PLUGIN_DIRS) scanTree(join(pluginSrc, d), `${d}/`, pollution, HOST_TRACE);
if (withTemplate) {
  for (const f of TEMPLATE_FILES) scanFile(join(templateSrc, f), `template/${f}`, pollution, HOST_TRACE);
  for (const f of TEMPLATE_SCRIPTS) scanFile(join(templateSrc, "scripts", f), `template/scripts/${f}`, pollution, HOST_TRACE);
  for (const f of TEMPLATE_LIBS) scanFile(join(templateSrc, "scripts", "lib", f), `template/scripts/lib/${f}`, pollution, HOST_TRACE);
}

if (pollution.length) {
  console.error(`导出被拒：源码里还有 ${pollution.length} 处本机路径 / 示例值，先清理再导出：`);
  for (const h of pollution.slice(0, 20)) console.error("  " + h);
  process.exit(1);
}

// ── 插件本体（白名单复制，清单定义在文件上方的「白名单」一节）────────
const dest = join(outDir, "dsh-ops-board");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

const copied = [];
for (const f of PLUGIN_FILES) {
  const p = join(pluginSrc, f);
  if (!existsSync(p)) continue;
  cpSync(p, join(dest, f));
  copied.push(f);
}
for (const d of PLUGIN_DIRS) {
  const p = join(pluginSrc, d);
  if (!existsSync(p)) continue;
  cpSync(p, join(dest, d), { recursive: true });
  copied.push(d + "/");
}
console.log(`插件本体 → ${dest}`);
console.log("  含：" + copied.join(", "));
console.log("  不含：data/（运行时数据，含本机绝对路径）" + (existsSync(join(pluginSrc, "docs")) ? "、docs/（真实台账截图）" : ""));

// ── 看板模板骨架 ────────────────────────────────────────────────
let templateDest = "";
if (withTemplate) {
  templateDest = join(outDir, "ops-board-template");
  rmSync(templateDest, { recursive: true, force: true });
  mkdirSync(templateDest, { recursive: true });

  // 按白名单复制：只带页面跑起来需要的那几个脚本 + 它们的 lib 依赖。
  // （早先是整个 scripts/ 递归拷贝，把 30 多个开发用测试/截图脚本一起塞给收件人。）
  mkdirSync(join(templateDest, "scripts", "lib"), { recursive: true });
  const tplScripts = [];
  for (const f of TEMPLATE_SCRIPTS) {
    const p = join(templateSrc, "scripts", f);
    if (!existsSync(p)) continue;
    cpSync(p, join(templateDest, "scripts", f));
    tplScripts.push(f);
  }
  const tplLibs = [];
  for (const f of TEMPLATE_LIBS) {
    const p = join(templateSrc, "scripts", "lib", f);
    if (!existsSync(p)) continue;
    cpSync(p, join(templateDest, "scripts", "lib", f));
    tplLibs.push(f);
  }
  // 模板必须能自我闭环：上面 resolveLibs() 已保证依赖闭包完整，
  // 这里再核一遍落盘结果 —— 复制阶段少写一个同样是"交付即坏"。
  for (const need of TEMPLATE_LIBS) {
    if (!existsSync(join(templateDest, "scripts", "lib", need))) {
      console.error(`模板缺少必需依赖 scripts/lib/${need}`);
      process.exit(1);
    }
  }
  for (const f of TEMPLATE_FILES) {
    const p = join(templateSrc, f);
    if (existsSync(p)) cpSync(p, join(templateDest, f));
  }
  console.log(`看板模板 → ${templateDest}`);
  console.log("  含：" + tplScripts.join(", "));
  console.log("  含：lib/ " + tplLibs.join(", "));

  // 只带一份空台账，不带任何样例数据
  const emptyLedger = {
    schemaVersion: 2,
    project: { slug: "board", name: "我的项目", subtitle: "项目工作报文 · 项目台账" },
    updatedAt: new Date().toISOString(),
    headline: "台账还空着",
    conclusion: "",
    highlights: [],
    metrics: [],
    snapshot: [],
    items: [],
    history: [],
  };
  writeFileSync(join(templateDest, "ledger.json"), JSON.stringify(emptyLedger, null, 2) + "\n", "utf8");

  const tp = join(templateDest, "package.json");
  if (existsSync(tp)) {
    const pkg = JSON.parse(readFileSync(tp, "utf8"));
    pkg.name = "ops-board-template";
    pkg.private = true;
    writeFileSync(tp, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  }

  // 模板 README 换成一份中性的（原模板 README 里有本机路径示例）
  writeFileSync(
    join(templateDest, "README.md"),
    `# ops-board 模板骨架

一份台账 JSON，渲染成一份报纸体例的工作台页面，内置 AI 对话入口。

## 跑起来

\`\`\`bash
npm run build     # 渲染 + 自检
npm run serve     # http://127.0.0.1:8790
\`\`\`

或者双击 \`start.cmd\`：自己生成页面、起服务、开浏览器。那个黑窗口别关。

单独打开时只能看、不能问 —— 模板里没有接入点，「发送」会提示去 Harness 里打开。
双击 \`dist/index.html\`（\`file://\`）也能看，但改完台账不会自动重渲染，那是服务的活。

## 改什么

- \`ledger.json\` —— 台账数据（条目、处理记录、指标）
- \`board.config.json\` —— 车道 / 状态 / 严重度 / 视图
- \`scripts/lib/css.mjs\` —— 全部样式，改视觉只改这一个文件

改完 \`ledger.json\` 刷新浏览器就是最新，不用重跑命令。

## 指标配色是一份三方契约

侧栏「概览指标」每条有自己的 \`status\`，渲染时拼成 \`.metric-<status>\` 取配色。合法值写在
\`board.config.json\` 的 \`metricStatuses\` 里，默认四档：

\`\`\`jsonc
"metricStatuses": ["ok", "warn", "danger", "muted"]
\`\`\`

台账里写了表外的值（比如 \`purple\`），页面不报错，只是那条指标悄悄没配色。
\`verify-board.mjs\` 会点名是哪个指标的 status 写错了，也会检查「声明了几档、CSS 就必须有几条规则」。
想加一档，三处一起改：\`metricStatuses\` 加值、\`scripts/lib/css.mjs\` 加 \`.metric-<值>\` 规则、
需要时在 \`scripts/lib/parts.mjs\` 里补默认值。

## 空台账是合法的

\`items: []\` 也能渲染、也能过自检 —— 先建板、再慢慢填条目。
`,
    "utf8"
  );

  console.log(`看板模板骨架 → ${templateDest}`);
  console.log("  含：scripts/（渲染 / 服务 / 自检 / 生成台账 + lib/）、board.config.json、空 ledger.json、package.json、README.md");
  console.log("  不含：任何台账样例数据、导出工具（export-*.mjs 留在本机侧）");
}

// ── 安装说明 ────────────────────────────────────────────────────
const readme = `# dsh-ops-board —— 干净插件本体

\`dsh-ops-board\` 插件的可分发副本：不带运行时数据、不带本机路径、不带示例项目。
给的是"能装、能跑、能自己建看板"的最小完整集。

## 里面有什么

\`\`\`
dsh-ops-board/          插件本体 —— 装进 DSH profile 的 node_modules
  index.js              Host 半侧（启动看板服务、代理、注册表）
  client.js             Client 半侧（侧栏图标、整页面板、问 AI）
  package.json          插件元数据（dsh.client / dsh.bundle 声明）
  cordis.patch.yml      挂载点（被 profile bundles 引用时自动生效）
  icon.svg              侧栏图标
  locale/               中英文案
  test/                 host / client 自检装置
  sync.ps1              把本体同步进 desktop profile
${withTemplate ? `
ops-board-template/     看板模板骨架 —— 插件新建看板时复制它
  scripts/              渲染 / 服务 / 自检 / 导出 / 生成台账（10 个脚本 + lib）
  board.config.json     车道 / 状态 / 视图配置
  ledger.json           **空台账**（0 条目，合法状态）
  package.json          build / serve / verify
` : ""}
\`\`\`

**不含**：\`data/\`（运行时数据，记着原机器的绝对路径）、\`docs/\`（截图是真实台账内容）。

## 怎么装

DSH 桌面端只接受**真实目录手工安装**（\`dsh plugin add\` 会被拒，插件市场只收策展表里的）。
在 \`~/.dsh/profiles/desktop/\` 下做三件事，然后重启桌面端：

1. 把 \`dsh-ops-board/\` 整个复制进 \`node_modules/dsh-ops-board/\`
   —— 必须是真实目录，不能 link、不能 junction
2. \`package.json\` 的 \`dependencies\` 加 \`"dsh-ops-board": "0.1.0"\`
3. \`package.json\` 的 \`dsh.profile.bundles\` 末尾追加 \`"dsh-ops-board"\`

**不要再往 \`cordis.patch.yml\` 加条目** —— 被 bundles 引用的包，自带 patch 层会自动生效；
两处同时注册会报 \`duplicate loader entry id\`。

## 怎么用

重启后侧栏出现「项目看板」。第一次进去是空的，点「新建看板」：

- 选一个项目目录（可选，记进注册表供问 AI 时读代码）
- 选一个存放位置（看板目录建在那儿）
- 插件从模板复制骨架，生成一个带 \`ledger.json\` 的空看板

想直接登记已有的看板目录，把路径填进「添加看板」即可（目录里要有 \`ledger.json\` 和 \`scripts/serve.mjs\`）。

## 依赖边界（重要）

- **渲染 / 浏览 / 翻页 / 主题**：纯静态，有 node 就能跑，\`dist/index.html\` 双击也看
- **Skill 统计**：要 DSH 的 \`~/.dsh/sessions\` 与 \`~/.dsh/skills\`，没有就渲染成空，不报错
- **问 AI**：要 Harness 宿主注入 + 看板服务的 \`/ops-board/ask\`，脱离 DSH 只剩提示

换句话说：**这是 Harness 专属工具**，装 DSH 才有完整功能。

## 自检

\`\`\`powershell
cd dsh-ops-board
node test/host-smoke.mjs      # 宿主半侧：创建 / 增删 / 端口 / 代理 / SSE
node test/client-smoke.mjs    # 客户端半侧：面板 / 侧栏 / 问 AI 流程
\`\`\`

> 这两个自检要 \`@deepseek-ai/schemastery\` / \`@deepseek-ai/cordis\` 两个 peer 依赖，
> 它们由 DSH profile 提供 —— **装进 profile 之后才能跑**，单独拷到空目录跑会报
> \`ERR_MODULE_NOT_FOUND\`，这是预期的，不是坏包。
`;

writeFileSync(join(outDir, "README.md"), readme, "utf8");
console.log(`安装说明 → ${join(outDir, "README.md")}`);

// ── 导出后：产物自检 ────────────────────────────────────────────
// 与前面的「源码自检」不同，这里要扫**整棵产物树**：收件人拿到什么就查什么，
// 不再看白名单（白名单只决定"拷什么"，不决定"成品里允许有什么"）。
const finalPollution = [];
scanTree(dest, "", finalPollution, HOST_TRACE);
if (templateDest) scanTree(templateDest, "template/", finalPollution, HOST_TRACE);

if (finalPollution.length) {
  console.error(`\n⚠ 产物里仍有 ${finalPollution.length} 处本机痕迹：`);
  for (const h of finalPollution.slice(0, 20)) console.error("  " + h);
  process.exit(1);
}
console.log("\n✓ 产物自检通过：无本机路径、无示例项目名、无运行时数据。");
