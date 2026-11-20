// 车道页不再渲染「已收口」分节 + 状态表格子跳到收口页（2026-11-20 用户定）。
//
// 用户原话：「因为已上线，或者是其他页面上的这样的标题都移动到已解决或者是暂停这个页面里去了。
// 我希望把或者说这个标题上已经不显示不显示数据的这几个标题给去掉」
// 追问确认：只去掉「卡片已搬到收口页」的那几个（已上线/暂停/已解决/已解除/已知并接受）；
// 0 项的（开发中/待验证/缓解中）保留；状态表里对应格子改成**跳转到收口页的相应行**。
//
// 要验：
//   ① 已收口阶段在车道页上**没有分节**了；
//   ② 未收口阶段（含 0 项）**还在** —— 尤其「计划中」哪怕 0 项也要在（旁边挂着 AI 入口）；
//   ③ 状态表里已收口那几格指向 `#stage-<lane>-closed`，且那个落点**真的存在**；
//   ④ 点那一格真的会跳到收口页并定位到对应分组（不是死链、不是原地不动）；
//   ⑤ 侧栏阶段表同理（同一套判据）。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const HERE = dirname(fileURLToPath(import.meta.url));
const argBoard = (() => {
  const i = process.argv.indexOf("--board");
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
})();
const PAGE = join(argBoard, "dist", "index.html");
if (!existsSync(PAGE)) { console.error("没有 dist/index.html"); process.exit(1); }
const HTML = "file:///" + PAGE.replace(/\\/g, "/");

const profile = join(tmpdir(), "edge-closed-sec-" + Date.now());
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

// 从看板配置读「哪些阶段是已收口」，不写死阶段名 —— 换一块板也成立
const cfg = JSON.parse(readFileSync(join(argBoard, "board.config.json"), "utf8"));
const closedStages = [];
for (const lane of cfg.lanes) {
  for (const st of lane.stages) {
    if (st.open === false) closedStages.push({ lane: lane.key, laneLabel: lane.label, key: st.key, label: st.label });
  }
}
const openStages = [];
for (const lane of cfg.lanes) {
  for (const st of lane.stages) {
    if (st.open !== false) openStages.push({ lane: lane.key, key: st.key, label: st.label });
  }
}

await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2600);

console.log("[1] 已收口阶段在车道页上没有分节了");
const closedInfo = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ${JSON.stringify(closedStages)}.forEach(function(s){
    var el = document.getElementById('stage-' + s.lane + '-' + s.key);
    out.push({ lane: s.lane, key: s.key, label: s.label, exists: !!el });
  });
  return out;
})())`));
const stillThere = closedInfo.filter((s) => s.exists);
ok(stillThere.length === 0, "所有已收口阶段的分节都去掉了",
  stillThere.length ? "残留：" + stillThere.map((s) => s.lane + "/" + s.label).join(",") : closedInfo.length + " 个全部移除");

console.log("\n[2] 未收口阶段（含 0 项）仍然在");
const openInfo = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ${JSON.stringify(openStages)}.forEach(function(s){
    var el = document.getElementById('stage-' + s.lane + '-' + s.key);
    out.push({ lane: s.lane, key: s.key, label: s.label, exists: !!el });
  });
  return out;
})())`));
const missing = openInfo.filter((s) => !s.exists);
ok(missing.length === 0, "所有未收口阶段的分节都保留着",
  missing.length ? "缺：" + missing.map((s) => s.lane + "/" + s.label).join(",") : openInfo.length + " 个都在");
// 「计划中」即使 0 项也必须在（旁边挂着「和 AI 谈谈要加什么」）。
// ⚠️ 必须**在 #stage-feature-planned 里**找按钮：2026-11-20 起需求页有两个
// [data-ask-feature]（「计划列表」总览表也有一个），querySelector 取到的会是
// 计划列表那个，closest('.detail-group') 就变成 null —— 这条会假红。
const plannedOk = await ev(`(function(){
  var grp0 = document.getElementById('stage-feature-planned');
  if (!grp0) return { ok: false, reason: '计划中分节不在' };
  var b = grp0.querySelector('[data-ask-feature]');
  if (!b) return { ok: false, reason: '计划中的 AI 入口不见了' };
  var grp = b.closest('.detail-group');
  return { ok: !!grp, id: grp ? grp.id : '' };
})()`);
ok(plannedOk.ok === true, "「计划中」分节和它的 AI 入口还在（空阶段是常态）", plannedOk.id || plannedOk.reason);

console.log("\n[3] 状态表里已收口那几格指向收口页（或这块板没有收口条目时保持静态），落点真实存在");
const cellInfo = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ${JSON.stringify(closedStages)}.forEach(function(s){
    var view = document.querySelector('[data-view="lane-' + s.lane + '"]');
    if (!view) return;
    var cells = Array.prototype.slice.call(view.querySelectorAll('.stage-board-cell'));
    var cell = cells.filter(function(c){ return (c.querySelector('span') || {}).textContent === s.label; })[0];
    if (!cell) { out.push({ lane: s.lane, label: s.label, found: false }); return; }
    var tag = cell.tagName;
    // 不是 <a> = 这块板在这个车道没有收口条目，收口页不会渲染那一组，
    // 所以格子是静态的（和 closedBoard 对 0 项格子的处理一致）。
    if (tag !== 'A') {
      out.push({ lane: s.lane, label: s.label, found: true, kind: 'static', hasStaticCls: cell.classList.contains('is-static') });
      return;
    }
    var href = cell.getAttribute('href');
    var target = href ? document.getElementById(href.slice(1)) : null;
    out.push({
      lane: s.lane, label: s.label, found: true, kind: 'link', href: href,
      isClosedGroup: /-closed$/.test(href || ''),
      lands: !!target,
      targetInClosedView: !!(target && target.closest('[data-view="closed"]'))
    });
  });
  return out;
})())`));
const badCells = cellInfo.filter((c) => !c.found ||
  (c.kind === 'link' && (!c.isClosedGroup || !c.lands || !c.targetInClosedView)) ||
  (c.kind === 'static' && !c.hasStaticCls));
const linkedCells = cellInfo.filter((c) => c.kind === "link");
const staticCells = cellInfo.filter((c) => c.kind === "static");
ok(badCells.length === 0, "每格要么指向收口页的分组、要么是静态（没有死链）",
  badCells.length ? JSON.stringify(badCells)
    : linkedCells.map((c) => c.label + "→" + c.href).join(" · ") +
      (staticCells.length ? " ｜ 静态：" + staticCells.map((c) => c.label).join(",") : ""));

console.log("\n[4] 点那一格真的跳到收口页并落到对应分组");
// 只在**这块板真有收口条目**时才跑（否则格子是静态的，本来就点不动）。
const hasAnyClosed = closedInfo.length > 0 && (await ev(`(function(){
  return Array.prototype.some.call(document.querySelectorAll('.view[data-view^="lane-"] .stage-board-cell'), function(c){
    return c.tagName === 'A' && /-closed$/.test(c.getAttribute('href') || '');
  });
})()`));
if (!hasAnyClosed) {
  ok(true, "[跳过] 这块板没有收口条目，格子按设计是静态的（不可点）");
} else {
await send("Page.navigate", { url: HTML + "#view-lane-feature" });
await wait(1800);
const jump = JSON.parse(await ev(`JSON.stringify((function(){
  var view = document.querySelector('[data-view="lane-feature"]');
  var cells = Array.prototype.slice.call(view.querySelectorAll('.stage-board-cell'));
  var cell = cells.filter(function(c){ return (c.querySelector('span') || {}).textContent === '已上线'; })[0];
  if (!cell) return { err: 'no-cell' };
  var href = cell.getAttribute('href');
  cell.click();
  return { href: href };
})())`));
if (jump.err) {
  ok(false, "找得到「已上线」那一格", jump.err);
} else {
  await wait(1200);
  const landed = JSON.parse(await ev(`JSON.stringify((function(){
    var active = document.querySelector('.view.is-active');
    var hash = location.hash;
    var targetId = ${JSON.stringify(jump.href || "")}.slice(1);
    var el = document.getElementById(targetId);
    var r = el ? el.getBoundingClientRect() : null;
    return {
      active: active ? active.getAttribute('data-view') : null,
      hash: hash,
      targetExists: !!el,
      inClosedView: !!(el && el.closest('[data-view="closed"]')),
      visible: r ? (r.top > -200 && r.top < 900) : false
    };
  })())`));
  ok(landed.active === "closed", "点「已上线」跳到了收口页", "激活视图=" + landed.active);
  ok(landed.inClosedView === true && landed.targetExists === true, "落点是收口页里那个分组", jump.href);
  ok(landed.visible === true, "分组真的滚进视野了（不是停在页顶）", "hash=" + landed.hash);
}
}

console.log("\n[5] 侧栏阶段表用同一套判据");
const railInfo = JSON.parse(await ev(`JSON.stringify((function(){
  var out = [];
  ${JSON.stringify(closedStages)}.forEach(function(s){
    var panel = document.querySelector('.rail .panel[data-panel="lane-' + s.lane + '"]');
    if (!panel) return;
    // 侧栏里可能是 <a>，也可能是静态 <span>（这块板没那个收口分组）
    var all = Array.prototype.slice.call(panel.querySelectorAll('.stage-table a, .stage-table .is-static'));
    var el = all.filter(function(x){ return (x.querySelector('.stage-label') || {}).textContent === s.label; })[0];
    if (!el) { out.push({ label: s.label, found: false }); return; }
    if (el.tagName !== 'A') { out.push({ label: s.label, found: true, kind: 'static' }); return; }
    var href = el.getAttribute('href');
    // 注意这里要显式写 found: true —— 第一版漏了，于是 undefined 被当成"没找到"，
    // 明明五项都对却红了。判据字段必须每一条分支都写全。
    out.push({ label: s.label, found: true, kind: 'link', href: href,
               isClosedGroup: /-closed$/.test(href), lands: !!document.getElementById(href.slice(1)) });
  });
  return out;
})())`));
const badRail = railInfo.filter((r) => !r.found ||
  (r.kind === 'link' && (!r.isClosedGroup || !r.lands)));
ok(badRail.length === 0, "侧栏里已收口的阶段要么指向收口页、要么静态（没有死链）",
  badRail.length ? JSON.stringify(badRail)
    : railInfo.map((r) => r.label + (r.kind === 'link' ? "→" + r.href : "(静态)")).join(" · "));

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
