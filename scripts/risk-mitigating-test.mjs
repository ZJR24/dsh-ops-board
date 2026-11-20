// 风险车道「缓解中」已去掉（2026-11-20 用户定）。
//
// 用户原话：「风险页：缓解中有必要加上吗，没必要的话，我想去掉」
// 核实：两个看板 6 条风险全是 watching（观察中）或已收口，**mitigating 一次没用过**。
// 追问确认：两个看板都去掉；但代码里的兼容（OPEN_STATUSES / isOpenWbStatus）保留 ——
// 万一以后台账出现这个状态，仍按「未收口」处理，不会把还在缓解的风险错当已收口。
//
// 要验：
//   ① 配置里风险车道只剩 观察中 / 已解除 / 已知并接受 三个阶段；
//   ② 页面上没有「缓解中」这个分节、状态表也没有那一格；
//   ③ 状态表格子数 = 阶段数，且都还能落到正确的落点；
//   ④ **代码里的兼容保留**（flow.mjs 与 client.js 的未收口清单里仍有 mitigating）。
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

const cfg = JSON.parse(readFileSync(join(argBoard, "board.config.json"), "utf8"));
const riskLane = cfg.lanes.find((l) => l.key === "risk");
if (!riskLane) { console.error("这块板没有 risk 车道"); process.exit(1); }

const profile = join(tmpdir(), "edge-riskmit-" + Date.now());
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

// ── ① 配置层 ──
console.log("[1] 配置里风险车道不再有 mitigating");
const stageKeys = riskLane.stages.map((s) => s.key);
ok(stageKeys.indexOf("mitigating") === -1, "stages 里没有 mitigating", stageKeys.join(", "));
ok(stageKeys.join(",") === "watching,resolved,accepted",
  "只剩 观察中 / 已解除 / 已知并接受", stageKeys.join(","));
ok(!riskLane.statusLabels || !("mitigating" in riskLane.statusLabels),
  "statusLabels 里也没有 mitigating", JSON.stringify(riskLane.statusLabels || {}));

// ── ② 页面层 ──
await send("Page.navigate", { url: HTML + "#view-lane-risk" });
await wait(2200);
const page = JSON.parse(await ev(`JSON.stringify((function(){
  var view = document.querySelector('[data-view="lane-risk"]');
  if (!view) return { err: 'no-view' };
  var cells = Array.prototype.slice.call(view.querySelectorAll('.stage-board-cell')).map(function(c){
    return { label: (c.querySelector('span') || {}).textContent || '', href: c.getAttribute('href') || '', tag: c.tagName };
  });
  var groups = Array.prototype.slice.call(view.querySelectorAll('.detail-group')).map(function(g){
    return { id: g.id, label: ((g.querySelector('.section-head h2') || {}).textContent || '').trim() };
  });
  // 整页有没有「缓解中」这几个字（含正文，但排除注释——注释在 script 里，这里只查渲染出的 DOM）
  var viewText = view.textContent || '';
  return {
    cells: cells, groups: groups,
    hasMitigatingText: viewText.indexOf('缓解中') > -1,
    mitigatingCell: cells.filter(function(c){ return c.label === '缓解中'; }).length
  };
})())`));
if (page.err) {
  ok(false, "风险页在", page.err);
} else {
  console.log("    格子：" + page.cells.map((c) => c.label).join(" · "));
  console.log("    分节：" + page.groups.map((g) => g.label).join(" · "));
  ok(page.mitigatingCell === 0, "状态表里没有「缓解中」这一格");
  ok(page.hasMitigatingText === false, "风险页渲染出来的文字里没有「缓解中」");
  ok(page.groups.filter((g) => g.label === "缓解中").length === 0, "没有「缓解中」的分节");
  ok(page.cells.length === riskLane.stages.length,
    "状态表格子数 = 阶段数", page.cells.length + " 格 vs " + riskLane.stages.length + " 阶段");
  // 每个格子都要落得到（有收口分组的跳到收口页，没有的是静态）
  const badLand = await ev(`JSON.stringify(${JSON.stringify(page.cells)}.filter(function(c){
    return c.href && !document.getElementById(c.href.slice(1));
  }))`);
  ok(JSON.parse(badLand).length === 0, "每个格子的落点都存在（没有死链）", badLand);
}

// ── ③ 代码兼容保留（在源码里查，不是查渲染结果）──
console.log("\n[2] 代码里的兼容保留着（万一台账出现 mitigating 仍按未收口处理）");
const repo = "D:\\WorkSpace-Tools\\ops-board";
const flowSrc = readFileSync(join(repo, "scripts", "lib", "flow.mjs"), "utf8");
const clientSrc = readFileSync(join(repo, "scripts", "lib", "client.js"), "utf8");
const flowOpen = /const OPEN_STATUSES = new Set\(\[([\s\S]*?)\]\)/.exec(flowSrc);
ok(!!flowOpen && /"mitigating"/.test(flowOpen[1]), "flow.mjs 的 OPEN_STATUSES 仍含 mitigating",
  flowOpen ? "已含" : "找不到定义");
const clientOpen = /function isOpenWbStatus[\s\S]{0,600}?var open = \[([\s\S]*?)\]/.exec(clientSrc);
ok(!!clientOpen && /"mitigating"/.test(clientOpen[1]), "client.js 的 isOpenWbStatus 仍含 mitigating",
  clientOpen ? "已含" : "找不到定义");

ok(crashes.length === 0, "无未捕获异常", crashes.length ? String(crashes[0]).slice(0, 140) : "");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);
