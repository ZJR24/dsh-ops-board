#!/usr/bin/env node
// scripts/gen-ledger.mjs — 把一批候选条目规范化成合法台账，追加进 ledger.json。
//
// 这个工具不猜语义。它只做「规范化」：
//   语义（标题、四段式、证据线索）由调用方提供 —— 通常是 Harness agent
//   读完一段对话 / 一次排查后产出的候选条目；工具负责把它们变成
//   render/verify 认得出来的合法格式：分 lane、分配 status/severity、编 id。
//
// 用法：
//   node scripts/gen-ledger.mjs --items-file <json> [--board <看板目录>] [--dry-run]
//
//   --items-file 读一个 JSON，格式是数组：
//     [
//       { "title": "弱网下列表白屏", "lane": "bug", "severity": "high", "sections": [...] , "evidence": [...] },
//       { "title": "支持断点续传", "status": "doing" }
//     ]
//   没给的字段按规则补：lane 按关键字猜，status 默认车道第一阶段，severity 默认 medium。
//   有 lane.prefix 的车道自动编 `<prefix>-NNN`，号的尾号从已有效基础上续。
//
//   --dry-run 只打印计划新增的条目，不改文件。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
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

// ── 定位看板（同 serve/render：--board > 环境变量 > 脚本所在模板同级）────────────────

const board =
  (argValue("board") || "").trim() ||
  process.env.OPS_BOARD_DIR ||
  (existsSync(join(process.cwd(), "ledger.json")) && existsSync(join(process.cwd(), "board.config.json"))
    ? process.cwd()
    : "");
const configPath = join(board, "board.config.json");
const ledgerPath = join(board, "ledger.json");
if (!board) {
  console.error("找不到看板目录 —— 请在看板目录下运行，或 --board 指定看板目录（gen-ledger 只写你明确指向的 ledger，绝不改模板）。");
  process.exit(1);
}
for (const p of [configPath, ledgerPath]) {
  if (!existsSync(p)) {
    console.error(`找不到 ${p} —— 请 --board 指定一个含 ledger.json 与 board.config.json 的看板目录`);
    process.exit(1);
  }
}

// ── 读输入 ──────────────────────────────────────────────────────

const inFile = (argValue("items-file") || "").trim();
if (!inFile) {
  console.error('用法：node scripts/gen-ledger.mjs --items-file <候选条目.json> [--board <看板>] [--dry-run]');
  process.exit(1);
}
if (!existsSync(inFile)) {
  console.error(`找不到候选条目文件：${inFile}`);
  process.exit(1);
}
let candidates;
try {
  const parsed = JSON.parse(readFileSync(inFile, "utf8"));
  candidates = Array.isArray(parsed.items) ? parsed.items : parsed;
} catch (e) {
  console.error(`候选条目文件不是合法 JSON：${e.message}`);
  process.exit(1);
}
if (!Array.isArray(candidates) || !candidates.length) {
  console.error("候选条目数组为空，没有要登记的条目。");
  process.exit(1);
}

const config = JSON.parse(readFileSync(configPath, "utf8"));
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const lanes = config.lanes || [];
const laneByKey = (k) => lanes.find((l) => l.key === k);

// ── 关键字猜 lane（不猜时给 null，下面报错）────────────────────

const GUESS = [
  { lane: "bug", re: /(bug|报错|错误|崩溃|挂|闪退|白屏|丢|异常|不生效|失败|超时|404|429|500|慢|卡|打不开|乱)/i },
  { lane: "feature", re: /(新增|支持|上线|实现|接入|增加|能力|功能|需求|升级|兼容)/i },
  { lane: "risk", re: /(风险|隐患|可能|即将|额度|用完|接近|告警|预警|到期|耦合)/i },
];

function guessLane(title) {
  for (const g of GUESS) if (g.re.test(title)) return g.lane;
  return null;
}

// ── 续号：每车道取已有 id 的数字部分最大值 ───────────────────────

function nextId(lane) {
  const max = (ledger.items || [])
    .filter((it) => lane.prefix && String(it.id || "").startsWith(lane.prefix + "-"))
    .map((it) => {
      const n = /^([A-Z]+)-(\d+)$/.exec(String(it.id));
      return n ? Number(n[2]) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  return `${lane.prefix}-${String(max + 1).padStart(3, "0")}`;
}

// ── 规范化 sections / evidence ───────────────────────────────────

// 这两个字段都是 [{键, text}] 的形状，键分别是 label / kind。
// 容忍三种写法：正常的对象、纯字符串（补个默认键）、缺 text 的对象（跳过并报错）。
function normPairs(input, keyName, at, fieldName, fallbackKey) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    errors.push(`${at} 的 ${fieldName} 不是数组，已忽略`);
    return [];
  }
  const out = [];
  for (const [j, el] of input.entries()) {
    if (typeof el === "string") {
      const text = el.trim();
      if (text) out.push({ [keyName]: fallbackKey, text });
      continue;
    }
    if (!el || typeof el !== "object") {
      errors.push(`${at} 的 ${fieldName}[${j}] 既不是对象也不是字符串，已忽略`);
      continue;
    }
    const text = String(el.text === undefined || el.text === null ? "" : el.text).trim();
    if (!text) {
      errors.push(`${at} 的 ${fieldName}[${j}] 没有 text，已忽略`);
      continue;
    }
    const k = String(el[keyName] === undefined || el[keyName] === null ? "" : el[keyName]).trim();
    out.push({ [keyName]: k || fallbackKey, text });
  }
  return out;
}

// ── 逐条规范化 ──────────────────────────────────────────────────

const now = new Date();
const iso = now.toISOString().replace("T", "T").replace("Z", "+08:00");
const out = [];
const errors = [];

// 已占用的 id 跨批次累计：既含 ledger 原有的，也含本轮前面已分配的。
const taken = new Set((ledger.items || []).map((x) => x.id).filter(Boolean));

for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i];
  const at = `#${i + 1}`;
  if (!c || typeof c !== "object" || !c.title) {
    errors.push(`${at} 缺 title，跳过`);
    continue;
  }
  const title = String(c.title).trim();

  // lane：显式 > 关键字猜 > 报错
  let lane = c.lane ? laneByKey(String(c.lane)) : null;
  if (!lane && c.lane) {
    errors.push(`${at}「${title}」的 lane 不在配置里：${c.lane}`);
    continue;
  }
  if (!lane) {
    const guessed = guessLane(title);
    lane = guessed ? laneByKey(guessed) : null;
    if (!lane) {
      errors.push(`${at}「${title}」没给 lane 且猜不出来 —— 请显式 lane=bug|feature|risk`);
      continue;
    }
  }

  // status：显式 > 车道第一阶段（open 优先）
  let status = String(c.status || "").trim();
  const validStatuses = lane.stages.flatMap((s) => s.statuses);
  if (!status) {
    const open = (lane.stages.find((s) => s.open) || lane.stages[0]);
    status = open ? open.statuses[0] : validStatuses[0];
  }
  if (!validStatuses.includes(status)) {
    errors.push(`${at}「${title}」的 status=${c.status} 不在车道 ${lane.key}：可用 ${validStatuses.join("/")}`);
    continue;
  }

  // severity：显式校验 > 默认 medium（仅车道声明了 severity 才写）
  let severity = c.severity !== undefined ? String(c.severity) : "";
  if (lane.severity) {
    const levelKeys = lane.severity.levels.map((l) => l.key);
    if (severity && !levelKeys.includes(severity)) {
      errors.push(`${at}「${title}」的 severity=${severity} 不在等级表：可用 ${levelKeys.join("/")}`);
      continue;
    }
    if (!severity) severity = "medium";
  } else {
    severity = ""; // feature 无 severity
  }

  // id：显式 > 续号。占用集跨批次，分配完立即登记，避免本批内撞号。
  let id = String(c.id || "").trim();
  if (id) {
    // 显式 id 是最容易出事的一条路：前缀不对 render 只给 warning（静默放过），
    // 撞号 render 直接 error —— 但那时 ledger.json 已经被写脏了，得手工回滚。
    // 所以这两件都在写之前拦掉。
    if (lane.prefix && !id.startsWith(lane.prefix + "-")) {
      errors.push(`${at}「${title}」的 id=${id} 没用车道前缀 ${lane.prefix}-，跳过`);
      continue;
    }
    if (taken.has(id)) {
      errors.push(`${at}「${title}」的 id=${id} 已被占用（原有或本批前面的条目），跳过`);
      continue;
    }
  } else {
    let base = nextId(lane);
    while (taken.has(base)) {
      const m = /^([A-Z]+)-(\d+)$/.exec(base);
      base = m ? `${m[1]}-${String(Number(m[2]) + 1).padStart(3, "0")}` : `${base}-2`;
    }
    id = base;
  }
  taken.add(id);

  // sections / evidence：元素必须是对象，且带 label / kind + text。
  // 只判「是不是数组」不够 —— 传进来一堆字符串时，卡片会渲染成空壳，
  // 而 render 只当「没有 sections」给个 warning，问题就溜过去了。
  const sections = normPairs(c.sections, "label", at, "sections", "具体表现");
  const evidence = normPairs(c.evidence, "kind", at, "evidence", "记录");
  const area = c.area !== undefined ? String(c.area) : "";

  out.push({
    id,
    lane: lane.key,
    title,
    status,
    ...(severity ? { severity } : {}),
    ...(area ? { area } : {}),
    owner: typeof c.owner === "string" ? c.owner : "",
    sections,
    evidence,
    createdAt: iso,
    updatedAt: iso,
  });
}

// ── 汇总 ────────────────────────────────────────────────────────

console.log(`候选 ${candidates.length} 条 → 可登记 ${out.length} 条，问题 ${errors.length} 条`);
for (const e of errors) console.log(`  ✗ ${e}`);
if (out.length === 0) {
  console.error("\n没有可登记的条目，未改动 ledger.json。");
  process.exit(1);
}

console.log("将新增：");
for (const o of out) {
  const sev = o.severity ? `${o.severity}/` : "";
  console.log(`  + ${o.id} [${o.lane} ${sev}${o.status}] ${o.title}`);
}

if (has("dry-run")) {
  console.log("\n[dry-run] 未写文件。");
  process.exit(0);
}

ledger.items = [...(ledger.items || []), ...out];
ledger.updatedAt = iso;

// 写之前把整份 ledger 过一遍 —— 一旦落盘，脏数据就得手工回滚。
// 这里只查「写完会让 render/verify 直接失败」的那几件，别把 render 的活重做一遍。
const preflight = [];
const metricStatuses = Array.isArray(config.metricStatuses) && config.metricStatuses.length
  ? config.metricStatuses
  : ["ok", "warn", "danger", "muted"];
for (const [i, m] of (ledger.metrics || []).entries()) {
  if (!m || m.status === undefined || m.status === "") continue;
  if (!metricStatuses.includes(m.status)) {
    preflight.push(`metrics[${i}]「${m.label || "(无标签)"}」的 status=${m.status} 不在 metricStatuses（可用 ${metricStatuses.join(" / ")}）`);
  }
}
// 编号唯一 + 前缀正确：这两条是 render 的 error 级检查。
const seenIds = new Map();
for (const [i, it] of (ledger.items || []).entries()) {
  const id = it && it.id ? String(it.id) : "";
  if (!id) {
    preflight.push(`items[${i}] 缺 id`);
    continue;
  }
  if (seenIds.has(id)) preflight.push(`id 重复：${id}（items[${seenIds.get(id)}] 与 items[${i}]）`);
  else seenIds.set(id, i);
  const lane = laneByKey(it.lane);
  if (lane && lane.prefix && !id.startsWith(lane.prefix + "-")) {
    preflight.push(`items[${i}] 的 id=${id} 没用车道前缀 ${lane.prefix}-`);
  }
}
if (preflight.length) {
  console.error(`\n预检没通过，未改动 ledger.json（${preflight.length} 个问题）：`);
  for (const p of preflight) console.error(`  ✗ ${p}`);
  process.exit(1);
}

try {
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  console.log(`\n已追加 ${out.length} 条 → ${ledgerPath}`);
  console.log("接下来：node scripts/render.mjs && node scripts/verify-board.mjs");
} catch (e) {
  console.error(`写 ledger 失败：${e.message}`);
  process.exit(1);
}