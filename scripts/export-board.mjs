#!/usr/bin/env node
// export-board.mjs — 导出一份「干净、自包含」的看板成果到指定位置。
//
// 背景：
//   平时用的看板是「瘦客户端」：目录里只有数据 + scripts/ 转发入口，真正的脚本
//   在模板目录（`project.json.templateDir` 指过去），靠 entry.mjs 里的硬编码默认路径兜底。
//   这是为了本机滚动升级方便，但**不能**原样拷给别人——收件人机器上没有那个模板路径，
//   脚本全都会找错。
//
// 这个脚本把当前看板导成一份可以独立跑、可以上 GitHub / Gitee 的项目：
//   - 空地数据（board.config.json + 空 ledger.json）
//   - scripts/ 放「真脚本」而非转发入口（去掉 entry.mjs 和本机路径）
//   - package.json（含 build / serve / verify 脚本）+ README + start.cmd
//   - 用空的台账渲染一份 dist/index.html（收件人双击/静态托管即可看）
//
// 用法：
//   node scripts/export-board.mjs --project 项目名 [--out D:\Output] [--from <看板目录|模板>] [--no-render]
//
// 默认从模板目录导出（最干净）；`--from` 可指定某个业务看板带它自己的 data。

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, "..");

function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}
function has(name) {
  return process.argv.includes("--" + name);
}

// ── 决定源与去向 ──────────────────────────────────────────────

const projectName = (argValue("project") || "").trim();
if (!projectName) {
  console.error("用法：node scripts/export-board.mjs --project 项目名 [--out D:\\Output] [--from <看板目录|模板>] [--slug <英文标识>] [--subtitle <一句话副标题>]");
  process.exit(1);
}

// 可选：显式给 slug / subtitle；缺省 slug 由项目名派生（中文名落到 'board'），
// subtitle 用通用文案 —— 绝不继承模板里的示例值 / 示例路径。
const slug = (argValue("slug") || "").trim() || slugify(projectName) || "board";
const subtitle = (argValue("subtitle") || "").trim() || "项目工作报文 · 项目台账";

// 默认导出模板根那套干净骨架；--from 指定业务看板时带它自己的数据。
const from = (argValue("from") || "").trim();
const SRC = from ? resolve(from) : TEMPLATE;
if (!existsSync(join(SRC, "scripts", "render.mjs"))) {
  console.error(`源目录不完整：${SRC}`);
  process.exit(1);
}

// 默认找到 D:\Output，报错就回退到模板同级。
const outBase = (argValue("out") || "").trim() || join("D:\\", "Output");
let outDir = resolve(outBase, projectName);
let suffix = 2;
while (existsSync(outDir) && readdirNonEmpty(outDir)) {
  outDir = resolve(outBase, `${projectName}-${suffix}`);
  suffix += 1;
}

function readdirNonEmpty(p) {
  try {
    return readdirSync(p).length > 0;
  } catch {
    return true; // 不存在也当作"占用"，走 -2 命名
  }
}

console.log(`导出一份干净看板：`);
console.log(`  项目名 : ${projectName}`);
console.log(`  源     : ${SRC}`);
console.log(`  去处   : ${outDir}`);

// ── 复制自包含骨架 ────────────────────────────────────────────

mkdirSync(join(outDir, "scripts"), { recursive: true });

// 清掉旧的转发入口，只留真脚本。
const SCRIPTS = join(SRC, "scripts");
const entries = readdirSync(SCRIPTS, { withFileTypes: true });
const copyScripts = [];
for (const e of entries) {
  const name = e.name;
  if (!e.isFile()) continue;
  if (name === "entry.mjs") continue; // 转发层，导出不要
  if (name === "uitest.mjs") continue; // 交互验收依赖真服务器 + 本机小程序路径
  if (name === "export-board.mjs") continue; // 导出工具自己，不是成果的一部分
  copyScripts.push(name);
  cpSync(join(SCRIPTS, name), join(outDir, "scripts", name));
}

// 库目录 scripts/lib（client.js / parts.mjs 等都在这）
if (existsSync(join(SCRIPTS, "lib"))) {
  cpSync(join(SCRIPTS, "lib"), join(outDir, "scripts", "lib"), { recursive: true });
}

// 顶层文件
for (const file of ["board.config.json", ".gitignore"]) {
  if (existsSync(join(SRC, file))) cpSync(join(SRC, file), join(outDir, file));
}

// ── 空台账 ─────────────────────────────────────────────────────

// 从模板抄一份空结构，但**不继承任何示例内容**：project 用本次导出的 slug/subtitle，
// 其余清空为合法空值。模板里如果有别的顶层字段（比如提示词模板）保留结构不保留值。
const ledgerSeed = readJsonSafe(join(TEMPLATE, "ledger.json")) || {};
const ledger = {
  ...ledgerSeed,
  project: {
    name: projectName,
    subtitle,
    slug,
  },
  updatedAt: new Date().toISOString(),
  headline: `${projectName} 的项目报文`,
  conclusion: "看板刚建好，还没有内容。",
  highlights: [],
  metrics: [],
  snapshot: { phase: "建设中", focus: "" },
  items: [],
  history: [],
};
writeFileSync(join(outDir, "ledger.json"), JSON.stringify(ledger, null, 2), "utf8");

// ── package.json（干净形态）────────────────────────────────────

const pkg = {
  name: toNpmName(projectName),
  version: "0.1.0",
  private: true,
  description: `${projectName} 项目工作报文：一份台账 JSON 渲染成一份可查、可问的工作看板`,
  type: "module",
  scripts: {
    render: "node scripts/render.mjs",
    verify: "node scripts/verify-board.mjs",
    serve: "node scripts/serve.mjs",
    build: "node scripts/render.mjs && node scripts/verify-board.mjs",
  },
  engines: { node: ">=18" },
};
writeFileSync(join(outDir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");

// ── README（说明怎么用）────────────────────────────────────────

writeFileSync(join(outDir, "README.md"), readmeText(projectName), "utf8");

// ── 渲染一份静态成品（可选）───────────────────────────────────

if (!has("no-render")) {
  const r = spawnSync(
    process.execPath,
    [join(outDir, "scripts", "render.mjs"), "--board", outDir],
    { stdio: "inherit", cwd: outDir, encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error("导出后渲染失败，请检查。");
    process.exit(1);
  }
  console.log(`已生成静态成品：${join(outDir, "dist", "index.html")}`);
}

console.log(`\n完成。这份是干净的、可独立跑、可上 GitHub / Gitee 的项目：\n  ${outDir}`);
console.log(`在里面跑 npm run serve 就有 http://127.0.0.1:8790 ；放 Harness 侧栏也能直接问 AI。`);

// ── helpers ────────────────────────────────────────────────────

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function toNpmName(s) {
  return "ops-" + s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ops-board";
}

function readmeText(name) {
  return `# ${name} 项目工作报文

一份台账 JSON（ledger.json）渲染成一份可查、可问的工作看板页面。

## 是什么

- 数据全在 \`ledger.json\` + \`board.config.json\`，没有数据库。
- \`node scripts/render.mjs\` 把它渲染成 \`dist/index.html\`（单文件自包含，双击/静态托管即看）。
- 每条问题可以展开看四段：具体表现 / 影响 / 解决办法 / 复核方式，并留证据线索。

## 开始

\`\`\`bash
npm run build      # render + verify
npm run serve      # http://127.0.0.1:8790
\`\`\`

或直接双击 \`dist/index.html\` 看静态版。

## 结构

\`\`\`
├─ ledger.json          ← 有什么内容：结论、指标、条目、处理记录
├─ board.config.json    ← 怎么呈现：车道、状态机、视图、提示词
├─ scripts/             ← 渲染 / 自检 / 本地服务（完整脚本，可独立跑）
└─ dist/index.html      ← 渲染出来的静态成品
\`\`\`

## 对接 AI（可选）

放进 DeepSeek Harness 的 ops-board 插件侧栏打开时，条目上的「问 AI」会
交给 Harness 会话回答，自动带上条目上下文 + 回答规则。没有 Harness 时点发送，
页面会提示去 Harness 里打开——静态看板本身不受影响。

## 维护台账

往 \`ledger.json\` 的 \`items\` 数组加条目。改 \`board.config.json\` 调车道 / 严重度 / 视图 / 提示词，
代码不用动。\`verify-board.mjs\` 会拦住结构错误和没人读的配置字段。
`;
}

// 和插件侧同一套 slug 规则：小写、非 a-z0-9 变连字符。（与 DSH 插件 index.js 的 slugify 保持一致）
function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}