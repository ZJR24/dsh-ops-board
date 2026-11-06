#!/usr/bin/env node
// scripts/render.mjs — 把 ledger.json + board.config.json 渲染成一份 dist/index.html
//
// 用法：
//   node scripts/render.mjs                          # 用默认的两个文件
//   node scripts/render.mjs ../别的台账.json          # 指定台账
//   node scripts/render.mjs --out ../x.html           # 指定输出
//
// 设计原则：
//   1. 只生成一份 HTML（用 hash 区分视图），不为每个视图复制文件
//   2. 认识的字段缺了要报错，不认识的字段一律忽略
//   3. 校验一次列全，不边渲染边崩
//   4. 视觉照报纸体例：纸纹底 + 内框、双线报头、居中导航

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCss } from "./lib/css.mjs";
import {
  esc,
  viewId,
  laneByKey,
  stageOfStatus,
  itemsOfLane,
  countOfLane,
  openCountOfLane,
  isClosedLaneItem,
  sortItems,
  severityOf,
  railLanePanel,
  railPriorityPanel,
  railMetricsPanel,
  railSnapshotPanel,
  itemCard,
  itemTable,
  stageBlock,
  stageBoard,
  legend,
  historyList,
  highlights,
  actionsList,
  openIndexLines,
  askOff,
} from "./lib/parts.mjs";
import { boardContext } from "./lib/context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT = resolve(HERE, "..");

// 看板目录（数据所在处）和模板目录（脚本所在处）现在是两个地方：
// 项目里只放数据，脚本从模板读。三种确定看板目录的方式，优先级从高到低：
//   1. 显式传 --board <目录>
//   2. 环境变量 OPS_BOARD_DIR（前端的入口文件会设）
//   3. 脚本自己就在看板目录里（老的单副本布局，向后兼容）
function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "";
}

function detectBoardDir() {
  const explicit = argValue("board") || process.env.OPS_BOARD_DIR || "";
  if (explicit) return resolve(explicit);
  return TEMPLATE_ROOT;
}

const BOARD_DIR = detectBoardDir();
const ROOT = BOARD_DIR;

const ledgerPath = resolve(
  process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : join(ROOT, "ledger.json")
);
const configPath = resolve(
  process.argv.indexOf("--config") > -1 ? process.argv[process.argv.indexOf("--config") + 1] : join(ROOT, "board.config.json")
);
const outPath = resolve(
  process.argv.indexOf("--out") > -1 ? process.argv[process.argv.indexOf("--out") + 1] : join(ROOT, "dist", "index.html")
);

// skills.json 由 scripts/collect-skills.mjs 生成；没有就当作「还没统计」。
const skillsPath = resolve(
  process.argv.indexOf("--skills") > -1
    ? process.argv[process.argv.indexOf("--skills") + 1]
    : join(ROOT, "skills.json")
);
let skillsData = null;
try {
  skillsData = JSON.parse(readFileSync(skillsPath, "utf8"));
} catch {
  skillsData = null;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function fmtDate(iso) {
  return iso ? String(iso).slice(0, 16).replace("T", " ") : "";
}

// ────────────────────────── 校验 ──────────────────────────

function validate(config, ledger) {
  const errors = [];
  const warnings = [];

  // 数据格式版本。以前这个字段只写不读，改格式时旧看板会静默渲染出错的东西；
  // 现在认一下：不认识的版本直接报错，让人知道该迁移，而不是对着一页乱码猜。
  const SUPPORTED_SCHEMA = 2;
  for (const [label, doc] of [
    ["board.config.json", config],
    ["ledger.json", ledger],
  ]) {
    const v = doc.schemaVersion;
    if (v === undefined) {
      warnings.push(`${label} 没有 schemaVersion，按当前版本（${SUPPORTED_SCHEMA}）处理`);
    } else if (v !== SUPPORTED_SCHEMA) {
      errors.push(
        `${label} 的 schemaVersion=${v}，本模板只认 ${SUPPORTED_SCHEMA}。` +
          `确认字段结构确实一致后，把该字段改成 ${SUPPORTED_SCHEMA}；不一致就先按新结构改数据。`
      );
    }
  }

  if (!ledger.project || !ledger.project.name) errors.push("ledger.project.name 缺失");
  if (!Array.isArray(ledger.items)) errors.push("ledger.items 必须是数组");
  if (!Array.isArray(config.lanes) || !config.lanes.length) errors.push("config.lanes 至少要有 1 条车道");

  for (const [i, lane] of config.lanes.entries()) {
    if (!lane.key) errors.push(`config.lanes[${i}] 缺 key`);
    if (!Array.isArray(lane.stages) || !lane.stages.length) errors.push(`车道 ${lane.key} 没有定义 stages`);
    const seen = new Set();
    for (const st of lane.stages || []) {
      for (const s of st.statuses || []) {
        if (seen.has(s)) warnings.push(`车道 ${lane.key} 的状态 ${s} 出现在多个阶段，只按第一个算`);
        seen.add(s);
      }
    }
  }

  const ids = new Set();
  for (const [i, item] of (ledger.items || []).entries()) {
    const at = `items[${i}]${item && item.id ? " " + item.id : ""}`;
    if (!item.id) errors.push(`${at} 缺 id`);
    if (!item.title) errors.push(`${at} 缺 title`);
    if (!item.lane) errors.push(`${at} 缺 lane`);
    if (ids.has(item.id)) errors.push(`${at} 的 id 重复`);
    ids.add(item.id);

    const lane = laneByKey(config, item.lane);
    if (!lane) {
      errors.push(`${at} 的 lane="${item.lane}" 在 config.lanes 里找不到`);
      continue;
    }
    if (!stageOfStatus(lane, item.status)) {
      errors.push(
        `${at} 的 status="${item.status}" 不在车道 ${lane.key} 的任何阶段里。` +
          `可用：${lane.stages.flatMap((s) => s.statuses).join(" / ")}`
      );
    }
    if (lane.prefix && !String(item.id).startsWith(lane.prefix + "-")) {
      warnings.push(`${at} 的编号没有用 ${lane.prefix}- 前缀`);
    }
    if (lane.severity && item.severity) {
      const ok = lane.severity.levels.some((l) => l.key === item.severity);
      if (!ok) warnings.push(`${at} 的 severity="${item.severity}" 不在等级表里`);
    }
    if (!Array.isArray(item.sections) || !item.sections.length) {
      warnings.push(`${at} 没有 sections，卡片会只剩标题`);
    }
  }

  for (const v of config.views || []) {
    if (v.kind === "lane" && !laneByKey(config, v.lane)) {
      errors.push(`视图 ${v.key} 指向的车道 ${v.lane} 不存在`);
    }
  }

  return { errors, warnings };
}

// ────────────────────────── 页面部件 ──────────────────────────

function topbar(config, ledger) {
  const swatches = [
    ["night", "夜晚"],
    ["eye", "护眼"],
    ["paper", "纸面"],
  ]
    .map(
      ([k, label]) =>
        `<button class="theme-swatch" type="button" data-theme="${k}"><i></i>${label}</button>`
    )
    .join("");
  return `<div class="topbar">
  <span>${esc(ledger.project.name)} · 台账</span>
  <div class="topbar-right">
    <span>更新 ${esc(fmtDate(ledger.updatedAt))}</span>
    <div class="theme-picker">${swatches}</div>
  </div>
</div>`;
}

function masthead(config, ledger) {
  const ears = config.lanes.slice(0, 2).map((lane) => {
    const items = itemsOfLane(ledger, lane.key);
    const openN = openCountOfLane(lane, items);
    return {
      lane,
      items: items.length,
      openN,
      closedN: items.length - openN,
    };
  });

  const earHtml = (e, side) =>
    e
      ? `<div class="ears ${side}"><span>${esc(e.lane.label)}</span><b>${e.items} 项</b><em>${esc(e.lane.openNoun)} ${e.openN} · 已收口 ${e.closedN}</em></div>`
      : "";

  return `<header class="masthead">
  ${earHtml(ears[0], "left")}
  <h1>${esc(ledger.project.name)}</h1>
  <div class="en">${esc(ledger.project.subtitle || "")}</div>
  ${earHtml(ears[1], "right")}
</header>`;
}

function nav(config) {
  const links = (config.views || [])
    .map((v) => `<a data-view href="#${viewId(v.key)}">${esc(v.label)}</a>`)
    .join("");
  return `<nav class="nav">${links}</nav>`;
}

// ── Skill 统计（总览页单独一块） ──

function relTime(iso) {
  if (!iso) return "";
  const t = typeof iso === "number" ? iso : new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const day = 86400000;
  if (diff < 3600000) return "刚刚";
  if (diff < day) return Math.round(diff / 3600000) + " 小时前";
  if (diff < day * 30) return Math.round(diff / day) + " 天前";
  return fmtDate(new Date(t).toISOString());
}

function skillRow(config, item, extra, group) {
  const title = item.title && item.title !== item.name ? item.title : "";
  const desc = (item.description || "").split(/[。.！!\n]/)[0].slice(0, 90);
  return `<li class="skill-row" data-skill="${esc(item.name)}" data-skill-group="${esc(group || "")}">
    <span class="skill-name">${esc(item.name)}</span>
    ${item.version ? `<span class="skill-ver">v${esc(item.version)}</span>` : ""}
    ${item.agentCreated ? '<span class="skill-flag">agent 生成</span>' : ""}
    ${extra ? `<span class="skill-meta">${extra}</span>` : ""}
    ${askOff(config) ? "" : `<button class="btn btn-ask" type="button" data-ask-skill="${esc(item.name)}" data-ask-skill-group="${esc(group || "")}">问 AI</button>`}
    ${title ? `<span class="skill-title">${esc(title)}</span>` : ""}
    ${desc ? `<span class="skill-desc">${esc(desc)}</span>` : ""}
  </li>`;
}

// Skill 统计整页（独立视图）。三组固定都在——没有数据也把分组摆出来，
// 用户才知道这页统计什么、该跑哪条命令。
function viewSkills(config, ledger) {
  const data = skillsData;
  const used = (data && data.used) || [];
  const produced = (data && data.produced) || [];
  const related = (data && data.related) || [];
  const hint = data
    ? ""
    : "还没统计：运行 <code>node scripts/collect-skills.mjs --project &lt;项目目录&gt;</code>；看板每次刷新会自动重算。";

  const usedList = used.length
    ? `<ul class="skill-list">${used
        .map((s) =>
          skillRow(
            config,
            { name: s.name, title: "", description: "" },
            `${s.sessions} 个会话 · 共调 ${s.total} 次${s.lastAt ? " · " + relTime(s.lastAt) : ""}`,
            "used",
          ),
        )
        .join("")}</ul>`
    : `<p class="stage-empty">${hint || "Harness 会话里还没调用过 skill 工具。"}</p>`;

  const producedList = produced.length
    ? `<ul class="skill-list">${produced.map((s) => skillRow(config, s, "", "produced")).join("")}</ul>`
    : `<p class="stage-empty">${hint || "项目目录里没有 SKILL.md。"}</p>`;

  const relatedList = related.length
    ? `<ul class="skill-list">${related
        .map((s) => skillRow(config, s, s.inFrontmatter ? "说明里点名本项目" : `正文提到 ${s.hits} 次`, "related"))
        .join("")}</ul>`
    : `<p class="stage-empty">${hint || "没有为这个项目单独写的 skill。"}</p>`;

  const total = used.length + produced.length + related.length;

  return `<section class="view" data-view="skills" id="${viewId("skills")}">
  <div class="details-main">
    <div class="kicker">Skill 统计 · ${esc(config.labels.skillsTitle || "Agent 用过的与产出的")}</div>
    <h1 class="details-title">Skill 台账</h1>
    <p class="deck">这个项目的 Skill 从三个地方来：Harness 会话里真的调用过的、项目自己产出的、以及专门为它写的。${data && data.updatedAt ? `统计于 ${relTime(data.updatedAt)}。` : "还没有统计过。"}</p>
    <p class="rail-note">项目目录：${data && data.project ? `<code>${esc(data.project)}</code>` : "未登记"}${data && data.projectNames && data.projectNames.length ? ` · 别名：${esc(data.projectNames.join(" / "))}` : ""}</p>
    <section class="issue-section">
      <div class="section-head"><h2>问 AI</h2><span>先选动作，再点「发送」${askOff(config) ? "" : '<button class="btn btn-ask head-ask" type="button" data-ask-skills>问整页 Skill</button>'}</span></div>
      <p class="stage-empty" style="border:0;padding:0">这一页的每条 skill 旁边也有「问 AI」；点哪条就围绕哪条问，点上面这个按钮则针对整页。</p>
    </section>
    <div class="stage-board">
      <div class="stage-board-total"><span class="stage-board-num">${total}</span><span class="stage-board-label">共 ${total} 个 Skill</span></div>
      <div class="stage-board-table" style="grid-template-columns:repeat(3,1fr)">
        <a class="stage-board-cell" href="#skill-group-used"><b>${used.length}</b><span>会话里用过的</span></a>
        <a class="stage-board-cell" href="#skill-group-produced"><b>${produced.length}</b><span>项目产出的</span></a>
        <a class="stage-board-cell" href="#skill-group-related"><b>${related.length}</b><span>为它写的</span></a>
      </div>
    </div>
    <section class="skill-group" id="skill-group-used" data-skill-group="used">
      <h2>会话里用过的</h2>
      <p class="rail-note">Harness 会话日志里 <code>skill</code> 工具真的被调用的记录；只算工作目录属于这个项目（项目目录 / 看板目录）的会话。</p>
      ${usedList}
    </section>
    <section class="skill-group" id="skill-group-produced" data-skill-group="produced">
      <h2>项目产出的</h2>
      <p class="rail-note">项目目录里带 <code>SKILL.md</code> 的；frontmatter 写了 <code>agent_created: true</code> 的标「agent 生成」。</p>
      ${producedList}
    </section>
    <section class="skill-group" id="skill-group-related" data-skill-group="related">
      <h2>为它写的</h2>
      <p class="rail-note">skill 根里的 SKILL.md，说明里点名这个项目，或正文反复提到它（只在命令示例里出现一次的不算）。</p>
      ${relatedList}
    </section>
  </div>
</section>`;
}

function viewOverview(config, ledger) {
  const laneTables = config.lanes
    .map((lane) => {
      const items = sortItems(lane, itemsOfLane(ledger, lane.key));
      return `<section class="issue-section">
  <div class="section-head"><h2>${esc(lane.label)}一览</h2><span>共 ${items.length} 个 · ${esc(config.labels.overviewHint)}</span></div>
  ${itemTable(config, lane, items)}
</section>`;
    })
    .join("");

  const hl = (ledger.highlights || []).length
    ? `<section class="highlights">
  <div class="subhead"><h3>本轮要点</h3><span>写用户能感知到的结果</span></div>
  ${highlights(ledger)}
</section>`
    : "";

  return `<section class="view" data-view="overview" id="${viewId("overview")}">
  <div class="main-col">
    <div class="lead">
      <div class="kicker">本轮结论</div>
      <h1>${esc(ledger.headline || "")}</h1>
      ${ledger.deck ? `<p class="deck">${esc(ledger.deck)}</p>` : ""}
      ${ledger.conclusion ? `<div class="lead-copy"><p>${esc(ledger.conclusion)}</p></div>` : ""}
    </div>
    ${hl}
    <section class="issue-section">
      <div class="section-head"><h2>${esc(config.priority.label)}</h2><span>按严重度取前 ${config.priority.limit} 条${askOff(config) ? "" : '<button class="btn btn-ask head-ask" type="button" data-ask-global>问整本台账</button>'}</span></div>
      ${actionsList(config, ledger)}
    </section>
    ${laneTables}
    <div class="history" data-history-section>
      <div class="section-head"><h2>${esc(config.labels.historyTitle)}</h2><span class="history-sub" data-default="共 ${(ledger.history || []).length} 条 · 最近的在下" aria-live="polite">共 ${(ledger.history || []).length} 条 · 最近的在下</span></div>
      ${historyList(ledger.history || [])}
    </div>
  </div>
</section>`;
}

function viewLane(config, ledger, lane) {
  const items = itemsOfLane(ledger, lane.key);
  const blocks = lane.stages.map((st) => stageBlock(config, lane, st, items)).join("");

  return `<section class="view" data-view="lane-${lane.key}" id="${viewId("lane:" + lane.key)}">
  <div class="details-main">
    <div class="kicker">${esc(lane.label)}</div>
    <h1 class="details-title">按阶段推进</h1>
    <p class="deck">共 ${items.length} 个${esc(lane.countNoun)}，${esc(lane.openNoun)} ${openCountOfLane(lane, items)} 个。已收口的在「已修复 / 已关闭 / 暂停」页。</p>
    ${stageBoard(lane, items)}
    ${blocks}
    ${legend(config, lane)}
    <div class="history" data-history-section>
      <div class="section-head"><h2>${esc(config.labels.historyTitle)}</h2><span class="history-sub" data-default="只列与${esc(lane.label)}相关的记录" aria-live="polite">只列与${esc(lane.label)}相关的记录</span></div>
      ${historyList(ledger.history || [], [lane.prefix])}
    </div>
  </div>
</section>`;
}

// 「问题修复」只放还在推进的条目（未收口）；收口的都在这一页，跟原版一样：
// 原版这一页是「已修复 / 已关闭 / 暂停」，两页的内容互不重叠。
function viewClosed(config, ledger) {
  const groups = config.lanes
    .map((lane) => {
      const items = sortItems(lane, itemsOfLane(ledger, lane.key).filter((i) => isClosedLaneItem(lane, i)));
      if (!items.length) return "";
      const stages = lane.stages.filter((s) => !s.open);
      const kinds = stages
        .map((s) => `${esc(s.label)} ${items.filter((i) => s.statuses.includes(i.status)).length}`)
        .join(" · ");
      return `<section class="detail-group" id="stage-${lane.key}-closed">
  <div class="section-head"><h2>${esc(lane.label)} · 已收口</h2><span>${kinds} · 共 ${items.length} 项</span></div>
  ${items.map((i) => itemCard(config, lane, i)).join("")}
</section>`;
    })
    .filter(Boolean)
    .join("");

  return `<section class="view" data-view="closed" id="${viewId("closed")}">
  <div class="details-main">
    <div class="kicker">已修复 / 已关闭 / 暂停</div>
    <h1 class="details-title">收口记录</h1>
    <p class="deck">这些条目已经有实测证据或明确结论，留档备查；「问题修复」页只放还在推进的。</p>
    ${groups || `<p class="stage-empty">还没有已收口的条目。</p>`}
  </div>
</section>`;
}

// ────────────────────────── AI 面板 ──────────────────────────

function aiPanel(config) {
  if (!config.ask || config.ask.enabled === false) return "";
  // 面板只负责「选动作 / 写问题 / 发送」。
  // 接入点、密钥、模型、体检这些都不在这里 —— 那是 Harness 的事，
  // 模板碰了就等于把密钥管理搬进每个项目副本里。
  return `<aside class="ai-panel" id="ai-panel" aria-label="台账助手">
  <div class="ai-head">
    <h3>${esc(config.ask.title || "台账助手")}</h3>
    <span class="ctx" id="ai-ctx">整本台账</span>
    <button type="button" id="ai-new" title="下一条发送新开一个 Harness 会话">新会话</button>
    <button type="button" id="ai-close" aria-label="关闭">×</button>
  </div>
  <div class="ai-msgs" id="ai-msgs"></div>
  <div class="ai-quick" id="ai-quick"></div>
  <div class="ai-compose">
    <textarea id="ai-input" placeholder="选一个动作，或直接写你要它做的事"></textarea>
    <div class="send-row">
      <span class="send-hint" id="ai-hint"></span>
      <button class="btn-send" type="button" id="ai-send">发送</button>
    </div>
  </div>
</aside>`;
}

// ────────────────────────── 组装 ──────────────────────────

function buildHtml(config, ledger) {
  const views = (config.views || [])
    .map((v) => {
      if (v.kind === "overview") return viewOverview(config, ledger);
      if (v.kind === "lane") return viewLane(config, ledger, laneByKey(config, v.lane));
      if (v.kind === "closed") return viewClosed(config, ledger);
      if (v.kind === "skills") return viewSkills(config, ledger);
      return "";
    })
    .join("\n");

  const rail = [
    ...config.lanes.map((lane) => railLanePanel(config, ledger, lane)),
    railPriorityPanel(config, ledger),
    railMetricsPanel(config, ledger),
    railSnapshotPanel(config, ledger),
  ].join("\n");

  const clientJs = readFileSync(join(HERE, "lib", "client.js"), "utf8");
  const boardData = JSON.stringify(boardContext(config, ledger, skillsData)).replace(/</g, "\\u003c");
  const title = `${ledger.project.name} · ${ledger.project.subtitle || ""}`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(config.theme || "night")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${buildCss()}</style>
</head>
<body>
<div class="page">
${topbar(config, ledger)}
${masthead(config, ledger)}
${nav(config)}
<div class="layout">
<aside class="rail"><button class="rail-toggle" type="button" id="rail-toggle" aria-controls="rail-body" aria-expanded="true" aria-label="收起侧栏" title="收起 / 展开侧栏（快捷键 [ ）"></button><div class="rail-body" id="rail-body">
${rail}
</div></aside>
<div class="views">
${views}
</div>
</div>
</div>
${aiPanel(config)}
<script type="application/json" id="board-data">${boardData}</script>
<script>${clientJs}</script>
</body>
</html>`;
}

// ────────────────────────── main ──────────────────────────

function main() {
  if (!existsSync(ledgerPath)) {
    console.error(`找不到台账：${ledgerPath}`);
    process.exit(1);
  }
  if (!existsSync(configPath)) {
    console.error(`找不到配置：${configPath}`);
    process.exit(1);
  }

  const ledger = readJson(ledgerPath);
  const config = readJson(configPath);
  const { errors, warnings } = validate(config, ledger);

  if (warnings.length) {
    console.log(`\n提醒 ${warnings.length} 条：`);
    for (const w of warnings) console.log("  · " + w);
  }
  if (errors.length) {
    console.error(`\n数据有问题，共 ${errors.length} 处，先修数据再渲染：`);
    for (const e of errors) console.error("  × " + e);
    process.exit(1);
  }

  const html = buildHtml(config, ledger);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");

  const sizeKb = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
  const laneStat = config.lanes
    .map((l) => {
      const items = itemsOfLane(ledger, l.key);
      return `${l.label} ${items.length}（${l.openNoun} ${openCountOfLane(l, items)}）`;
    })
    .join(" · ");

  console.log(`\n已生成：${outPath}`);
  console.log(`体积：${sizeKb} KB · 视图 ${(config.views || []).length} 个 · 条目 ${ledger.items.length} 条 · 记录 ${(ledger.history || []).length} 条`);
  console.log(`分布：${laneStat}`);
  console.log(`打开：file:///${outPath.replace(/\\/g, "/")}\n`);
  return { outPath, ledger, config, sizeKb };
}

// 作为库被入口文件 import 时不要自动跑（入口会自己调 run）。
// 直接 `node scripts/render.mjs` 时按老样子执行。
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();

export { main as run };

