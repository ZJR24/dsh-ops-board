#!/usr/bin/env node
// 报表导出 —— 把一块或多块看板的台账，按时间区间汇总成一份可发出去的文档。
//
// 与 render.mjs 的分工：
//   render.mjs  一份台账 → 一个可交互的看板站点（给人蹲在电脑前翻）
//   report.mjs  多份台账 × 一个时间区间 → 一份文档（给人发给别人看、存档、贴群）
// 所以这是两个东西，不能互相调用：看板站点里的信息维度是"全部"，报表只要"这段时间"。
//
// 用法：
//   node report.mjs --daily                    今天的日报
//   node report.mjs --weekly                   最近 7 天
//   node report.mjs --monthly                  最近 30 天
//   node report.mjs --all                      全部（不按时间筛）
//   node report.mjs --weekly --boards a,b      指定看板（默认全部）
//   node report.mjs --weekly --split           每个项目各出一份
//   node report.mjs --weekly --format md,txt   指定格式（默认 md,html,txt 全出）
//   node report.mjs --weekly --out D:\某处     指定输出目录
//
// 时间基准取「每块板自己台账的 updatedAt」，不是系统当前时间 —— 看板是静态产物，
// 可能几天后才打开，用 Date.now() 会把时间窗整个挪到今天，把真正该报的东西漏掉。

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(HERE, "..");
// 默认落到「当前看板目录」下的 reports\，而不是模板目录。
// 模板目录是所有看板共用的，往里写会让 A 项目的周报和 B 项目的混在一起，
// 而且模板目录以后要单独发布，不该长出一个存产物的文件夹。
const DEFAULT_OUT = join(process.cwd(), "reports");

// ── 参数 ─────────────────────────────────────────────────────

function argValue(name) {
  const i = process.argv.indexOf("--" + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : "";
}
function has(name) {
  return process.argv.includes("--" + name);
}

// 记录明细最多列这么多条。
// 月报动辄上百条，全量列出来就是一份几万字的流水账 —— 收件人不会读，
// 也淹掉了上面真正要看的那几节。只留最近的，并明确写出省了多少。
const MAX_RECORDS = 40;

const MODES = {
  daily: { key: "daily", label: "日报", span: 1, unit: "天" },
  weekly: { key: "weekly", label: "周报", span: 7, unit: "天" },
  monthly: { key: "monthly", label: "月报", span: 30, unit: "天" },
  all: { key: "all", label: "全量汇总", span: null, unit: "" },
};

const modeArg = Object.keys(MODES).find((m) => has(m));
if (!modeArg) {
  console.error(
    "用法：node report.mjs --daily|--weekly|--monthly|--all [--board 目录] [--boards id,id|all] [--split] [--format md,html,txt] [--out 目录]",
  );
  process.exit(1);
}
const MODE = MODES[modeArg];

const ALL_FORMATS = ["md", "html", "txt"];
const FORMATS = (argValue("format") || ALL_FORMATS.join(","))
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const badFormats = FORMATS.filter((f) => !ALL_FORMATS.includes(f));
if (badFormats.length || !FORMATS.length) {
  console.error(`格式只能是 ${ALL_FORMATS.join(" / ")}，收到：${badFormats.join(",") || "(空)"}`);
  process.exit(1);
}

const SPLIT = has("split");
const OUT_DIR = resolve(argValue("out") || DEFAULT_OUT);

// --board 是「单个看板目录」，跟 --boards 不是一回事：
//   --board <目录>   = 只导这一个目录（转发脚本会自己补上，所以从看板里直接跑就行）
//   --boards a,b     = 从注册表里挑几个 id
// 从看板目录里跑 `node scripts/report.mjs --weekly` 时，转发脚本补的就是 --board，
// 这时连注册表都不用读 —— 看板自己的 ledger.json 就在眼前。
const BOARD_DIR = argValue("board");

const WANT = (argValue("boards") || "all")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── 找看板 ───────────────────────────────────────────────────
//
// 注册表是唯一真相源，由插件的「看板管理」维护。三处按权威度依次试。

function readRegistry() {
  const home = process.env.DSH_HOME || "";
  const candidates = [
    process.env.OPS_BOARDS_JSON || "",
    home ? join(home, "ops-board", "boards.json") : "",
    join(TEMPLATE, "data", "boards.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (Array.isArray(j.boards) && j.boards.length) return j.boards;
    } catch {
      // 注册表坏了不该让导出整个挂掉，继续试下一个来源
    }
  }
  return [];
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// 注册表读不到时，退化成扫同级目录：只要带 ledger.json 就当一块板。
function scanBoards() {
  const roots = [
    join(dirname(TEMPLATE), "ops-board-reports"),
    join(TEMPLATE, "boards"),
  ];
  const found = [];
  for (const root of roots) {
    for (const name of readdirSafe(root)) {
      const dir = join(root, name);
      if (existsSync(join(dir, "ledger.json"))) {
        found.push({ id: name, label: name, dir });
      }
    }
  }
  return found;
}

const registry = readRegistry();
const pool = registry.length ? registry : scanBoards();

// --board <目录>：只导这一个，不查注册表。
// 从看板目录里直接跑的时候走的就是这条 —— 那块板可能根本没进注册表，
// 但它的 ledger.json 就在脚边，没理由因为"注册表里没有"就拒绝导出。
const picked = [];
if (BOARD_DIR) {
  const dir = resolve(BOARD_DIR);
  if (!existsSync(join(dir, "ledger.json"))) {
    console.error(`这不是看板目录（没有 ledger.json）：${dir}`);
    process.exit(1);
  }
  const name = basename(dir);
  picked.push({ id: name, label: name, dir });
}

// 也允许直接传绝对路径，方便导出一份不在注册表里的板。
for (const want of BOARD_DIR ? [] : WANT) {
  if (want === "all") {
    for (const b of pool) picked.push(b);
    continue;
  }
  const byId = pool.find((b) => b.id === want);
  if (byId) {
    picked.push(byId);
    continue;
  }
  // 当成路径试试
  const asPath = resolve(want);
  if (existsSync(join(asPath, "ledger.json"))) {
    picked.push({ id: asPath.split(/[\\/]/).pop(), label: asPath.split(/[\\/]/).pop(), dir: asPath });
    continue;
  }
  console.error(`找不到看板：${want}`);
}
if (!picked.length) {
  console.error("没有可导出的看板。检查 --board / --boards 参数或看板注册表。");
  process.exit(1);
}

// ── 读台账 ───────────────────────────────────────────────────

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadBoard(entry) {
  const ledgerFile = join(entry.dir, "ledger.json");
  const configFile = join(entry.dir, "board.config.json");
  const ledger = readJson(ledgerFile, null);
  if (!ledger) return { entry, error: `读不到 ${ledgerFile}` };
  const config = readJson(configFile, {}) || {};
  return { entry, ledger, config };
}

const broken = [];
const loaded = [];
for (const entry of picked) {
  const b = loadBoard(entry);
  if (b.error) broken.push({ entry, error: b.error });
  else loaded.push(b);
}
if (!loaded.length) {
  console.error("所有看板都读不出来：");
  for (const b of broken) console.error(`  ${b.entry.id}：${b.error}`);
  process.exit(1);
}

// ── 时间 ─────────────────────────────────────────────────────

const generatedAt = new Date();

function pad(n) {
  return String(n).padStart(2, "0");
}
function dayOf(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayTime(d) {
  return `${stamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 每块板各自算时间窗，基准是它自己的 updatedAt。
// 用同一个基准（比如今天）会出问题：一块 11-13 更新的板，和一块 11-05 更新的板，
// 都按"今天往前 7 天"筛，后者整个窗口里什么都没有，报出来像"这周啥也没干"。
//
// 代价是各板的窗口在日历上并不重合 —— 所以每块板都得把自己那段日子写出来，
// 否则读者会疑惑"日报里怎么有 11-13 的记录"。这一点在 report 里必须显式交代。
function windowOf(ledger) {
  const base = new Date(ledger.updatedAt || "");
  const end = Number.isFinite(base.getTime()) ? base : generatedAt;
  if (MODE.span === null) {
    return { start: null, end, baseLabel: "全部", rangeLabel: "全部记录" };
  }
  const start = new Date(end.getTime() - MODE.span * 86400000);
  return {
    start,
    end,
    baseLabel: `最近 ${MODE.span} ${MODE.unit}`,
    rangeLabel: `${dayOf(start.toISOString())} → ${dayOf(end.toISOString())}`,
  };
}

function inWindow(win, iso) {
  if (!iso) return false;
  if (!win.start) return true;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= win.start.getTime() && t <= win.end.getTime() + 86400000;
}

function daysSince(ledger, item) {
  if (!item.updatedAt) return null;
  const then = new Date(item.updatedAt).getTime();
  if (!Number.isFinite(then)) return null;
  const base = new Date(ledger.updatedAt || "").getTime();
  const ref = Number.isFinite(base) ? base : Date.now();
  const d = Math.floor((ref - then) / 86400000);
  return d < 0 ? 0 : d;
}

// ── 取数 ─────────────────────────────────────────────────────

const NEXT_LABELS = ["解决办法", "下一步", "怎么解决", "后续"];

function nextStepOf(config, item) {
  const secs = item.sections || [];
  if (!secs.length) return "";
  const want = (config.labels && config.labels.nextStepSection) || "";
  if (want) {
    const hit = secs.find((s) => String(s.label || "").trim() === want);
    if (hit) return String(hit.text || "").trim();
  }
  const known = secs.find((s) => NEXT_LABELS.includes(String(s.label || "").trim()));
  return known ? String(known.text || "").trim() : "";
}

// 「收口」= 落在最后一个关掉的阶段里。各板阶段名不一样，所以从 config 推，不写死状态值。
function closedStatuses(config) {
  const set = new Set();
  const lanes = config.lanes || [];
  for (const lane of lanes) {
    const stages = lane.stages || [];
    if (!stages.length) continue;
    const last = stages[stages.length - 1];
    if (last && !last.open) for (const s of last.statuses || []) set.add(s);
  }
  return set;
}

function openStatuses(config) {
  const set = new Set();
  for (const lane of config.lanes || []) {
    for (const st of lane.stages || []) {
      if (st.open) for (const s of st.statuses || []) set.add(s);
    }
  }
  return set;
}

function collect(b) {
  const { ledger, config } = b;
  const win = windowOf(ledger);
  const closed = closedStatuses(config);
  const open = openStatuses(config);

  const touched = [];
  const movedHistory = [];
  const openItems = [];
  const closedHere = [];

  for (const item of ledger.items || []) {
    const isClosed = closed.has(item.status);
    const isOpen = open.has(item.status) || (!closed.has(item.status) && !open.size);
    if (isOpen && !isClosed) openItems.push(item);
    if (isClosed && inWindow(win, item.updatedAt)) closedHere.push(item);
    if (inWindow(win, item.updatedAt)) touched.push(item);
  }

  for (const h of ledger.history || []) {
    if (inWindow(win, h.at)) movedHistory.push(h);
  }

  return { entry: b.entry, ledger, config, win, touched, movedHistory, open: openItems, closedHere };
}

const collected = loaded.map(collect);

// ── 汇总 ─────────────────────────────────────────────────────

function summarize(set) {
  let openTotal = 0;
  let movedTotal = 0;
  let closedTotal = 0;
  const bySeverity = { high: 0, mid: 0, low: 0 };
  const stale = [];

  for (const c of set) {
    openTotal += c.open.length;
    movedTotal += c.movedHistory.length;
    closedTotal += c.closedHere.length;
    for (const i of c.open) {
      const sev = String(i.severity || "").toLowerCase();
      if (sev === "high" || sev === "高") bySeverity.high += 1;
      else if (sev === "mid" || sev === "medium" || sev === "中") bySeverity.mid += 1;
      else bySeverity.low += 1;
      const d = daysSince(c.ledger, i);
      if (d !== null && d >= 7) stale.push({ board: c, item: i, days: d });
    }
  }
  stale.sort((a, b) => b.days - a.days);
  return { openTotal, movedTotal, closedTotal, bySeverity, stale };
}

const stats = summarize(collected);

// ── 文本工具 ─────────────────────────────────────────────────

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 台账里的文字是人手写的，常带 Markdown 记号。HTML 里要转成真样式，
// 纯文本里要把记号去掉，Markdown 里保持原样。
function rich(s) {
  let out = esc(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  return out;
}

function plain(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1（$2）")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

function ageText(ledger, item) {
  const d = daysSince(ledger, item);
  if (d === null) return "";
  if (d === 0) return "今天动过";
  return `${d} 天没动`;
}

// ── Markdown ─────────────────────────────────────────────────

function toMarkdown(set, st) {
  const L = [];
  const n = set.length;
  const title = n === 1 ? set[0].ledger.project.name : `${n} 个项目`;
  L.push(`# ${title} · ${MODE.label}`);
  L.push("");

  const winLine =
    MODE.span === null
      ? `全部记录 · 生成于 ${dayTime(generatedAt)}`
      : `${MODE.span} ${MODE.unit}内 · 生成于 ${dayTime(generatedAt)} · 各项目按自身台账时间推算`;
  L.push(`> ${winLine}`);
  L.push("");

  L.push("## 总览");
  L.push("");
  L.push(`- 未收口 **${st.openTotal}** 项（高 ${st.bySeverity.high} / 中 ${st.bySeverity.mid} / 低 ${st.bySeverity.low}）`);
  L.push(`- 本期有更新 ${st.movedTotal} 条记录 · 本期收口 ${st.closedTotal} 项`);
  if (n > 1) L.push(`- 覆盖 ${n} 个项目`);
  L.push("");

  if (n > 1) {
    L.push("| 项目 | 未收口 | 记录 | 收口 |");
    L.push("| --- | --: | --: | --: |");
    for (const c of set) {
      L.push(`| ${c.ledger.project.name} | ${c.open.length} | ${c.movedHistory.length} | ${c.closedHere.length} |`);
    }
    L.push("");
  }

  for (const c of set) {
    const { ledger } = c;
    L.push(`## ${ledger.project.name}`);
    L.push("");
    // 各板时间窗不重合，必须各自交代，否则"日报里有 11-13 的记录"会被当成 bug。
    if (MODE.span !== null) L.push(`> 台账 ${dayOf(ledger.updatedAt)} 更新 · 本期 ${c.win.rangeLabel}`);
    if (MODE.span !== null) L.push("");
    const head = String(ledger.headline || "").trim();
    if (head) {
      L.push(`**${head}**`);
      L.push("");
    }

    if (c.open.length) {
      L.push(`### 还欠着（${c.open.length}）`);
      L.push("");
      for (const i of c.open) {
        const age = ageText(ledger, i);
        L.push(`- \`${i.id}\` ${i.title}${age ? ` · ${age}` : ""}`);
        const next = nextStepOf(c.config, i);
        if (next) L.push(`  - 下一步：${next}`);
      }
      L.push("");
    }

    if (c.closedHere.length) {
      L.push(`### 本期收口（${c.closedHere.length}）`);
      L.push("");
      for (const i of c.closedHere) L.push(`- \`${i.id}\` ${i.title}`);
      L.push("");
    }

    if (c.movedHistory.length) {
      const all = c.movedHistory.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const sorted = all.slice(-MAX_RECORDS);
      L.push(`### 本期记录（${all.length}）`);
      L.push("");
      if (all.length > sorted.length) {
        L.push(`只列最近 ${sorted.length} 条，更早的 ${all.length - sorted.length} 条已省略。`);
        L.push("");
      }
      for (const h of sorted) L.push(`- ${dayOf(h.at)} ${h.text}`);
      L.push("");
    }

    if (!c.open.length && !c.closedHere.length && !c.movedHistory.length) {
      L.push(`这${MODE.unit || "段"}时间里没有记录变动。`);
      L.push("");
    }
  }

  if (st.stale.length) {
    L.push("## 压太久了");
    L.push("");
    for (const s of st.stale.slice(0, 12)) {
      L.push(`- **${s.days} 天** · ${s.board.ledger.project.name} · \`${s.item.id}\` ${s.item.title}`);
    }
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push(`由「项目看板」导出 · ${dayTime(generatedAt)}`);
  return L.join("\n") + "\n";
}

// ── 纯文本 ───────────────────────────────────────────────────

function toText(set, st) {
  const L = [];
  const n = set.length;
  const title = n === 1 ? set[0].ledger.project.name : `${n} 个项目`;
  L.push(`${title} ${MODE.label}`);
  L.push("=".repeat(Math.min(40, (title + MODE.label).length * 2)));
  const winLine =
    MODE.span === null ? `全部记录 · 生成于 ${dayTime(generatedAt)}` : `生成于 ${dayTime(generatedAt)} · 最近 ${MODE.span} ${MODE.unit}`;
  L.push(winLine);
  L.push("");
  L.push(`未收口 ${st.openTotal} 项（高 ${st.bySeverity.high} / 中 ${st.bySeverity.mid} / 低 ${st.bySeverity.low}）`);
  L.push(`本期有更新 ${st.movedTotal} 条记录 · 本期收口 ${st.closedTotal} 项`);
  L.push("");

  for (const c of set) {
    const { ledger } = c;
    L.push("-".repeat(40));
    L.push(ledger.project.name);
    if (MODE.span !== null) L.push(`  台账 ${dayOf(ledger.updatedAt)} 更新 · 本期 ${c.win.rangeLabel}`);
    L.push("-".repeat(40));
    const head = String(ledger.headline || "").trim();
    if (head) {
      L.push(plain(head));
      L.push("");
    }

    if (c.open.length) {
      L.push(`还欠着 ${c.open.length} 项：`);
      for (const i of c.open) {
        const age = ageText(ledger, i);
        L.push(`  · [${i.id}] ${plain(i.title)}${age ? `（${age}）` : ""}`);
        const next = nextStepOf(c.config, i);
        if (next) L.push(`      下一步：${plain(next)}`);
      }
      L.push("");
    }

    if (c.closedHere.length) {
      L.push(`本期收口 ${c.closedHere.length} 项：`);
      for (const i of c.closedHere) L.push(`  · [${i.id}] ${plain(i.title)}`);
      L.push("");
    }

    if (c.movedHistory.length) {
      const all = c.movedHistory.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const sorted = all.slice(-MAX_RECORDS);
      L.push(`本期记录 ${all.length} 条：`);
      if (all.length > sorted.length) {
        L.push(`  （只列最近 ${sorted.length} 条，更早的 ${all.length - sorted.length} 条已省略）`);
      }
      for (const h of sorted) L.push(`  · ${dayOf(h.at)} ${plain(h.text)}`);
      L.push("");
    }

    if (!c.open.length && !c.closedHere.length && !c.movedHistory.length) {
      L.push(`这${MODE.unit || "段"}时间里没有记录变动。`);
      L.push("");
    }
  }

  if (st.stale.length) {
    L.push("压太久了：");
    for (const s of st.stale.slice(0, 12)) {
      L.push(`  · ${s.days} 天 · ${s.board.ledger.project.name} · [${s.item.id}] ${plain(s.item.title)}`);
    }
    L.push("");
  }

  L.push(`由「项目看板」导出 · ${dayTime(generatedAt)}`);
  return L.join("\n") + "\n";
}

// ── HTML ─────────────────────────────────────────────────────
//
// 自包含单文件：不引外部字体、不引外部 CSS、不写脚本。
// 报表经常被存成离线文件或塞进邮件，任何外部依赖都会在别人机器上变成空白。

function toHtml(set, st) {
  const n = set.length;
  const title = n === 1 ? set[0].ledger.project.name : `${n} 个项目`;
  const winLine =
    MODE.span === null
      ? `全部记录 · 生成于 ${dayTime(generatedAt)}`
      : `最近 ${MODE.span} ${MODE.unit} · 生成于 ${dayTime(generatedAt)} · 各项目按自身台账时间推算`;

  const kpis = [
    { v: st.openTotal, k: "未收口", hl: st.bySeverity.high > 0 },
    { v: st.bySeverity.high, k: "其中高优先级" },
    { v: st.movedTotal, k: "本期有更新" },
    { v: st.closedTotal, k: "本期收口" },
  ];

  const summaryTable =
    n > 1
      ? `<table class="sum"><colgroup><col class="s-p"><col class="s-n"><col class="s-n"><col class="s-n"></colgroup>
    <thead><tr><th>项目</th><th class="num">未收口</th><th class="num">记录</th><th class="num">收口</th></tr></thead>
    <tbody>${set
      .map(
        (c) =>
          `<tr><td>${esc(c.ledger.project.name)}</td><td class="num">${c.open.length}</td><td class="num">${c.movedHistory.length}</td><td class="num">${c.closedHere.length}</td></tr>`,
      )
      .join("")}</tbody></table>`
      : "";

  const projects = set
    .map((c) => {
      const { ledger } = c;
      const head = String(ledger.headline || "").trim();
      const rangeNote =
        MODE.span !== null
          ? `<div class="range">台账 ${esc(dayOf(ledger.updatedAt))} 更新 · 本期 ${esc(c.win.rangeLabel)}</div>`
          : "";

      const openRows = c.open
        .map((i) => {
          const d = daysSince(ledger, i);
          const ageChip =
            d === null
              ? ""
              : `<span class="age${d >= 14 ? " bad" : d >= 7 ? " warn" : ""}">${d === 0 ? "今天" : d + " 天"}</span>`;
          const next = nextStepOf(c.config, i);
          return `<tr>
        <td class="id">${esc(i.id)}</td>
        <td><b>${rich(i.title)}</b>${next ? `<div class="next"><span>下一步</span>${rich(next)}</div>` : ""}</td>
        <td class="muted">${esc(i.area || "")}</td>
        <td class="num">${ageChip}</td>
      </tr>`;
        })
        .join("");

      const openBlock = c.open.length
        ? `<section><h3>还欠着 <span class="n">${c.open.length}</span></h3>
      <table class="issues"><colgroup><col class="c-id"><col><col class="c-area"><col class="c-age"></colgroup>
      <thead><tr><th>编号</th><th>事项 / 下一步</th><th>区域</th><th class="num">没动</th></tr></thead><tbody>${openRows}</tbody></table></section>`
        : "";

      const closedBlock = c.closedHere.length
        ? `<section><h3>本期收口 <span class="n">${c.closedHere.length}</span></h3>
      <ul class="plain">${c.closedHere
        .map((i) => `<li><code>${esc(i.id)}</code> ${rich(i.title)}</li>`)
        .join("")}</ul></section>`
        : "";

      const histAll = c.movedHistory
        .slice()
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const histShown = histAll.slice(-MAX_RECORDS);
      const histNote =
        histAll.length > histShown.length
          ? `<p class="more">只列最近 ${histShown.length} 条，更早的 ${histAll.length - histShown.length} 条已省略。</p>`
          : "";
      const histBlock = c.movedHistory.length
        ? `<section><h3>本期记录 <span class="n">${c.movedHistory.length}</span></h3>${histNote}
      <ul class="hist">${histShown
        .map((h) => `<li><span class="d">${esc(dayOf(h.at))}</span> ${rich(h.text)}</li>`)
        .join("")}</ul></section>`
        : "";

      const empty =
        !c.open.length && !c.closedHere.length && !c.movedHistory.length
          ? `<p class="empty">这${MODE.unit || "段"}时间里没有记录变动。</p>`
          : "";

      return `<article class="proj">
    <h2>${esc(ledger.project.name)}${ledger.project.subtitle ? `<small>${esc(ledger.project.subtitle)}</small>` : ""}</h2>
    ${rangeNote}
    ${head ? `<p class="headline">${rich(head)}</p>` : ""}
    ${openBlock}
    ${closedBlock}
    ${histBlock}
    ${empty}
  </article>`;
    })
    .join("\n");

  const staleBlock = st.stale.length
    ? `<section class="stale"><h2>压太久了 <span class="n">${st.stale.length}</span></h2>
    <ul class="plain">${st.stale
      .slice(0, 12)
      .map(
        (s) =>
          `<li><span class="age bad">${s.days} 天</span> ${esc(s.board.ledger.project.name)} · <code>${esc(s.item.id)}</code> ${rich(s.item.title)}</li>`,
      )
      .join("")}</ul></section>`
    : "";

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${esc(MODE.label)} · ${esc(stamp(generatedAt))}</title>
<style>
:root{
  --ink:#1d1b17;--muted:#6f6a60;--rule:#d9d2c4;--bg:#faf7f0;--card:#fffdf8;
  --red:#a8332a;--amber:#8a5a13;--green:#3d6b34;
  --sans:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;
  --mono:ui-monospace,"Cascadia Mono",Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.75;-webkit-font-smoothing:antialiased}
.wrap{max-width:960px;margin:0 auto}
header.top{border-bottom:3px double var(--ink);padding-bottom:14px;margin-bottom:8px}
h1{margin:0;font-size:27px;letter-spacing:.02em}
.sub{margin-top:5px;color:var(--muted);font-size:12.5px;letter-spacing:.03em}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:22px 0}
.kpi div{background:var(--card);border:1px solid var(--rule);padding:12px 14px}
.kpi b{display:block;font-size:26px;line-height:1.25;font-variant-numeric:tabular-nums}
.kpi span{font-size:11.5px;color:var(--muted);letter-spacing:.05em}
.kpi .hl b{color:var(--red)}
table{width:100%;border-collapse:collapse;background:var(--card);font-size:14px;table-layout:fixed}
th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:11.5px;letter-spacing:.06em;color:var(--muted);font-weight:700;background:#f2eee6}
td.id{font-family:var(--mono);font-size:12.5px;white-space:nowrap;color:var(--muted)}
td.muted{color:var(--muted);font-size:13px}
td.num{text-align:right;font-variant-numeric:tabular-nums}
table.issues col.c-id{width:92px}
table.issues col.c-area{width:110px}
table.issues col.c-age{width:62px}
table.sum col.s-n{width:92px}
article.proj{background:var(--card);border:1px solid var(--rule);padding:20px 22px;margin:22px 0}
article.proj h2{margin:0 0 2px;font-size:20px;border-bottom:2px solid var(--ink);padding-bottom:8px}
article.proj h2 small{font-weight:400;font-size:12px;color:var(--muted);margin-left:9px;letter-spacing:.03em}
.headline{margin:11px 0 4px;font-size:14px;font-weight:600;line-height:1.7}
.range{font-size:11.5px;color:var(--muted);letter-spacing:.03em;margin-top:5px;font-variant-numeric:tabular-nums}
section{margin-top:20px}
h3{font-size:13.5px;margin:0 0 8px;letter-spacing:.04em;color:var(--muted);font-weight:700}
h3 .n{background:var(--ink);color:var(--bg);font-size:10.5px;padding:1px 6px;margin-left:5px;vertical-align:1px}
.next{margin-top:4px;font-size:12.5px;line-height:1.65;color:var(--muted);border-left:2px solid var(--rule);padding-left:8px}
.next span{font-family:var(--mono);font-size:10px;letter-spacing:.06em;border:1px solid var(--rule);padding:0 4px;margin-right:6px;color:var(--ink)}
.age{display:inline-block;font-size:10.5px;padding:0 5px;border:1px solid var(--rule);letter-spacing:.02em;white-space:nowrap}
.age.warn{color:var(--amber);border-color:var(--amber)}
.age.bad{color:var(--red);border-color:var(--red)}
ul.plain,ul.hist{margin:0;padding-left:0;list-style:none}
ul.plain li{padding:5px 0;border-bottom:1px dotted var(--rule);font-size:13.5px}
ul.hist li{padding:7px 0;border-bottom:1px dotted var(--rule);font-size:12.8px;color:#39352e;line-height:1.8}
ul.hist .d{font-family:var(--mono);font-size:11px;color:var(--muted);margin-right:7px;white-space:nowrap}
code{font-family:var(--mono);font-size:.9em;background:#f0ece2;padding:1px 4px}
a{color:var(--red)}
.empty{color:var(--muted);font-size:13px;font-style:italic;margin:14px 0 0}
.more{color:var(--muted);font-size:12px;margin:6px 0 0}
section.stale{background:#fdf6ec;border:1px solid #e5d3b3;padding:16px 18px;margin-top:26px}
section.stale h2{font-size:15px;margin:0 0 10px;letter-spacing:.04em}
section.stale h2 .n{background:var(--red);color:#fff;font-size:10.5px;padding:1px 6px;margin-left:5px;vertical-align:1px}
footer{margin-top:30px;padding-top:12px;border-top:1px solid var(--rule);color:var(--muted);font-size:11.5px;letter-spacing:.03em}
@media print{
  body{background:#fff;padding:0;font-size:11pt}
  .kpi div,article.proj,table{background:#fff}
  article.proj{break-inside:avoid;page-break-inside:avoid;border:1px solid #ccc}
  section{break-inside:avoid-page}
  tr{break-inside:avoid}
  footer{page-break-after:avoid}
}
@media (max-width:680px){
  body{padding:18px 12px 40px}
  h1{font-size:21px}
  table{font-size:13px}
  table.issues col.c-area,table.issues th:nth-child(3),table.issues td:nth-child(3){display:none}
}
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>${esc(title)} · ${esc(MODE.label)}</h1>
    <div class="sub">${esc(winLine)}</div>
  </header>

  <div class="kpi">
    ${kpis
      .map((k) => `<div${k.hl ? ' class="hl"' : ""}><b>${k.v}</b><span>${esc(k.k)}</span></div>`)
      .join("\n    ")}
  </div>

  ${summaryTable}
  ${projects}
  ${staleBlock}

  <footer>由「项目看板」导出 · ${esc(dayTime(generatedAt))}</footer>
</div>
</body>
</html>
`;
}

// ── 落盘 ─────────────────────────────────────────────────────
//
// 两种产出方式：
//   默认     所有勾选的看板合并成一份，开头有跨项目总表
//   --split  每块板各出一份，互不干扰（适合分头转给不同的人）

mkdirSync(OUT_DIR, { recursive: true });

const writers = {
  md: (body) => [".md", body],
  txt: (body) => [".txt", body],
  html: (body) => [".html", body],
};
const bodies = { md: toMarkdown, txt: toText, html: toHtml };

const groups = SPLIT
  ? collected.map((c) => ({ tag: c.entry.id, set: [c] }))
  : [
      {
        tag: collected.length === 1 ? collected[0].entry.id : `${collected.length}-projects`,
        set: collected,
      },
    ];

const written = [];
for (const g of groups) {
  const gStats = summarize(g.set);
  const baseName = `${MODE.key}-${stamp(generatedAt)}-${g.tag}`;
  for (const f of FORMATS) {
    const [ext, body] = writers[f](bodies[f](g.set, gStats));
    const file = join(OUT_DIR, baseName + ext);
    writeFileSync(file, body, "utf8");
    written.push({ format: f, file, bytes: Buffer.byteLength(body, "utf8"), group: g.tag });
  }
}

// ── 回执 ─────────────────────────────────────────────────────
//
// 机器可读的一行放最前面：插件直接抓这行，不用去猜自然语言。
console.log(
  "REPORT_OK " +
    JSON.stringify({
      mode: MODE.key,
      split: SPLIT,
      boards: collected.map((c) => c.entry.id),
      open: stats.openTotal,
      moved: stats.movedTotal,
      closed: stats.closedTotal,
      stale: stats.stale.length,
      files: written.map((w) => w.file),
    }),
);

const label = { md: "Markdown", txt: "纯文本", html: "网页" };
console.log("");
console.log(
  `${MODE.label}：${collected.length} 个看板${SPLIT ? ` · 每项目各一份（共 ${groups.length} 份）` : ""}` +
    ` · 未收口 ${stats.openTotal} · 本期记录 ${stats.movedTotal} · 本期收口 ${stats.closedTotal}`,
);
for (const w of written) {
  console.log(`  ${label[w.format].padEnd(9)} ${(w.bytes / 1024).toFixed(1).padStart(5)} KB  ${w.file}`);
}
if (broken.length) {
  console.log("");
  for (const b of broken) console.log(`  跳过 ${b.entry.id}：${b.error}`);
}
