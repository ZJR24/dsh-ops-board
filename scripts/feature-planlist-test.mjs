// 「计划列表」（2026-11-20 用户定）。
//
// 用户原话：「新增功能也要有像问题修复（待处理问题）那样的总览表；这个总览表叫做计划列表」
//
// 三个车道现在都有这块总览表，位置一致（状态表之后、阶段分节之前）：
//   问题 → 待处理问题 / 风险 → 待处理风险 / 需求 → **计划列表**
//
// 要验：
//   ① 需求页有「计划列表」，位置在状态表之后、第一个阶段分节之前；
//   ② 它是**一张表**（.table-wrap > table），行数 = 需求车道未上线条目数；
//   ③ 列和「待处理问题」那张表一致（同一个 itemTable 渲染）；
//   ④ 需求页的两个「和 AI 谈谈要加什么」按钮**都能点**（原来只绑了第一个）；
//   ⑤ 三个车道的总览表互不串位（问题页没有「计划列表」这种）。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const PAGE = join(argBoard, "dist", "index.html");
if (!existsSync(PAGE)) { console.error("没有 dist/index.html"); process.exit(1); }
const HTML = "file:///" + PAGE.replace(/\\/g, "/");

// 从台账算「需求车道还有多少条没上线」——不写死数字
const cfg = JSON.parse(readFileSync(join(argBoard, "board.config.json"), "utf8"));
const led = JSON.parse(readFileSync(join(argBoard, "ledger.json"), "utf8"));
const featLane = cfg.lanes.find((l) => l.key === "feature");
const openStatuses = new Set(featLane.stages.filter((s) => s.open).flatMap((s) => s.statuses));
const expectRows = (led.items || []).filter((i) => i.lane === "feature" && openStatuses.has(i.status)).length;

const profile = join(tmpdir(), "edge-planlist-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--allow-file-access-from-files", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1440,1400", "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pf = join(profile, "DevToolsActivePort");
let cport = null;
for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { cport = Number(readFileSync(pf, "utf8").split("\n")[0]); if (cport) break; } }
if (!cport) { console.error("Edge 没起来"); proc.kill(); process.exit(1); }
const list = await (await fetch(`http://127.0.0.1:${cport}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method: m, params: p })); });
await new Promise((r) => (ws.onopen = r));
const crashes = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") crashes.push(JSON.stringify(m.params));
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
};
await send("Page.enable"); await send("Runtime.enable");
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

await send("Page.navigate", { url: HTML + "#view-lane-feature" });
await wait(2400);

console.log("[1] 需求页有「计划列表」，位置和其它车道一致");
const info = JSON.parse(await ev(`JSON.stringify((function(){
  var view = document.querySelector('[data-view="lane-feature"]');
  var main = view.querySelector('.details-main');
  var board = main.querySelector('.stage-board');
  // 找标题是「计划列表」的那一块
  var heads = Array.prototype.slice.call(main.querySelectorAll('.section-head'));
  var hit = heads.filter(function(h){
    var t = h.querySelector('h2');
    return t && t.textContent.trim() === '计划列表';
  })[0];
  if (!hit) return { err: 'no-plan-list' };
  var section = hit.closest('section');
  var table = section.querySelector('.table-wrap table');
  var rows = table ? table.querySelectorAll('tbody tr').length : -1;
  var cols = table ? Array.prototype.slice.call(table.querySelectorAll('thead th')).map(function(th){ return th.textContent.trim(); }) : [];
  // 位置：状态表之后、第一个阶段分节之前
  var groups = Array.prototype.slice.call(main.querySelectorAll('.detail-group'));
  var firstGroup = groups[0];
  var afterBoard = board ? !!(board.compareDocumentPosition(section) & 4) : null;
  var beforeFirstGroup = firstGroup ? !!(section.compareDocumentPosition(firstGroup) & 4) : null;
  return {
    found: true, rows: rows, cols: cols,
    hasTable: !!table,
    afterBoard: afterBoard, beforeFirstGroup: beforeFirstGroup,
    meta: (hit.querySelector('span') || {}).textContent || '',
    askBtns: main.querySelectorAll('[data-ask-feature]').length
  };
})())`));
if (info.err) {
  ok(false, "需求页有「计划列表」", info.err);
} else {
  ok(info.found === true, "需求页有「计划列表」这一块");
  ok(info.hasTable === true, "它是一张表（.table-wrap > table），不是卡片堆");
  ok(info.rows === expectRows, "行数 = 需求车道未上线条目数", info.rows + " 行（台账算出 " + expectRows + " 条）");
  ok(info.afterBoard === true, "排在状态表之后");
  ok(info.beforeFirstGroup === true, "排在第一个阶段分节之前（总览表在干活区之上）");
  ok(info.cols.length >= 4, "列齐全（编号 / 标题 / 状态 / 区域 …）", info.cols.join(" | "));
  ok(/待推进/.test(info.meta), "标题右侧计数用「待推进」量词", info.meta.trim().slice(0, 40));
}

console.log("\n[2] 两个「和 AI 谈谈要加什么」按钮都能点");
const btns = JSON.parse(await ev(`JSON.stringify((function(){
  var view = document.querySelector('[data-view="lane-feature"]');
  var all = Array.prototype.slice.call(view.querySelectorAll('[data-ask-feature]'));
  return all.map(function(b, i){
    return { i: i, text: b.textContent.trim(), inPlanList: !!b.closest('[data-fold-head="pending-feature"]'),
             inPlanned: !!b.closest('#stage-feature-planned'), hasHandler: true };
  });
})())`));
ok(btns.length === 2, "需求页有两个入口按钮（计划列表 / 计划中）", btns.length + " 个");
ok(btns.every((b) => b.text === "和 AI 谈谈要加什么"), "两个按钮文案一致",
  btns.map((b) => b.text).join(" / "));
ok(btns.some((b) => b.inPlanList) && btns.some((b) => b.inPlanned),
  "一个在「计划列表」标题里、一个在「计划中」阶段标题里",
  JSON.stringify(btns.map((b) => ({ i: b.i, plan: b.inPlanList, planned: b.inPlanned }))));

// 真点第二个（计划中那个）—— 原来 querySelector 只绑第一个，这个会是死按钮
const clicked = await ev(`(function(){
  var view = document.querySelector('[data-view="lane-feature"]');
  var all = Array.prototype.slice.call(view.querySelectorAll('[data-ask-feature]'));
  if (all.length < 2) return { err: 'less-than-2' };
  // 数一下点击前后 AI 面板有没有变化
  var panel = document.getElementById('ai-panel');
  var before = panel ? panel.getAttribute('data-open') || '' : '';
  var ctxBefore = (document.getElementById('ai-ctx') || {}).textContent || '';
  all[1].click();
  var after = panel ? panel.getAttribute('data-open') || '' : '';
  var ctxAfter = (document.getElementById('ai-ctx') || {}).textContent || '';
  return { before: before, after: after, ctxBefore: ctxBefore, ctxAfter: ctxAfter,
           panelExists: !!panel,
           changed: before !== after || ctxBefore !== ctxAfter };
})()`);
if (clicked.err) ok(false, "第二个按钮存在", clicked.err);
else {
  ok(clicked.panelExists === true, "AI 面板在");
  ok(clicked.changed === true, "点第二个按钮确实唤起了面板（不是死按钮）",
    "open " + clicked.before + "→" + clicked.after + " · ctx '" + clicked.ctxBefore + "'→'" + clicked.ctxAfter + "'");
  ok(/新增功能|需求/.test(clicked.ctxAfter), "面板作用域落在需求车道", clicked.ctxAfter);
}

console.log("\n[3] 三个车道的总览表互不串位");
const allLanes = JSON.parse(await ev(`JSON.stringify((function(){
  var out = {};
  ['bug','feature','risk'].forEach(function(k){
    var view = document.querySelector('[data-view="lane-' + k + '"]');
    if (!view) { out[k] = null; return; }
    var heads = Array.prototype.slice.call(view.querySelectorAll('.section-head h2')).map(function(h){ return h.textContent.trim(); });
    var pendingH2 = (view.querySelector('.priority-block .section-head h2') || {}).textContent || '';
    out[k] = { pendingTitle: pendingH2.trim(), hasPlanList: heads.indexOf('计划列表') > -1,
               hasPendingRisk: heads.indexOf('待处理风险') > -1, hasPendingBug: heads.indexOf('待处理问题') > -1 };
  });
  return out;
})())`));
ok(allLanes.bug && allLanes.bug.pendingTitle === "待处理问题", "问题页第一块是「待处理问题」", JSON.stringify(allLanes.bug));
ok(allLanes.feature && allLanes.feature.pendingTitle === "计划列表", "需求页第一块是「计划列表」", JSON.stringify(allLanes.feature));
ok(allLanes.risk && allLanes.risk.pendingTitle === "待处理风险", "风险页第一块是「待处理风险」", JSON.stringify(allLanes.risk));
ok(!allLanes.bug.hasPlanList && !allLanes.risk.hasPlanList, "「计划列表」只在需求页出现");

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
