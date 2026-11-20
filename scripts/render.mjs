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
  closedBoard,
  legend,
  historyList,
  openIndexLines,
  askOff,
  sectionHead,
} from "./lib/parts.mjs";
import { boardContext } from "./lib/context.mjs";
// buildFlow 曾用于渲染工作流画布。画布 2026-11-18 去掉，工作流页同日删除，
// 渲染器已不再需要它（serve.mjs 仍在用它算 API 的并行/冲突）。

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

function masthead(config, ledger) {
  // 2026-11-19 起报头是一行三栏（原来那截「项目名 · 台账 ｜ 更新 … ｜ 三个按钮」自己占一行浮在上面）：
  //   左翼「台账 · 更新 &lt;时间&gt;」 ｜ 中间项目名 + 副标题 ｜ 右翼「夜晚 / 护眼 / 纸面」+「导出 / 搜索 / 设置」。
  // 项目名因此只出现一次 —— 顶栏原来又把书名重复了一遍。
  // .topbar / .topbar-right / .topbar-btn / .theme-swatch 这几个类名刻意一个不改：
  // 独立窗口形态（?chat=1）的隐藏规则和几套自检脚本都按它们定位。
  // 报头两侧的统计耳朵（「问题 N 项 / 未收口 M · 已收口 K」）早已去掉（2026-11-16）。
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
  return `<header class="masthead">
  <div class="topbar"><span>台账 · 更新 ${esc(fmtDate(ledger.updatedAt))}</span></div>
  <div class="masthead-title">
    <h1>${esc(ledger.project.name)}</h1>
    <div class="en">${esc(ledger.project.subtitle || "")}</div>
  </div>
  <div class="topbar-right">
    <div class="theme-picker">${swatches}</div>
    <button class="topbar-btn" type="button" id="export-open" title="导出日报 / 周报 / 月报">导出</button>
    <button class="topbar-btn" type="button" id="finder-open" title="搜这块板（Ctrl+F）">搜索</button>
    <button class="topbar-btn" type="button" id="settings-open" title="看板设置">设置</button>
  </div>
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
    <div class="stage-board">
      <div class="stage-board-total"><span class="stage-board-num">${total}</span><span class="stage-board-label">共 ${total} 个 Skill</span></div>
      <div class="stage-board-table" style="grid-template-columns:repeat(3,1fr)">
        <a class="stage-board-cell" href="#skill-group-used"><b>${used.length}</b><span>会话里用过的</span></a>
        <a class="stage-board-cell" href="#skill-group-produced"><b>${produced.length}</b><span>项目产出的</span></a>
        <a class="stage-board-cell" href="#skill-group-related"><b>${related.length}</b><span>为它写的</span></a>
      </div>
    </div>
    <section class="issue-section">
      ${sectionHead({
        title: "问 AI",
        meta: `先选动作，再点「发送」${askOff(config) ? "" : '<button class="btn btn-ask head-ask" type="button" data-ask-skills>问整页 Skill</button>'}`,
        key: "skills-ask",
      })}
      <div data-fold-body="skills-ask"><p class="stage-empty" style="border:0;padding:0">这一页的每条 skill 旁边也有「问 AI」；点哪条就围绕哪条问，点上面这个按钮则针对整页。</p></div>
    </section>
    <section class="skill-group" id="skill-group-used" data-skill-group="used">
      ${sectionHead({ title: "会话里用过的", key: "skills-used" })}
      <div data-fold-body="skills-used">
      <p class="rail-note">Harness 会话日志里 <code>skill</code> 工具真的被调用的记录；只算工作目录属于这个项目（项目目录 / 看板目录）的会话。</p>
      ${usedList}
      </div>
    </section>
    <section class="skill-group" id="skill-group-produced" data-skill-group="produced">
      ${sectionHead({ title: "项目产出的", key: "skills-produced" })}
      <div data-fold-body="skills-produced">
      <p class="rail-note">项目目录里带 <code>SKILL.md</code> 的；frontmatter 写了 <code>agent_created: true</code> 的标「agent 生成」。</p>
      ${producedList}
      </div>
    </section>
    <section class="skill-group" id="skill-group-related" data-skill-group="related">
      ${sectionHead({ title: "为它写的", key: "skills-related" })}
      <div data-fold-body="skills-related">
      <p class="rail-note">skill 根里的 SKILL.md，说明里点名这个项目，或正文反复提到它（只在命令示例里出现一次的不算）。</p>
      ${relatedList}
      </div>
    </section>
  </div>
</section>`;
}

// 「待处理问题」「待处理风险」这两块：整块内容原样搬到了各自的车道页
// （问题修复 / 风险），紧跟在页首那块状态表后面 —— 总览不再重复铺一遍整表。
// 所以这里提到模块级，两处共用同一份渲染，标题文案和作用域按钮都不变。
//
// headAsk 是这一块标题右侧的入口按钮：问题块给「总结项目状态」（整本台账作用域），
// 风险块给「风险审核」（只审风险这个车道）。
function pendingSection(config, ledger, lane, title, emptyText, headAsk) {
  if (!lane) return "";
  const openOfLane = (l) => {
    const openStages = l.stages.filter((s) => s.open);
    return itemsOfLane(ledger, l.key).filter((i) => openStages.some((s) => s.statuses.includes(i.status)));
  };
  const items = sortItems(lane, openOfLane(lane));
  const body = items.length
    ? itemTable(config, lane, items)
    : `<p class="stage-empty">${esc(emptyText)}</p>`;
  const askBtn = headAsk && !askOff(config)
    ? `<button class="btn btn-ask head-ask" type="button" ${headAsk.attr}>${esc(headAsk.label)}</button>`
    : "";
  const secKey = "pending-" + lane.key;
  return `<section class="issue-section priority-block">
  ${sectionHead({ title: esc(title), meta: `${items.length} 个待处理${askBtn}`, key: secKey })}
  <div data-fold-body="${esc(secKey)}">
  ${body}
  </div>
</section>`;
}

function viewOverview(config, ledger) {
  // 总览只留工作台 + 处理记录：两个「待处理」块已经搬到各自的车道页
  // （问题 → 问题修复，风险 → 风险），当那里第一个模块的第一行。
  // 总览再铺一遍就是同一批事说两遍。
  //
  // 「一览」表也不再放了：全量条目在各车道页按阶段列全，这里放整表只是重复。
  // 这段 restLanes 的代码留着，是为了将来配置里新增别的车道时还走同一条路径
  // （当前两块看板都只有 bug / feature / risk，所以它是空的）。

  // 「需求」一览已移去「已修复 / 已关闭 / 暂停」页当第一个模块（叫「已解决」）——
  // 需求是整体收口/上线的条目，归收口页更贴切，总览不再重复铺它的整表。
  const restLanes = config.lanes.filter((l) => l.key !== "bug" && l.key !== "risk" && l.key !== "feature");

  // 「本轮要点」这块去掉了（2026-11-16 用户定）。
  // 它和别处讲的是同一批事：已上线的东西在「需求一览」的 shipped 条目里，
  // 线上版本 / 摘要覆盖率 / 定时任务在左栏 metrics 里，要人今天处理的在
  // 「待处理问题」「待处理风险」里。单独再列一遍只会越积越长，而且它靠人写，
  // 常年停在上一轮总结的时间点上。
  // ledger.highlights 字段保留（不动数据），只是不再单独成块。

  const laneTables = restLanes
    .map((lane) => {
      const items = sortItems(lane, itemsOfLane(ledger, lane.key));
      const secKey = "overview-lane-" + lane.key;
      return `<section class="issue-section">
  ${sectionHead({ title: esc(lane.label) + "一览", meta: `共 ${items.length} 个 · ${esc(config.labels.overviewHint)}`, key: secKey })}
  <div data-fold-body="${esc(secKey)}">${items.length ? itemTable(config, lane, items) : `<p class="stage-empty">这个车道暂时没有${esc(lane.countNoun)}。</p>`}</div>
</section>`;
    })
    .join("");

  const historyKey = "history-overview";
  return `<section class="view" data-view="overview" id="${viewId("overview")}">
  <div class="main-col">
    ${wbMount()}
    ${laneTables}
    <div class="history" data-history-section>
      ${sectionHead({
        title: esc(config.labels.historyTitle),
        meta: `<span class="history-sub" data-default="共 ${(ledger.history || []).length} 条 · 最近的在下" aria-live="polite">共 ${(ledger.history || []).length} 条 · 最近的在下</span>`,
        key: historyKey,
      })}
      <div data-fold-body="${esc(historyKey)}">
      ${historyList(ledger.history || [])}
      </div>
    </div>
  </div>
</section>`;
}

// 车道页顶部那块「待处理」：只有问题和风险车道有。
// 放在 stageBoard 之后 —— 2026-11-19 用户定的是「各个页面的第一个模块都是状态表」：
// 进页面先看全局数字，紧接着才是还没收口的这摊事，再往下是按阶段铺开的全量。
function lanePendingBlock(config, ledger, lane) {
  if (lane.key === "bug") {
    return pendingSection(config, ledger, lane, "待处理问题", "当前没有需要解决的问题。", {
      attr: "data-ask-global",
      label: "总结项目状态",
    });
  }
  if (lane.key === "risk") {
    return pendingSection(config, ledger, lane, "待处理风险", "当前没有待处理的风险。", {
      attr: "data-ask-risks",
      label: "风险审核",
    });
  }
  return "";
}

function viewLane(config, ledger, lane) {
  const items = itemsOfLane(ledger, lane.key);
  // 「计划中」这一阶段右侧的入口：谈的是「要加什么功能」，作用域是需求车道。
  // 只在需求车道的 planned 阶段挂，其它车道各阶段的标题栏保持原样。
  const plannedKey = lane.key === "feature"
    ? (lane.stages.find((st) => st.key === "planned") || {}).key
    : null;
  const blocks = lane.stages
    .map((st) =>
      stageBlock(
        config,
        lane,
        st,
        items,
        st.key === plannedKey
          ? { headAsk: { attr: "data-ask-feature", label: "和 AI 谈谈要加什么" } }
          : {}
      )
    )
    .join("");

  const historyKey = "history-lane-" + lane.key;
  return `<section class="view" data-view="lane-${lane.key}" id="${viewId("lane:" + lane.key)}">
  <div class="details-main">
    <div class="kicker">${esc(lane.label)}</div>
    <h1 class="details-title">按阶段推进</h1>
    ${stageBoard(lane, items)}
    ${lanePendingBlock(config, ledger, lane)}
    ${blocks}
    ${legend(config, lane)}
    <div class="history" data-history-section>
      ${sectionHead({
        title: esc(config.labels.historyTitle),
        meta: `<span class="history-sub" data-default="只列与${esc(lane.label)}相关的记录" aria-live="polite">只列与${esc(lane.label)}相关的记录</span>`,
        key: historyKey,
      })}
      <div data-fold-body="${esc(historyKey)}">
      ${historyList(ledger.history || [], [lane.prefix])}
      </div>
    </div>
  </div>
</section>`;
}

// 「问题修复」只放还在推进的条目（未收口）；收口的都在这一页，跟原版一样：
// 原版这一页是「已修复 / 已关闭 / 暂停」，两页的内容互不重叠。
// 页首那块合并状态板是第一模块（2026-11-19）：左「已收口 N」，右边把三个车道的
// 已收口阶段排成一排（已解决 / 已上线 / 暂停 / 已解除 / 已知并接受），点一格只看那一组；
// 某个状态在这一版台账里是 0，就只显示数字不给链接（分组按需渲染，指过去会是死链）。
// 第二模块才是「已解决」—— 需求的收口条目（原本在总览的「需求一览」，挪到这里并改名）。
function viewClosed(config, ledger) {
  const featureLane = laneByKey(config, "feature");
  const groups = config.lanes
    .filter((lane) => lane.key !== "feature")
    .map((lane) => {
      const items = sortItems(lane, itemsOfLane(ledger, lane.key).filter((i) => isClosedLaneItem(lane, i)));
      if (!items.length) return "";
      const stages = lane.stages.filter((s) => !s.open);
      const kinds = stages
        .map((s) => `${esc(s.label)} ${items.filter((i) => s.statuses.includes(i.status)).length}`)
        .join(" · ");
      const secKey = "closed-" + lane.key;
      return `<section class="detail-group" id="stage-${lane.key}-closed">
  ${sectionHead({ title: esc(lane.label) + " · 已收口", meta: `${kinds} · 共 ${items.length} 项`, key: secKey })}
  <div data-fold-body="${esc(secKey)}">${items.map((i) => itemCard(config, lane, i, { collapsed: true })).join("")}</div>
</section>`;
    })
    .filter(Boolean)
    .join("");

  // 已解决：需求的收口条目（已上线 / 暂停等已收口阶段），作为第一模块。
  let solved = "";
  if (featureLane) {
    const items = sortItems(featureLane, itemsOfLane(ledger, featureLane.key).filter((i) => isClosedLaneItem(featureLane, i)));
    if (items.length) {
      const kinds = featureLane.stages
        .filter((s) => !s.open)
        .map((s) => `${esc(s.label)} ${items.filter((i) => s.statuses.includes(i.status)).length}`)
        .join(" · ");
      solved = `<section class="detail-group" id="stage-feature-closed">
  ${sectionHead({ title: "已解决", meta: `${kinds} · 共 ${items.length} 项`, key: "closed-feature" })}
  <div data-fold-body="closed-feature">${items.map((i) => itemCard(config, featureLane, i, { collapsed: true })).join("")}</div>
</section>`;
    }
  }

  const emptyState = (!solved && !groups) ? `<p class="stage-empty">还没有已收口的条目。</p>` : "";

  return `<section class="view" data-view="closed" id="${viewId("closed")}">
  <div class="details-main">
    <div class="kicker">已修复 / 已关闭 / 暂停</div>
    <h1 class="details-title">收口记录</h1>
    ${closedBoard(config, ledger)}
    ${solved}
    ${groups}
    ${emptyState}
  </div>
</section>`;
}

// ────────────────────────── AI 面板 ──────────────────────────

function aiPanel(config) {
  if (!config.ask || config.ask.enabled === false) return "";
  // 面板只负责「选动作 / 写问题 / 发送」。
  // 接入点、密钥、模型、体检这些都不在这里 —— 那是 Harness 的事，
  // 模板碰了就等于把密钥管理搬进每个项目副本里。
  // data-mode / data-pinned 由 client.js 改写。不用 class 表达这两个状态，
  // 因为它们是「形态」而不是「临时高亮」，挂 data-* 更好读，也不会跟
  // verify-board 里那份「动态 class 白名单」打架。
  return `<aside class="ai-panel" id="ai-panel" aria-label="台账助手" data-mode="float" data-pinned="0">
  <div class="ai-head" id="ai-head">
    <h3>${esc(config.ask.title || "台账助手")}</h3>
    <span class="ctx" id="ai-ctx">整本台账</span>
    <button type="button" class="ai-tool" id="ai-detach" title="把这个对话窗弹成独立窗口，盖在整个 Harness 上面">弹窗</button>
    <button type="button" class="ai-tool" id="ai-pin" aria-pressed="false" title="置顶：盖在搜索和设置上面">置顶</button>
    <button type="button" class="ai-tool" id="ai-float-toggle" title="在浮窗和右侧停靠之间切换">停靠</button>
    <button type="button" id="ai-close" aria-label="关闭">×</button>
  </div>
  <div class="ai-session" id="ai-session">
    <label class="ai-mode">
      <input type="radio" name="ai-mode" value="new" id="ai-mode-new" checked />
      <span>新对话</span>
    </label>
    <label class="ai-mode">
      <input type="radio" name="ai-mode" value="reuse" id="ai-mode-reuse" />
      <span>选择对话</span>
    </label>
    <select id="ai-pick" title="选一个聊过的对话继续" disabled>
      <option value="">（还没有聊过的对话）</option>
    </select>
  </div>
  <div class="ai-body" id="ai-body">
    <div class="ai-msgs" id="ai-msgs"></div>
    <div class="ai-split" id="ai-split" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="拖动调整问答与输入的分界"></div>
    <div class="ai-foot" id="ai-foot">
      <div class="ai-quick" id="ai-quick"></div>
      <div class="ai-compose">
        <textarea id="ai-input" placeholder="选一个动作，或直接写你要它做的事"></textarea>
        <div class="send-row">
          <span class="send-hint" id="ai-hint"></span>
          <button class="btn-send" type="button" id="ai-send">发送</button>
        </div>
      </div>
    </div>
  </div>
  <span class="ai-grip" data-dir="n"></span>
  <span class="ai-grip" data-dir="s"></span>
  <span class="ai-grip" data-dir="w"></span>
  <span class="ai-grip" data-dir="e"></span>
  <span class="ai-grip" data-dir="nw"></span>
  <span class="ai-grip" data-dir="ne"></span>
  <span class="ai-grip" data-dir="sw"></span>
  <span class="ai-grip" data-dir="se"></span>
</aside>`;
}

// ────────────────────────── 搜索 / 设置浮层 ──────────────────────────

function overlays(config) {
  // 搜索这层是自己写的，不用浏览器自带的 Ctrl+F。
  // 整本台账是一个文件里的 6 个视图，看不见的视图和 AI 面板的字都还在 DOM 里，
  // 自带查找会命中一堆当前根本看不到的东西，也没法「跳到某条」。
  // 结果区留空，由 client.js 按 D.items 填。
  const viewOpts = (config.views || [])
    .map((v) => `<option value="${esc(v.key)}">${esc(v.label)}</option>`)
    .join("");

  return `<div class="finder" id="finder" role="dialog" aria-modal="false" aria-label="搜索台账">
  <div class="finder-head">
    <input class="finder-input" type="search" id="finder-input" placeholder="搜条目：编号 / 标题 / 正文 / 证据 / 领域" autocomplete="off" spellcheck="false" />
    <span class="finder-count" id="finder-count"></span>
    <button class="finder-close" type="button" id="finder-close" aria-label="关闭搜索">×</button>
  </div>
  <p class="finder-hint" id="finder-hint">Enter 打开第一条 · Esc 关闭 · Ctrl+F 随时唤出</p>
  <div class="finder-results" id="finder-results"></div>
</div>
<div class="settings" id="settings" role="dialog" aria-modal="true" aria-label="看板设置">
  <div class="settings-box">
    <div class="settings-head">
      <h3>看板设置</h3>
      <span>改完立刻生效 · 只影响这台机器</span>
      <button class="settings-close" type="button" id="settings-close" aria-label="关闭设置">×</button>
    </div>
    <div class="settings-body">

      <div class="settings-row">
        <span class="settings-label">主题</span>
        <div class="settings-ctl">
          <div class="settings-seg" id="set-theme">
            <button type="button" data-value="night">夜晚</button>
            <button type="button" data-value="eye">护眼</button>
            <button type="button" data-value="paper">纸面</button>
          </div>
        </div>
      </div>

      <div class="settings-row">
        <span class="settings-label">正文字号</span>
        <div class="settings-ctl">
          <div class="settings-seg" id="set-font">
            <button type="button" data-value="15">小</button>
            <button type="button" data-value="16">标准</button>
            <button type="button" data-value="17.5">大</button>
            <button type="button" data-value="19">特大</button>
          </div>
        </div>
        <p class="settings-note">只放大正文与正文段落，卡片上的编号、时间、按钮字号保持不变，密排的索引行不会被撑散。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label">侧栏</span>
        <div class="settings-ctl">
          <div class="settings-seg" id="set-rail">
            <button type="button" data-value="0">展开</button>
            <button type="button" data-value="1">收起</button>
          </div>
          <span class="settings-note">快捷键 [ 也能切换。</span>
        </div>
      </div>

      <div class="settings-row">
        <span class="settings-label">打开哪一页</span>
        <div class="settings-ctl">
          <select class="settings-select" id="set-view">
            <option value="">跟着上次停留的位置</option>
            ${viewOpts}
          </select>
        </div>
        <p class="settings-note">默认沿用上次看到的页面；只有还没有任何停留记录时，才用这里选的页兜底。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label">搜索范围</span>
        <div class="settings-ctl">
          <select class="settings-select" id="set-scope">
            <option value="all">全部字段</option>
            <option value="title">只搜标题与编号</option>
            <option value="body">标题 + 正文</option>
          </select>
        </div>
        <p class="settings-note">全部字段 = 编号、标题、四个正文块、证据、领域。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label">搜索选项</span>
        <div class="settings-ctl">
          <label class="settings-check"><input type="checkbox" id="set-evidence" /> 结果里带证据命中</label>
          <label class="settings-check"><input type="checkbox" id="set-hotkey" /> 用 Ctrl+F 唤出搜索</label>
        </div>
        <p class="settings-note">关掉 Ctrl+F 后仍可点顶栏「搜索」；浏览器自带的查找也会恢复。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label">本机偏好</span>
        <div class="settings-ctl">
          <button class="settings-btn" type="button" id="set-reset">恢复默认</button>
          <button class="settings-btn is-danger" type="button" id="set-clear">清空本机偏好</button>
        </div>
        <p class="settings-note" id="set-note">恢复默认只把上面几项调回出厂值；清空会连主题、侧栏、上次落点、AI 对话一起丢掉，只保留台账本身。</p>
      </div>

    </div>
  </div>
</div>
<div class="settings" id="exporter" role="dialog" aria-modal="true" aria-label="导出报表">
  <div class="settings-box">
    <div class="settings-head">
      <h3>导出报表</h3>
      <span>生成文件 · 可直接发出去</span>
      <button class="settings-close" type="button" id="export-close" aria-label="关闭导出">×</button>
    </div>
    <div class="settings-body">

      <div class="settings-row">
        <span class="settings-label">报表</span>
        <div class="settings-ctl">
          <div class="settings-seg" id="exp-mode">
            <button type="button" data-value="daily">日报</button>
            <button type="button" data-value="weekly">周报</button>
            <button type="button" data-value="monthly">月报</button>
            <button type="button" data-value="all">全量</button>
          </div>
        </div>
        <p class="settings-note" id="exp-span">日报 = 1 天，周报 = 7 天，月报 = 30 天。区间按各块板自己台账的「更新时间」往前推，不用今天的日期 —— 台账停在哪天，就从哪天往回数。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label">看板</span>
        <div class="settings-ctl">
          <div class="exp-boards" id="exp-boards">
            <p class="settings-note">正在读取看板列表…</p>
          </div>
        </div>
        <p class="settings-note">默认只勾当前这块板。勾多块时，下面的「合并 / 分开」决定怎么出。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label">输出</span>
        <div class="settings-ctl">
          <div class="settings-seg" id="exp-merge">
            <button type="button" data-value="merged">合并成一份</button>
            <button type="button" data-value="split">各项目分开</button>
          </div>
        </div>
        <p class="settings-note">合并 = 开头带一张跨项目总表，适合整体汇报；分开 = 每个项目一份文件，适合分头发给不同的人。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label">导出格式</span>
        <div class="settings-ctl">
          <label class="settings-check"><input type="checkbox" id="exp-f-md" /> Markdown</label>
          <label class="settings-check"><input type="checkbox" id="exp-f-html" /> 网页</label>
          <label class="settings-check"><input type="checkbox" id="exp-f-txt" /> 纯文本</label>
        </div>
      </div>

      <div class="settings-row">
        <span class="settings-label">保存到</span>
        <div class="settings-ctl">
          <input class="settings-select exp-path" id="exp-out" type="text" spellcheck="false" placeholder="留空则用看板目录下的 reports\\" />
          <button class="settings-btn exp-pick" type="button" id="exp-pick" title="选一个文件夹">浏览…</button>
          <button class="settings-btn exp-pick" type="button" id="exp-reset" title="改回默认位置">默认</button>
        </div>
        <p class="settings-note">留空会存到这块看板自己目录下的 <code>reports\</code> 里；也可以点「浏览…」选别处。导完下面会列出完整路径。</p>
      </div>

      <div class="settings-row">
        <span class="settings-label"></span>
        <div class="settings-ctl">
          <button class="settings-btn exp-go" type="button" id="exp-go">生成报表</button>
          <span class="exp-status" id="exp-status"></span>
        </div>
      </div>

      <div class="exp-result" id="exp-result"></div>

    </div>
  </div>
</div>`;
}

// ────────────────────────── 工作台 ──────────────────────────
//
// 这里以前是「可视化工作流」画布（绝对定位节点 + SVG 箭头 + 拖拽平移）。
// 2026-11-18 用户定：画布去掉，工作流页只剩工作台。
//
// 工作台本体：选卡 → 选串/并行 → 机器自动逐张分析。见 client.js 的 workbench。
//
// ⚠️ 整站只有这一份（单实例）。它带运行状态（WB.run / order / 执行进度），
// 如果每个视图各渲染一份，querySelector('[data-workbench]') 会取到先出现的那份，
// 另一份就成了永远不动的死壳。所以渲染一次、按当前视图「搬」过去：
//   · 输出里每个想放工作台的视图都留一个 [data-wb-mount] 空位；
//   · 初始放在第一个挂载点（总览页顶部，见 viewOverview）；
//   · client.js 的 show() 切视图时把整个节点 appendChild 到目标挂载点。
// 节点搬家不会丢事件/状态（同一个 DOM 节点），只是换了父元素。
function workbenchBlock() {
  return `<div class="workbench" data-workbench>
  <div class="workbench-head">
    <button class="section-fold" type="button" aria-expanded="true" data-fold="workbench" aria-controls="wb-body" aria-label="收起「工作台」" title="收起这一块"></button>
    <h3>工作台</h3>
    <span class="workbench-desc">拖动卡片排出执行顺序（上面先做）→ 选串行还是并行 → 点「分析」→ 确认后「开始」。机器逐张领活、交给 Harness、取回结论后自动交还推进。</span>
  </div>
  <div class="workbench-body" id="wb-body" data-fold-body="workbench">
  <div class="workbench-controls">
    <div class="workbench-pool" data-wb-pool>
      <!-- 卡片候选池：拖拽排序的执行队列，由 client.js 依据 plan 动态铺 -->
    </div>
    <div class="workbench-mode">
      <label class="wb-mode-option"><input type="radio" name="wb-mode" value="serial" checked> 串行（一次一件，每张有建议顺序）</label>
      <label class="wb-mode-option"><input type="radio" name="wb-mode" value="parallel"> 并行（每条队列一个对话窗口，多路同时推进）</label>
    </div>
    <div class="workbench-batch" data-wb-batch>
      <span class="wb-batch-label">每条队列一次喂几张（一条队列 = 一个对话窗口）：</span>
      <select class="wb-batch-size" data-wb-batch-size>
        <option value="1" selected>每批 1 张（窗口一次拿一张，做完再给它下一张）</option>
        <option value="2">每批 2 张</option>
        <option value="3">每批 3 张</option>
        <option value="5">每批 5 张</option>
        <option value="-1">整批全交（这条队列的全部卡一次给它）</option>
      </select>
    </div>
    <div class="workbench-planner" data-wb-planner-box>
      <label class="wb-mode-option"><input type="checkbox" data-wb-planner-reuse checked> 复用分析窗口（关掉 = 每次分析新开一个窗口，结论不受上一轮影响）</label>
      <span class="wb-planner-hint">并行时，「分析」会先交给一个窗口判断这批卡怎么分、会不会互相冲突；它回的计划不合法就自动回退到按区域分组。</span>
    </div>
    <div class="workbench-actions">
      <button type="button" class="btn" data-wb-analyze>分析</button>
      <button type="button" class="btn" data-wb-start disabled>开始执行</button>
      <button type="button" class="btn" data-wb-stop disabled>停止</button>
      <button type="button" class="btn" data-wb-clear>清空</button>
    </div>
  </div>
  <div class="workbench-run" data-wb-run hidden>
    <div class="workbench-run-head">
      <span class="wb-run-phase" data-wb-phase>—</span>
      <span class="wb-run-progress" data-wb-progress></span>
    </div>
    <ol class="workbench-steps" data-wb-steps></ol>
  </div>
  </div>
</div>`;
}

// 工作台的挂载点：想放工作台的视图里留个空位，工作台节点会被搬进来。
// 2026-11-18：工作流页按用户要求删掉了，现在唯一落点是总览页顶部。
// 保留这套「挂载点」机制而不是把工作台直接写死进总览页，是因为：
//   ① 以后想把工作台放到别的页（或再加一页），只加个 wbMount() 就行；
//   ② 单实例搬移的语义不依赖具体页面。
function wbMount() {
  return `<div class="wb-mount" data-wb-mount></div>`;
}

// ────────────────────────── 组装 ──────────────────────────

function buildHtml(config, ledger) {
  // 工作台只渲染一份，注入到第一个 [data-wb-mount]（现在只有总览页有挂载点）。
  // 其它视图若以后加了挂载点，初始留空，由 client.js 切过去时把节点搬进来。
  let wbInjected = false;
  const withWorkbench = (html) =>
    html.replace(/<div class="wb-mount" data-wb-mount><\/div>/, () => {
      if (wbInjected) return wbMount();
      wbInjected = true;
      return wbMount().replace("></div>", ">" + workbenchBlock() + "</div>");
    });

  const views = (config.views || [])
    .map((v) => {
      if (v.kind === "overview") return withWorkbench(viewOverview(config, ledger));
      if (v.kind === "lane") return viewLane(config, ledger, laneByKey(config, v.lane));
      if (v.kind === "closed") return viewClosed(config, ledger);
      if (v.kind === "skills") return viewSkills(config, ledger);
      // kind:"flow" 的视图已随「工作流」页一起删掉（2026-11-18）。
      // 这里不再有 flow 分支：老配置若还写着 flow，会渲染成空字符串，
      // verify-board 的「views 与导航一致」那条会立刻报出来，不会静默消失。
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
  // 分析窗口的计划校验器（planner.mjs）也内联进去：它必须和页面同源运行，
  // 因为「计划不合法就回退」要在客户端当场判，不能等一次网络往返。
  // 去掉 ESM 的 export 关键字后包进 IIFE，只暴露一个全局，避免污染。
  const plannerSrc = readFileSync(join(HERE, "lib", "planner.mjs"), "utf8")
    .replace(/^export\s+function\s+/gm, "function ")
    .replace(/^export\s+const\s+/gm, "const ");
  const plannerJs = `(function(){\n${plannerSrc}\nwindow.__WB_PLANNER__ = { extractPlanJson: extractPlanJson, validatePlan: validatePlan, fallbackLanes: fallbackLanes, resolvePlan: resolvePlan, buildPlannerPrompt: buildPlannerPrompt, PLANNER_WINDOW_KEY: PLANNER_WINDOW_KEY, EXEC_WINDOW_KEY: EXEC_WINDOW_KEY };\n})();`;
  const boardData = JSON.stringify(boardContext(config, ledger, skillsData)).replace(/</g, "\\u003c");
  const title = `${ledger.project.name} · ${ledger.project.subtitle || ""}`;

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="${esc(config.theme || "night")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<script>try{if(/[?&]chat=1(?:&|$)/.test(location.search))document.documentElement.setAttribute("data-chat","1")}catch(e){}</script>
<style>${buildCss()}</style>
</head>
<body>
<div class="page">
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
${overlays(config)}
<script type="application/json" id="board-data">${boardData}</script>
<script>${plannerJs}</script>
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

