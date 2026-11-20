// 收口页：表格格子与页面分组必须一一对应（2026-11-20 用户定）。
//
// 用户原话：「已修复/已关闭/暂停页面，表格里的类别和页面上的类别没有完全对应的标题；
// 我希望已暂停增加一个类别；已知并接受合并到暂停里；已解除去掉」
//
// 三条要求 + 一条总原则：
//   ① 有「已暂停」这一组（不是原来的「暂停」）；
//   ② 风险的「已知并接受」并进暂停组；
//   ③ 「已解除」不再单列（当成一种暂停，并进同一组）；
//   ④ **表格格子 = 页面分组**：数量一样、名字一样、顺序一样、每个格子都能落到自己的组。
//
// 用同一份数据（parts.mjs 的 closedGroupsOf）生成两边，所以这里验的是
// 「那份定义有没有被两处一致地用上」，而不是各自算一遍碰巧对上。
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

const profile = join(tmpdir(), "edge-closed-grp-" + Date.now());
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

await send("Page.navigate", { url: HTML + "#view-closed" });
await wait(2200);

const info = JSON.parse(await ev(`JSON.stringify((function(){
  var view = document.querySelector('[data-view="closed"]');
  var main = view.querySelector('.details-main');
  var board = main.querySelector('.stage-board');
  // 表格格子（含静态）
  var cells = Array.prototype.slice.call(board.querySelectorAll('.stage-board-cell')).map(function(c){
    return { label: (c.querySelector('span') || {}).textContent || '', n: Number((c.querySelector('b')||{}).textContent || 0),
             href: c.getAttribute('href') || '', isStatic: c.tagName !== 'A' };
  });
  // 页面分组（只算收口页里的 detail-group）
  var groups = Array.prototype.slice.call(main.querySelectorAll('.detail-group')).map(function(g){
    var h2 = g.querySelector('.section-head h2');
    var meta = g.querySelector('.section-head > span');
    return { id: g.id, label: h2 ? h2.textContent.trim() : '', meta: meta ? meta.textContent.trim() : '',
             cards: g.querySelectorAll('details.card').length };
  });
  return { cells: cells, groups: groups, total: Number((board.querySelector('.stage-board-num')||{}).textContent || 0) };
})())`));

console.log("表格格子：" + info.cells.map((c) => c.label + "=" + c.n).join(" · "));
console.log("页面分组：" + info.groups.map((g) => g.label + "(" + g.cards + "张)").join(" · "));

// 一条收口都没有的板（practise）走另一条断言
if (info.cells.length === 1 && info.cells[0].isStatic && info.groups.length === 0) {
  ok(true, "这块板没有收口条目，表格给静态 0、页面给空提示（按设计）");
} else {
  ok(info.groups.length > 0, "收口页有分组", info.groups.length + " 组");
  ok(info.cells.length === info.groups.length,
    "表格格子数 = 页面分组数（一一对应）", info.cells.length + " 格 vs " + info.groups.length + " 组");
  const cellLabels = info.cells.map((c) => c.label);
  const groupLabels = info.groups.map((g) => g.label);
  ok(JSON.stringify(cellLabels) === JSON.stringify(groupLabels),
    "格子名字与分组标题**逐个相同、顺序一致**",
    "格子[" + cellLabels.join(",") + "] vs 分组[" + groupLabels.join(",") + "]");

  // 每个格子都要落到自己那一组，且数字 = 那组的卡片数
  const mismatched = [];
  info.cells.forEach((c) => {
    const g = info.groups.find((x) => x.label === c.label);
    if (!g) { mismatched.push(c.label + "(没这组)"); return; }
    if (c.href !== "#" + g.id) mismatched.push(c.label + "(href=" + c.href + " 应为 #" + g.id + ")");
    if (!c.isStatic && c.n !== g.cards) mismatched.push(c.label + "(格=" + c.n + " 卡片=" + g.cards + ")");
  });
  ok(mismatched.length === 0, "每格都指向同名分组，且格子里的数 = 那组的卡片数",
    mismatched.length ? mismatched.join(" · ") : info.cells.length + " 格全对");

  ok(info.total === info.cells.reduce((a, c) => a + c.n, 0), "左侧「已收口」总数 = 各格之和",
    info.total + " vs " + info.cells.reduce((a, c) => a + c.n, 0));

  // 三个具体要求
  ok(groupLabels.indexOf("已暂停") > -1, "有「已暂停」这一组", groupLabels.join(","));
  ok(groupLabels.indexOf("已知并接受") === -1 && groupLabels.indexOf("已解除") === -1,
    "「已知并接受」「已解除」都不再单列成组");
  const paused = info.groups.find((g) => g.label === "已暂停");
  ok(!!paused && /已解除|已知并接受|暂停/.test(paused.meta),
    "「已暂停」的说明里点出了它合并了哪些状态", paused ? paused.meta : "(没有这一组)");

  // 点一下「已暂停」的格子，确认只留那一组
  const filtered = await ev(`(function(){
    var board = document.querySelector('[data-view="closed"] .stage-board');
    var cell = Array.prototype.slice.call(board.querySelectorAll('.stage-board-cell'))
      .filter(function(c){ return (c.querySelector('span')||{}).textContent === '已暂停'; })[0];
    if (!cell || cell.tagName !== 'A') return { err: 'not-clickable' };
    cell.click();
    var main = document.querySelector('[data-view="closed"] .details-main');
    var kept = main.querySelector('.detail-group.is-stage-keep');
    return { keptId: kept ? kept.id : '', href: cell.getAttribute('href') };
  })()`);
  if (filtered.err) ok(false, "「已暂停」格子可点", filtered.err);
  else ok(filtered.keptId === filtered.href.slice(1),
    "点「已暂停」只留那一组", filtered.keptId || "(没筛出东西)");
}

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
