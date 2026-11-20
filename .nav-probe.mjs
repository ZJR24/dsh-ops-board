// 一次性探针：菜单栏点击切换页面的可靠性。
// 用户报「菜单栏切换页面有时候点击没有切换」。
// 做法：把每个导航项轮流点很多轮，每轮检查「激活视图 == 目标」，记录失败的那一次。
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EDGE = "C:/Program Files (x86)/Microsoft/EdgeCore/141.0.3537.99/msedge.exe";
const HTML = "file:///D:/WorkSpace-Tools/ops-board-reports/cyber-egg-basket/dist/index.html";
const profile = join(tmpdir(), "edge-nav-" + Date.now());
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

const hrefs = await ev(`JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.nav a[data-view]'), function(a){ return { href: a.getAttribute('href'), text: a.textContent.trim() }; }))`);
const items = JSON.parse(hrefs);
console.log("导航项：" + items.map((i) => i.text + "(" + i.href + ")").join(" · "));

const results = [];
let fails = 0;
// 依次点，只等很短时间（模拟真实手速），看有没有切不动的
for (let round = 0; round < 4; round++) {
  for (const it of items) {
    const r = await ev(`(function(){
      var a = document.querySelector('.nav a[href="${it.href}"]');
      if (!a) return { err: 'no-link' };
      a.click();
      var act = document.querySelector('.view.is-active');
      return { immediate: act ? act.getAttribute('data-view') : null };
    })()`);
    // 给 hashchange 一帧多一点的时间
    await wait(120);
    const settled = await ev(`(function(){
      var act = document.querySelector('.view.is-active');
      return { active: act ? act.getAttribute('data-view') : null, hash: location.hash };
    })()`);
    const want = it.href.slice(1).replace(/^view-/, "");
    const okNow = settled.active === want;
    if (!okNow) {
      fails++;
      results.push({ round, want, got: settled.active, hash: settled.hash, immediate: r.immediate });
    }
  }
}
console.log("\n点击 " + (4 * items.length) + " 次，失败 " + fails + " 次");
if (results.length) {
  console.log("失败样例：");
  for (const r of results.slice(0, 12)) console.log("  " + JSON.stringify(r));
}

// 再试「同一页里连点同一个导航项」+ 各种真实场景
const scenarios = [];
// ① 先切到有 stage 锚点的页，再点导航
await ev(`location.hash = "#stage-bug-todo"`);
await wait(400);
scenarios.push(await ev(`(async function(){
  var a = document.querySelector('.nav a[href="#view-overview"]');
  a.click();
  await new Promise(function(r){ setTimeout(r, 260); });
  var act = document.querySelector('.view.is-active');
  return { name: '从 stage 锚点点导航', active: act ? act.getAttribute('data-view') : null, hash: location.hash };
})()`));

// ② 在总览页点「问题修复」，再点回总览，反复三次
for (let i = 0; i < 3; i++) {
  await ev(`location.hash = "#view-overview"`); await wait(220);
  scenarios.push(await ev(`(async function(){
    document.querySelector('.nav a[href="#view-lane-bug"]').click();
    await new Promise(function(r){ setTimeout(r, 240); });
    var a1 = (document.querySelector('.view.is-active')||{}).getAttribute('data-view');
    document.querySelector('.nav a[href="#view-overview"]').click();
    await new Promise(function(r){ setTimeout(r, 240); });
    var a2 = (document.querySelector('.view.is-active')||{}).getAttribute('data-view');
    return { name: '往返 ${i}', bug: a1, overview: a2, hash: location.hash };
  })()`));
}

// ③ 快速连点（不等动画/不用 setTimeout 间隔）
scenarios.push(await ev(`(async function(){
  var seq = ['#view-lane-feature','#view-lane-bug','#view-lane-risk','#view-closed','#view-skills','#view-overview'];
  var seen = [];
  for (var i = 0; i < seq.length; i++) {
    document.querySelector('.nav a[href="' + seq[i] + '"]').click();
    seen.push((document.querySelector('.view.is-active')||{}).getAttribute('data-view'));
  }
  await new Promise(function(r){ setTimeout(r, 400); });
  var finalAct = (document.querySelector('.view.is-active')||{}).getAttribute('data-view');
  return { name: '六个连点', immediate: seen, finalActive: finalAct, hash: location.hash };
})()`));

console.log("\n场景：");
for (const s of scenarios) console.log("  " + JSON.stringify(s));

ws.close(); proc.kill();
