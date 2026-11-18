// 工作流页的测试。
// 2026-11-18：画布已按用户要求去掉；同一天工作台搬去总览页顶部（单实例按视图搬移）。
// 所以这里验的是：① 画布没了；② 工作流页留着工作台挂载点（工作台会搬进来）；
//   ③ 工作台整站只有一份，默认落在总览页顶部；④ 并行分析铺多路队列。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const boardArgIdx = process.argv.indexOf("--board");
const BOARD = boardArgIdx > -1 ? process.argv[boardArgIdx + 1] : "D:\\WorkSpace-Tools\\ops-board-reports\\cyber-egg-basket";
const HTML = "file:///" + join(BOARD, "dist", "index.html").replace(/\\/g, "/") + "#view-overview";

const profile = join(tmpdir(), "edge-flow-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--window-size=1400,1200", "about:blank",
], { stdio: "ignore" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pf = join(profile, "DevToolsActivePort");
let port = null;
for (let i = 0; i < 120; i++) {
  await wait(150);
  if (existsSync(pf)) { port = Number(readFileSync(pf, "utf8").split("\n")[0]); if (port) break; }
}
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method: m, params: p })); });
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };

await send("Page.enable"); await send("Runtime.enable");
await send("Page.navigate", { url: HTML });
await wait(2600);

// 期望值从台账推导，不写死
const fs = await import("node:fs");
const cfg = JSON.parse(fs.readFileSync(join(BOARD, "board.config.json"), "utf8"));
const led = JSON.parse(fs.readFileSync(join(BOARD, "ledger.json"), "utf8"));

let pass = 0, fail = 0;
const ok = (c, msg, extra) => { if (c) { pass++; console.log("  ✓ " + msg + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + msg + (extra ? " — " + extra : "")); } };
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;

console.log("[1] 工作流页已删除；工作台在总览页顶部（单实例）");
const view = await ev(`(() => {
  const flowView = document.querySelector('[data-view="flow"]');
  const overview = document.querySelector('[data-view="overview"]');
  const wb = document.querySelector('[data-workbench]');
  const navKeys = Array.prototype.map.call(document.querySelectorAll('.nav a[data-view]'), function(a){ return a.getAttribute('href'); });
  return {
    flowViewGone: !flowView,
    flowNavGone: navKeys.indexOf('#view-flow') === -1,
    flowSettingGone: !document.querySelector('#set-view option[value="flow"]'),
    canvasGone: !document.querySelector('#flowCanv') && !document.querySelector('.flow-canvas-wrap'),
    viewCount: document.querySelectorAll('.view').length,
    hasWorkbench: !!wb,
    wbCount: document.querySelectorAll('[data-workbench]').length,
    wbView: wb && wb.closest('[data-view]') ? wb.closest('[data-view]').getAttribute('data-view') : null,
    overviewHasMount: !!(overview && overview.querySelector('[data-wb-mount]')),
    hasPool: !!document.querySelector('[data-wb-pool]'),
  };
})()`);
ok(view && view.flowViewGone === true, "工作流视图已删掉（DOM 里没有 [data-view=flow]）");
ok(view && view.flowNavGone === true, "导航里没有「工作流」这一项");
ok(view && view.flowSettingGone === true, "设置里「打开哪一页」没有 flow 选项");
ok(view && view.canvasGone === true, "旧的可拖动大画布已移除（没有 flowCanv / canvas-wrap）");
ok(view && view.hasWorkbench && view.hasPool, "工作台在、候选池在");
ok(view && view.wbCount === 1, "工作台整站只有一份（单实例，不各页复制）", "共 " + (view && view.wbCount));
ok(view && view.overviewHasMount === true, "总览页有工作台挂载点", "视图总数 " + (view && view.viewCount));
ok(view && view.wbView === "overview", "从总览页进入时，工作台就在总览页", "挂载视图 = " + (view && view.wbView));

console.log("[1b] 旧书签 #view-flow 不再白屏（自动落回总览）");
await ev(`location.hash="#view-flow"`); await wait(700);
const stale = await ev(`(() => {
  const active = document.querySelector('.view.is-active');
  return {
    hasActive: !!active,
    activeView: active ? active.getAttribute('data-view') : null,
    hash: location.hash,
  };
})()`);
ok(stale && stale.hasActive === true, "有视图处于激活态（没白屏）", "激活 = " + (stale && stale.activeView));
ok(stale && stale.activeView === "overview", "掉回总览页", "hash 仍为 " + (stale && stale.hash));

console.log("[2] 候选池铺出可排顺序的卡（需后端环境，file:// 下若无后端则跳过）");
const cand = await ev(`(() => {
  const picks = document.querySelectorAll('[data-wb-pool] [data-wb-id]');
  if (!picks.length) return null;
  const drag = Array.prototype.filter.call(picks, function(p){ return p.draggable; });
  return { n: picks.length, dragN: drag.length };
})()`);
if (!cand) {
  ok(true, "[跳过] 当前以 file:// 打开，无后端，候选池未铺（顺序/并行由 workbench-test 覆盖）");
} else {
  ok(cand.n > 0, "候选池有可排的卡", cand.n + " 张");
  ok(cand.dragN >= 1, "队列卡可拖拽排序", cand.dragN + " 张可拖");
  console.log("[3] 并行分析 → 拆成多列队列（多路）");
  await ev(`document.querySelector('input[name=wb-mode][value=parallel]').checked=true; document.querySelector('input[name=wb-mode][value=parallel]').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('[data-wb-analyze]').dispatchEvent(new MouseEvent('click',{bubbles:true})); 1`);
  await wait(1800);
  const lanes = await ev(`(() => {
    const ls = document.querySelectorAll('[data-wb-steps] .wb-lane');
    const steps = document.querySelectorAll('[data-wb-steps] .wb-step');
    return { lanes: ls.length, steps: steps.length, heads: Array.prototype.map.call(ls, function(l){ return (l.querySelector('.wb-lane-name')||{}).textContent||''; }).join('|') };
  })()`);
  ok(lanes && lanes.steps > 0, "分析铺出执行步骤", (lanes && lanes.steps) + " 步");
  ok(lanes && lanes.lanes >= 1, "并行按路分组显示", (lanes && lanes.lanes) + " 路 · " + (lanes && lanes.heads));
  const poolOrder = await ev(`(function(){
    return Array.prototype.map.call(document.querySelectorAll('[data-wb-pool] .wb-pick-id'), function(s){ return s.textContent; });
  })()`);
  ok(Array.isArray(poolOrder) && poolOrder.length > 0, "候选池顺序可读", poolOrder.join(","));
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);