// 验证工作台单实例搬移：
//   ① 默认落在总览页顶部；② 全站只有一份；
//   ③ 切到没有挂载点的页（Skill 页）收进隐藏暂存区，不挂在别人页面上；
//   ④ 切回来状态不丢（同一 DOM 节点，不是重建）。
// 2026-11-18 起「工作流」页已删除，所以不再测「搬到工作流页」。
// 同时补一条：指向已删页面的旧 hash #view-flow 不会把工作台弄丢。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const HTML = "file:///D:/WorkSpace-Tools/ops-board-reports/cyber-egg-basket/dist/index.html";
const profile = join(tmpdir(), "edge-mount-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1400,1200", "about:blank"], { stdio: "ignore" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const pf = join(profile, "DevToolsActivePort");
let port = null;
for (let i = 0; i < 120; i++) { await wait(150); if (existsSync(pf)) { port = Number(readFileSync(pf, "utf8").split("\n")[0]); if (port) break; } }
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (m, p = {}) => new Promise((res) => { const i2 = ++id; pending.set(i2, res); ws.send(JSON.stringify({ id: i2, method: m, params: p })); });
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await send("Page.enable"); await send("Runtime.enable");
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log("  ✓ " + m + (extra ? " — " + extra : "")); } else { fail++; console.log("  ✗ " + m + (extra ? " — " + extra : "")); } };

await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2500);

console.log("[1] 总览页顶部有工作台");
ok(await ev(`!!document.querySelector('[data-view="overview"] [data-workbench]')`), "工作台在总览页内");
ok(await ev(`(function(){var w=document.querySelector('[data-workbench]');var m=document.querySelector('[data-view="overview"] [data-wb-mount]');return !!w&&!!m&&w.parentNode===m;})()`), "工作台挂在总览页的挂载点里");
ok(await ev(`document.querySelectorAll('[data-workbench]').length === 1`), "全站只有一份工作台（单实例）");

console.log("\n[2] 切到没有挂载点的页 → 收进隐藏暂存区");
await ev(`(function(){var w=document.querySelector('[data-workbench]');window.__wbNode=w;return 1;})()`);
await ev(`window.__wb.dragPool=["OPS-025","OPS-024"]; 1`);
await ev(`location.hash="#view-skills"`);
await wait(700);
ok(await ev(`(function(){var w=document.querySelector('[data-workbench]');return !!w && !!w.closest('#wb-park');})()`), "Skill 页里工作台收在 #wb-park（没挂在别人页面）");
ok(await ev(`!!document.querySelector('#wb-park') && document.querySelector('#wb-park').hidden`), "暂存区是隐藏的（用户看不见）");
ok(await ev(`document.querySelectorAll('[data-workbench]').length === 1`), "收起时也没丢节点（还在文档里，只是隐藏）");

console.log("\n[3] 切回总览页 → 工作台回来，状态没丢");
await ev(`location.hash="#view-overview"`);
await wait(700);
ok(await ev(`!!document.querySelector('[data-view="overview"] [data-workbench]')`), "工作台回到总览页");
ok(await ev(`(function(){var w=document.querySelector('[data-workbench]');return w===window.__wbNode;})()`), "仍是同一个 DOM 节点（状态没被重建）");
ok(await ev(`(window.__wb.dragPool||[]).length===2`), "切页前后队列状态保留", JSON.stringify(await ev(`window.__wb.dragPool`)));
ok(await ev(`document.querySelectorAll('[data-workbench]').length===1`), "始终只有一份工作台");

console.log("\n[4] 旧 hash #view-flow（页面已删）不影响工作台");
await ev(`location.hash="#view-flow"`);
await wait(700);
const stale = await ev(`(function(){
  var a = document.querySelector('.view.is-active');
  var w = document.querySelector('[data-workbench]');
  return {
    active: a ? a.getAttribute('data-view') : null,
    wbInDoc: !!w,
    wbView: w && w.closest('[data-view]') ? w.closest('[data-view]').getAttribute('data-view') : null,
    wbCount: document.querySelectorAll('[data-workbench]').length
  };
})()`);
ok(stale.active === 'overview', "落回总览页（没白屏）", "激活 = " + stale.active);
ok(stale.wbInDoc && stale.wbCount === 1, "工作台还在，且只有一份", "挂载视图 = " + stale.wbView);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
ws.close(); proc.kill();
process.exit(fail ? 1 : 0);