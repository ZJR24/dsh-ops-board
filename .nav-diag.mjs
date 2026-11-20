// 精确诊断：点导航时到底发生了什么。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const HTML = "file:///D:/WorkSpace-Tools/ops-board-reports/cyber-egg-basket/dist/index.html";
const profile = join(tmpdir(), "edge-nav2-" + Date.now());
mkdirSync(profile, { recursive: true });
const proc = spawn(EDGE, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--hide-scrollbars", "--allow-file-access-from-files", "--remote-debugging-port=0",
  `--user-data-dir=${profile}`, "--window-size=1440,1200", "about:blank"], { stdio: "ignore" });
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

await send("Page.navigate", { url: HTML + "#view-overview" });
await wait(2400);

// 装一个监听器，记录 click 有没有被 preventDefault、hashchange 有没有发
await ev(`(function(){
  window.__log = [];
  document.addEventListener('click', function(e){
    var a = e.target && e.target.closest ? e.target.closest('a[href^="#"]') : null;
    if (!a) return;
    window.__log.push({ t: 'click', href: a.getAttribute('href'), defaultPrevented: e.defaultPrevented, cls: a.className });
  }, true);   // 捕获阶段，早于业务处理器
  window.addEventListener('hashchange', function(){
    window.__log.push({ t: 'hashchange', hash: location.hash });
  });
  return 1;
})()`);

// 场景：一直在总览页，逐个点导航，每次等足够久
for (const h of ["#view-lane-feature", "#view-lane-bug", "#view-overview", "#view-closed", "#view-overview"]) {
  await ev(`window.__log = [];`);
  const before = await ev(`JSON.stringify({ hash: location.hash, active: (document.querySelector('.view.is-active')||{}).getAttribute ? document.querySelector('.view.is-active').getAttribute('data-view') : null })`);
  await ev(`document.querySelector('.nav a[href="${h}"]').click(); 1`);
  await wait(400);
  const after = await ev(`JSON.stringify({ hash: location.hash, active: (document.querySelector('.view.is-active')||{}).getAttribute ? document.querySelector('.view.is-active').getAttribute('data-view') : null, log: window.__log })`);
  console.log("点 " + h + "\n  前: " + before + "\n  后: " + after);
}

// 关键场景：阶段筛选先切视图、hash 没跟上（我改之前的 bug 就是这里）
console.log("\n=== 阶段筛选后 hash 是否同步 ===");
await ev(`location.hash = "#view-lane-bug"`); await wait(400);
const filterRes = await ev(`(async function(){
  var cell = document.querySelector('[data-view="lane-bug"] .stage-board-cell');
  if (!cell) return { err: 'no-cell' };
  var hrefBefore = cell.getAttribute('href');
  cell.click();
  await new Promise(function(r){ setTimeout(r, 300); });
  var act = (document.querySelector('.view.is-active')||{}).getAttribute('data-view');
  return { cellHref: hrefBefore, active: act, hash: location.hash, synced: location.hash === '#view-' + act };
})()`);
console.log("  " + JSON.stringify(filterRes));

// 现在点「问题修复」导航 —— 修复前这里会「点了没反应」
console.log("\n=== 筛选后点导航（修复前会没反应） ===");
const afterFilterNav = await ev(`(async function(){
  var a = document.querySelector('.nav a[href="#view-lane-bug"]');
  a.click();
  await new Promise(function(r){ setTimeout(r, 400); });
  return { active: (document.querySelector('.view.is-active')||{}).getAttribute('data-view'), hash: location.hash };
})()`);
console.log("  " + JSON.stringify(afterFilterNav));

// 再测：从别的页用脚本把视图切走但 hash 不改（模拟任何不同步的情况），然后点导航
console.log("\n=== 人为制造不同步后点导航 ===");
const forced = await ev(`(async function(){
  // 切到 closed 页，但 hash 留在 lane-bug
  var views = document.querySelectorAll('.view');
  Array.prototype.forEach.call(views, function(v){ v.classList.remove('is-active'); });
  document.getElementById('view-closed').classList.add('is-active');
  var fake = { active: (document.querySelector('.view.is-active')||{}).getAttribute('data-view'), hash: location.hash };
  // 现在点 hash 与之相同的导航项
  document.querySelector('.nav a[href="#view-lane-bug"]').click();
  await new Promise(function(r){ setTimeout(r, 400); });
  return { before: fake, afterActive: (document.querySelector('.view.is-active')||{}).getAttribute('data-view'), afterHash: location.hash };
})()`);
console.log("  " + JSON.stringify(forced));

ws.close(); proc.kill();
